use serde::Serialize;
use std::path::Path;
use std::process::{Command, Output};

const MAX_GIT_OUTPUT: usize = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlSnapshot {
    pub branch: String,
    pub changes: Vec<String>,
    pub commits: Vec<CommitSummary>,
}

fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C"])
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Git is not installed or is not available on PATH".to_owned()
            } else {
                format!("Could not run Git: {error}")
            }
        })
}

fn checked_output(output: Output, operation: &str) -> Result<String, String> {
    if !output.status.success() {
        return Err(format!(
            "Git {operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > MAX_GIT_OUTPUT {
        return Err("Git output exceeds the 512 KiB limit".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git returned invalid text".into())
}

/// Show the workspace diff for the agent. Prefers the working tree against
/// HEAD so staged and unstaged edits both appear; falls back to the plain
/// working-tree diff before the first commit.
pub fn git_diff(workspace: &Path, path: Option<&str>) -> Result<String, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let root = git(&workspace, &["rev-parse", "--show-toplevel"])?;
    if !root.status.success() {
        return Err("Workspace is not a Git repository".into());
    }
    let mut args: Vec<String> = vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
    if git(&workspace, &["rev-parse", "--verify", "HEAD"])?.status.success() {
        args.push("HEAD".into());
    }
    if let Some(path) = path {
        let path = path.trim();
        if path.is_empty() || path.len() > 4096 {
            return Err("Diff path is invalid".into());
        }
        crate::workspace::resolve_path(&workspace, path)?;
        args.push("--".into());
        args.push(path.to_owned());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let text = checked_output(git(&workspace, &refs)?, "diff")?;
    if !text.trim().is_empty() {
        return Ok(text);
    }
    // `git diff` omits untracked files; list them so "no changes" is accurate.
    let status = checked_output(
        git(&workspace, &["status", "--porcelain", "--untracked-files=all"])?,
        "status",
    )?;
    Ok(if status.trim().is_empty() {
        "No changes.".into()
    } else {
        format!("No tracked diff. Staged or untracked entries:\n{status}")
    })
}

pub fn get_source_control(workspace: &Path) -> Result<SourceControlSnapshot, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let root_output = git(&workspace, &["rev-parse", "--show-toplevel"])?;
    if !root_output.status.success() {
        return Err("Workspace is not a Git repository".into());
    }
    if root_output.stdout.len() > 4096 {
        return Err("Git repository path is invalid".into());
    }
    let git_root = String::from_utf8_lossy(&root_output.stdout)
        .trim()
        .to_owned();
    let git_root = Path::new(&git_root)
        .canonicalize()
        .map_err(|error| format!("Could not resolve Git repository root: {error}"))?;
    if git_root != workspace {
        return Err("Git repository root must match the selected workspace root".into());
    }

    let branch_output = git(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = if branch_output.status.success() {
        let value = checked_output(branch_output, "branch lookup")?;
        if value.trim().is_empty() {
            return Err("Git returned an empty branch name".into());
        }
        value.trim().to_owned()
    } else if branch_output.status.code() == Some(1) {
        "Detached HEAD".into()
    } else {
        return Err(format!(
            "Git branch lookup failed: {}",
            String::from_utf8_lossy(&branch_output.stderr).trim()
        ));
    };
    let status = checked_output(
        git(
            &workspace,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        )?,
        "status",
    )?;
    let changes = status.lines().map(str::to_owned).collect();
    let log = checked_output(
        git(
            &workspace,
            &["log", "-n", "50", "--format=%h%x1f%s%x1f%an%x1f%at"],
        )?,
        "history",
    )?;
    let mut commits = Vec::new();
    for line in log.lines().filter(|line| !line.is_empty()) {
        let mut fields = line.splitn(4, '\u{1f}');
        let (Some(hash), Some(subject), Some(author), Some(timestamp)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err("Git returned malformed commit history".into());
        };
        let timestamp = timestamp
            .parse()
            .map_err(|_| "Git returned an invalid commit date")?;
        commits.push(CommitSummary {
            hash: hash.into(),
            subject: subject.into(),
            author: author.into(),
            timestamp,
        });
    }
    Ok(SourceControlSnapshot {
        branch,
        changes,
        commits,
    })
}

/// What the app knows about this workspace's Git identity and credentials.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    pub branch: String,
    pub remote: Option<String>,
    /// "ready", "missing", "none" (no remote) or "unknown".
    pub credential: String,
    pub detail: String,
}

/// Git's own wording is accurate and useless to most people. Map the failures
/// that actually happen into the fix the user needs.
pub fn explain_git_error(stderr: &str) -> String {
    let text = stderr.to_lowercase();
    if text.contains("permission denied (publickey)") || text.contains("host key verification failed")
    {
        return "GitHub rejected the SSH key. Add this machine's public key at \
                https://github.com/settings/keys, then try again."
            .into();
    }
    if text.contains("could not read username")
        || text.contains("could not read password")
        || text.contains("terminal prompts disabled")
        || text.contains("authentication failed")
        || text.contains("invalid username or password")
    {
        return "No credentials for this remote. Install Git Credential Manager, run \
                `gh auth login`, or switch the remote to an SSH URL."
            .into();
    }
    if text.contains("repository not found") || text.contains("does not appear to be a git repository")
    {
        return "The remote was not found, or this account cannot see it. Check the remote URL.".into();
    }
    if text.contains("nothing to commit") || text.contains("no changes added to commit") {
        return "Nothing to commit — the working tree is clean.".into();
    }
    if text.contains("no upstream branch") || text.contains("has no upstream branch") {
        return "This branch has no upstream yet; push it to create one.".into();
    }
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return "Git failed without reporting a reason.".into();
    }
    trimmed.chars().take(300).collect()
}

/// `git commit` writes its "nothing to commit" explanation to stdout, not stderr,
/// so a failure must be read from both streams or the reason is lost.
fn output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn first_line(output: &[u8]) -> String {
    String::from_utf8_lossy(output)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn config_value(root: &Path, key: &str) -> String {
    match git(root, &["config", "--get", key]) {
        Ok(output) if output.status.success() => first_line(&output.stdout),
        _ => String::new(),
    }
}

/// Commit every change in the workspace. Staging is explicit (`add -A`) so new
/// files are included, which is what a one-click commit implies.
pub fn commit(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Enter a commit message first.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let added = git(&root, &["add", "-A"])?;
    if !added.status.success() {
        return Err(explain_git_error(&output_text(&added)));
    }
    let committed = git(&root, &["commit", "-m", message])?;
    if !committed.status.success() {
        return Err(explain_git_error(&output_text(&committed)));
    }
    let head = git(&root, &["log", "-1", "--format=%h %s"])?;
    Ok(first_line(&head.stdout))
}

/// Push the current branch, creating an upstream on the first push.
pub fn push(root: &Path) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
    let args: &[&str] = if upstream.status.success() {
        &["push"]
    } else {
        &["push", "-u", "origin", "HEAD"]
    };
    let pushed = git(&root, args)?;
    if !pushed.status.success() {
        return Err(explain_git_error(&output_text(&pushed)));
    }
    Ok(first_line(&pushed.stderr))
}

/// Report the identity git will commit as, plus whether this machine can talk
/// to the remote. The credential check is a network round trip, so it is kept
/// to one `ls-remote` and treated as advisory.
pub fn identity(root: &Path) -> Result<GitIdentity, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let name = config_value(&root, "user.name");
    let email = config_value(&root, "user.email");
    let branch = first_line(&git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?.stdout);
    let remote = match git(&root, &["remote", "get-url", "origin"]) {
        Ok(output) if output.status.success() => Some(first_line(&output.stdout)),
        _ => None,
    };
    let Some(url) = remote.clone() else {
        return Ok(GitIdentity {
            name,
            email,
            branch,
            remote: None,
            credential: "none".into(),
            detail: "This repository has no origin remote, so there is nothing to push to.".into(),
        });
    };
    let probe = git(&root, &["ls-remote", "origin"])?;
    let (credential, detail) = if probe.status.success() {
        ("ready".to_owned(), format!("Push ready — {url}"))
    } else {
        let text = output_text(&probe);
        let explained = explain_git_error(&text);
        let lower = text.to_lowercase();
        let missing = lower.contains("permission denied")
            || lower.contains("could not read")
            || lower.contains("authentication failed")
            || lower.contains("terminal prompts disabled");
        (
            if missing { "missing" } else { "unknown" }.to_owned(),
            explained,
        )
    };
    Ok(GitIdentity {
        name,
        email,
        branch,
        remote,
        credential,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_output(root: &std::path::Path, args: &[&str]) -> String {
        let result = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&result.stdout).into_owned()
    }

    fn git(root: &std::path::Path, args: &[&str]) {
        let result = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn git_diff_shows_tracked_changes_and_falls_back_to_untracked_entries() {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]);
        git(root.path(), &["config", "user.name", "Test User"]);
        git(root.path(), &["config", "user.email", "test@example.invalid"]);
        fs::write(root.path().join("tracked.txt"), "first\n").unwrap();
        git(root.path(), &["add", "tracked.txt"]);
        git(
            root.path(),
            &["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial"],
        );
        fs::write(root.path().join("tracked.txt"), "changed\n").unwrap();
        let diff = git_diff(root.path(), None).unwrap();
        assert!(diff.contains("-first") && diff.contains("+changed"), "{diff}");
        assert!(git_diff(root.path(), Some("tracked.txt"))
            .unwrap()
            .contains("+changed"));

        fs::write(root.path().join("tracked.txt"), "first\n").unwrap();
        fs::write(root.path().join("untracked.txt"), "new\n").unwrap();
        let fallback = git_diff(root.path(), None).unwrap();
        assert!(fallback.contains("untracked.txt"), "{fallback}");
    }

    #[test]
    fn git_diff_rejects_non_repositories_and_escaping_paths() {
        let root = tempfile::tempdir().unwrap();
        assert!(git_diff(root.path(), None)
            .unwrap_err()
            .contains("not a Git repository"));
        git(root.path(), &["init", "--quiet"]);
        assert!(git_diff(root.path(), Some("../outside.txt")).is_err());
    }

    #[test]
    fn reports_local_changes_and_recent_commits_without_mutating_repository() {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]);
        git(root.path(), &["config", "user.name", "Test User"]);
        git(
            root.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(root.path().join("tracked.txt"), "first\n").unwrap();
        git(root.path(), &["add", "tracked.txt"]);
        git(
            root.path(),
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Initial commit",
            ],
        );
        let before = std::fs::read(root.path().join(".git/HEAD")).unwrap();
        fs::write(root.path().join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.path().join("new file.txt"), "new\n").unwrap();

        let snapshot = get_source_control(root.path()).unwrap();
        assert!(!snapshot.branch.is_empty());
        assert!(snapshot
            .changes
            .iter()
            .any(|change| change.contains("tracked.txt")));
        assert!(snapshot
            .changes
            .iter()
            .any(|change| change.contains("new file.txt")));
        assert_eq!(snapshot.commits.len(), 1);
        assert_eq!(snapshot.commits[0].subject, "Initial commit");
        assert_eq!(
            std::fs::read(root.path().join(".git/HEAD")).unwrap(),
            before
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "--quiet"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
    }

    #[test]
    fn commits_and_pushes_to_a_local_remote() {
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "--bare", "--quiet"]);
        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        fs::write(work.path().join("a.txt"), "one\n").unwrap();
        let head = commit(work.path(), "First commit").unwrap();
        assert!(head.contains("First commit"), "{head}");
        git(
            work.path(),
            &["remote", "add", "origin", origin.path().to_str().unwrap()],
        );
        push(work.path()).unwrap();
        let log = git_output(origin.path(), &["log", "--all", "--oneline"]);
        assert!(log.contains("First commit"), "{log}");
    }

    #[test]
    fn commit_requires_a_message_and_changes() {
        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        assert!(commit(work.path(), "   ").unwrap_err().contains("commit message"));
        fs::write(work.path().join("a.txt"), "one\n").unwrap();
        commit(work.path(), "First commit").unwrap();
        // Nothing staged the second time: the error must say so in plain words.
        let second = commit(work.path(), "Second commit").unwrap_err();
        assert!(second.contains("Nothing to commit"), "got: {second}");
    }

    #[test]
    fn identity_reports_missing_remote_then_ready() {
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "--bare", "--quiet"]);
        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        fs::write(work.path().join("a.txt"), "one\n").unwrap();
        commit(work.path(), "First commit").unwrap();

        let before = identity(work.path()).unwrap();
        assert_eq!(before.credential, "none");
        assert_eq!(before.email, "test@example.com");
        assert!(before.remote.is_none());

        git(
            work.path(),
            &["remote", "add", "origin", origin.path().to_str().unwrap()],
        );
        let after = identity(work.path()).unwrap();
        assert_eq!(after.credential, "ready", "{}", after.detail);
        assert!(after.detail.contains("Push ready"));
    }

    #[test]
    fn git_errors_are_translated_into_fixes() {
        assert!(explain_git_error("git@github.com: Permission denied (publickey).").contains("github.com/settings/keys"));
        assert!(explain_git_error("fatal: could not read Username for 'https://github.com'").contains("Git Credential Manager"));
        assert!(explain_git_error("fatal: repository 'x' not found").contains("not found"));
        assert!(explain_git_error("nothing to commit, working tree clean").contains("Nothing to commit"));
        assert!(explain_git_error("something odd").contains("something odd"));
        assert!(explain_git_error("").contains("without reporting a reason"));
    }

    #[test]
    fn rejects_repository_root_outside_selected_workspace() {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]);
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let error = get_source_control(&nested).unwrap_err();
        assert!(error.contains("repository root"));
    }

    #[test]
    fn reports_non_repository_workspace() {
        let root = tempfile::tempdir().unwrap();
        assert!(get_source_control(root.path())
            .unwrap_err()
            .contains("not a Git repository"));
    }
}

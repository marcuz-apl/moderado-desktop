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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

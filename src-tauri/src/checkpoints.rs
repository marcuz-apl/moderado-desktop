use crate::sessions::{checkpoint_time, new_id, CheckpointRecord};
use crate::workspace;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone)]
pub struct CheckpointStore {
    root: PathBuf,
}

#[derive(Clone, Debug)]
struct Blob {
    mode: String,
    hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChange {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPreview {
    pub checkpoint_id: String,
    pub current_tree: String,
    pub changes: Vec<CheckpointChange>,
}

impl CheckpointStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create checkpoint folder: {error}"))?;
        Ok(Self { root })
    }

    pub fn create(
        &self,
        workspace: &Path,
        session_id: &str,
        path: &str,
    ) -> Result<CheckpointRecord, String> {
        workspace::resolve_path(workspace, path)?;
        self.create_snapshot(workspace, session_id, path, &[path.to_owned()])
    }

    pub fn create_before_run(
        &self,
        workspace: &Path,
        session_id: &str,
    ) -> Result<CheckpointRecord, String> {
        self.create_snapshot(workspace, session_id, "Scheduled run", &[])
    }

    fn create_snapshot(
        &self,
        workspace: &Path,
        session_id: &str,
        path: &str,
        force_paths: &[String],
    ) -> Result<CheckpointRecord, String> {
        let repo = self.repo(workspace, session_id)?;
        let id = new_id();
        let tree = self.snapshot_tree(&repo, workspace, force_paths)?;
        let commit = git(
            &repo,
            workspace,
            None,
            &["commit-tree", &tree, "-m", "Moderado checkpoint"],
        )?;
        let commit = String::from_utf8(commit)
            .map_err(|_| "Invalid Git commit ID")?
            .trim()
            .to_owned();
        let git_ref = format!("refs/moderado/{session_id}/{id}");
        git(&repo, workspace, None, &["update-ref", &git_ref, &commit])?;
        Ok(CheckpointRecord {
            id,
            session_id: session_id.to_owned(),
            git_ref,
            path: path.to_owned(),
            created_at: checkpoint_time(),
        })
    }

    pub fn preview(
        &self,
        workspace: &Path,
        checkpoint: &CheckpointRecord,
    ) -> Result<CheckpointPreview, String> {
        let repo = self.repo(workspace, &checkpoint.session_id)?;
        let target = self.tree(&repo, workspace, &checkpoint.git_ref)?;
        let mut force_paths: Vec<String> = target.keys().cloned().collect();
        force_paths.push(checkpoint.path.clone());
        let current_tree = self.snapshot_tree(&repo, workspace, &force_paths)?;
        let current = self.tree(&repo, workspace, &current_tree)?;
        let paths: BTreeSet<_> = current.keys().chain(target.keys()).cloned().collect();
        let mut changes = Vec::new();
        let mut preview_bytes = 0usize;
        for path in paths {
            if same_blob(current.get(&path), target.get(&path)) {
                continue;
            }
            if changes.len() >= 200 {
                return Err("Checkpoint changes exceed 200 files".into());
            }
            let before = self.preview_content(&repo, workspace, current.get(&path))?;
            let after = self.preview_content(&repo, workspace, target.get(&path))?;
            preview_bytes += before.len() + after.len();
            if preview_bytes > 1024 * 1024 {
                return Err("Checkpoint preview exceeds 1 MiB".into());
            }
            changes.push(CheckpointChange {
                path,
                before,
                after,
            });
        }
        Ok(CheckpointPreview {
            checkpoint_id: checkpoint.id.clone(),
            current_tree,
            changes,
        })
    }

    pub fn restore(
        &self,
        workspace: &Path,
        checkpoint: &CheckpointRecord,
        expected_tree: &str,
    ) -> Result<usize, String> {
        let preview = self.preview(workspace, checkpoint)?;
        if preview.current_tree != expected_tree {
            return Err("Workspace changed after the restore preview; review it again".into());
        }
        let repo = self.repo(workspace, &checkpoint.session_id)?;
        let target = self.tree(&repo, workspace, &checkpoint.git_ref)?;
        let current = self.tree(&repo, workspace, &preview.current_tree)?;
        let mut writes = Vec::new();
        for change in &preview.changes {
            workspace::resolve_path(workspace, &change.path)?;
            let desired = self.restore_content(&repo, workspace, target.get(&change.path))?;
            let previous = self.restore_content(&repo, workspace, current.get(&change.path))?;
            writes.push((change.path.clone(), desired, previous));
        }
        for index in 0..writes.len() {
            let (path, desired, _) = &writes[index];
            if let Err(error) = apply_file(workspace, path, desired) {
                let mut rollback_error = None;
                for (path, _, previous) in writes[..=index].iter().rev() {
                    if let Err(rollback) = apply_file(workspace, path, previous) {
                        rollback_error = Some(rollback);
                    }
                }
                return Err(match rollback_error {
                    Some(rollback) => format!("Restore failed: {error}; workspace may be partially restored because rollback failed: {rollback}"),
                    None => format!("Restore failed and previous files were recovered: {error}"),
                });
            }
        }
        Ok(preview.changes.len())
    }

    fn restore_content(
        &self,
        repo: &Path,
        workspace: &Path,
        blob: Option<&Blob>,
    ) -> Result<Option<(Vec<u8>, String)>, String> {
        blob.map(|blob| {
            let bytes = self.blob_content(repo, workspace, blob)?;
            if bytes.len() > 32 * 1024 * 1024 {
                return Err("Checkpoint file exceeds 32 MiB limit".into());
            }
            Ok((bytes, blob.mode.clone()))
        })
        .transpose()
    }

    fn preview_content(
        &self,
        repo: &Path,
        workspace: &Path,
        blob: Option<&Blob>,
    ) -> Result<String, String> {
        let Some(blob) = blob else {
            return Ok(String::new());
        };
        let bytes = self.blob_content(repo, workspace, blob)?;
        Ok(String::from_utf8(bytes)
            .unwrap_or_else(|error| format!("<binary file: {} bytes>", error.as_bytes().len())))
    }

    fn blob_content(&self, repo: &Path, workspace: &Path, blob: &Blob) -> Result<Vec<u8>, String> {
        if blob.mode != "100644" && blob.mode != "100755" {
            return Err(
                "Checkpoint contains an unsupported symlink or Git submodule change".into(),
            );
        }
        git(repo, workspace, None, &["cat-file", "blob", &blob.hash])
    }

    fn tree(
        &self,
        repo: &Path,
        workspace: &Path,
        reference: &str,
    ) -> Result<BTreeMap<String, Blob>, String> {
        let output = git(repo, workspace, None, &["ls-tree", "-r", "-z", reference])?;
        let mut files = BTreeMap::new();
        for entry in output
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let tab = entry
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or("Invalid Git tree entry")?;
            let (meta, path) = (&entry[..tab], &entry[tab + 1..]);
            let meta = std::str::from_utf8(meta).map_err(|_| "Invalid Git tree entry")?;
            let mut fields = meta.split_whitespace();
            let mode = fields.next().ok_or("Invalid Git tree mode")?.to_owned();
            let kind = fields.next().ok_or("Invalid Git tree type")?;
            let hash = fields.next().ok_or("Invalid Git tree hash")?.to_owned();
            if kind != "blob" {
                return Err("Checkpoint contains a Git submodule".into());
            }
            let path =
                String::from_utf8(path.to_vec()).map_err(|_| "Checkpoint path is not UTF-8")?;
            if path.starts_with(".git/") || path == ".git" {
                return Err("Checkpoint contains Git metadata".into());
            }
            files.insert(path, Blob { mode, hash });
            if files.len() > 5000 {
                return Err("Checkpoint exceeds 5,000 files".into());
            }
        }
        Ok(files)
    }

    fn snapshot_tree(
        &self,
        repo: &Path,
        workspace: &Path,
        force_paths: &[String],
    ) -> Result<String, String> {
        let index = self.root.join(format!("index-{}", new_id()));
        let result = (|| {
            let output = git(
                repo,
                workspace,
                Some(&index),
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
            )?;
            let mut paths = BTreeSet::new();
            for path in output
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                paths.insert(
                    String::from_utf8(path.to_vec()).map_err(|_| "Checkpoint path is not UTF-8")?,
                );
            }
            paths.extend(force_paths.iter().cloned());
            if paths.len() > 5000 {
                return Err("Checkpoint exceeds 5,000 files".into());
            }
            let mut entries = Vec::new();
            for path in paths {
                workspace::resolve_path(workspace, &path)?;
                let full = workspace.join(&path);
                let metadata = match fs::symlink_metadata(&full) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!("Could not inspect checkpoint file: {error}"))
                    }
                };
                let (mode, bytes) = if metadata.file_type().is_symlink() {
                    (
                        "120000",
                        fs::read_link(&full)
                            .map_err(|error| error.to_string())?
                            .to_string_lossy()
                            .as_bytes()
                            .to_vec(),
                    )
                } else if metadata.is_file() {
                    if metadata.len() > 32 * 1024 * 1024 {
                        return Err("Checkpoint file exceeds 32 MiB limit".into());
                    }
                    let mode = file_mode(&metadata);
                    (
                        mode,
                        fs::read(&full)
                            .map_err(|error| format!("Could not read checkpoint file: {error}"))?,
                    )
                } else {
                    return Err(format!("Unsupported checkpoint path: {path}"));
                };
                let hash = git_input(
                    repo,
                    workspace,
                    None,
                    &["hash-object", "-w", "--stdin"],
                    &bytes,
                )?;
                let hash = String::from_utf8(hash).map_err(|_| "Invalid Git blob ID")?;
                entries.extend_from_slice(format!("{mode} {}\t{path}\0", hash.trim()).as_bytes());
            }
            git_input(
                repo,
                workspace,
                Some(&index),
                &["update-index", "-z", "--index-info"],
                &entries,
            )?;
            let tree = git(repo, workspace, Some(&index), &["write-tree"])?;
            String::from_utf8(tree)
                .map(|text| text.trim().to_owned())
                .map_err(|_| "Invalid Git tree ID".into())
        })();
        let _ = fs::remove_file(index);
        result
    }

    fn repo(&self, workspace: &Path, session_id: &str) -> Result<PathBuf, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("Workspace unavailable: {error}"))?;
        if let Ok(top) = git_command()
            .arg("-C")
            .arg(&workspace)
            .args(["rev-parse", "--show-toplevel"])
            .output()
        {
            if top.status.success() {
                let top =
                    String::from_utf8(top.stdout).map_err(|_| "Invalid Git workspace path")?;
                if Path::new(top.trim()).canonicalize().ok().as_deref() == Some(workspace.as_path())
                {
                    let dir = git_command()
                        .arg("-C")
                        .arg(&workspace)
                        .args(["rev-parse", "--absolute-git-dir"])
                        .output()
                        .map_err(|error| format!("Git unavailable: {error}"))?;
                    if dir.status.success() {
                        return Ok(PathBuf::from(
                            String::from_utf8(dir.stdout)
                                .map_err(|_| "Invalid Git directory")?
                                .trim(),
                        ));
                    }
                }
            }
        }
        let repo = self.root.join(format!("{session_id}.git"));
        if !repo.exists() {
            let output = git_command()
                .args(["init", "--bare"])
                .arg(&repo)
                .output()
                .map_err(|error| format!("Git unavailable: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Could not initialize checkpoint Git store: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
        Ok(repo)
    }
}

fn same_blob(left: Option<&Blob>, right: Option<&Blob>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            #[cfg(unix)]
            {
                left.hash == right.hash && left.mode == right.mode
            }
            #[cfg(not(unix))]
            {
                left.hash == right.hash
            }
        }
        _ => false,
    }
}

fn apply_file(
    workspace: &Path,
    path: &str,
    content: &Option<(Vec<u8>, String)>,
) -> Result<(), String> {
    match content {
        Some((bytes, mode)) => {
            workspace::write_bytes(workspace, path, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let permissions =
                    fs::Permissions::from_mode(if mode == "100755" { 0o755 } else { 0o644 });
                fs::set_permissions(workspace.join(path), permissions)
                    .map_err(|error| error.to_string())?;
            }
            #[cfg(not(unix))]
            let _ = mode;
            Ok(())
        }
        None => workspace::remove_file(workspace, path),
    }
}

fn git(
    repo: &Path,
    workspace: &Path,
    index: Option<&Path>,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    git_input(repo, workspace, index, args, &[])
}

fn git_command() -> Command {
    #[cfg(windows)]
    let mut command = Command::new("git");
    #[cfg(not(windows))]
    let command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
}

fn git_input(
    repo: &Path,
    workspace: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: &[u8],
) -> Result<Vec<u8>, String> {
    let mut command = git_command();
    command
        .arg(format!("--git-dir={}", repo.display()))
        .arg(format!("--work-tree={}", workspace.display()))
        .args(["-c", "core.fsmonitor=false"])
        .arg("-c")
        .arg(format!(
            "core.hooksPath={}",
            repo.join("moderado-disabled-hooks").display()
        ));
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    command
        .env("GIT_AUTHOR_NAME", "Moderado Desktop")
        .env("GIT_AUTHOR_EMAIL", "checkpoint@moderado.local")
        .env("GIT_COMMITTER_NAME", "Moderado Desktop")
        .env("GIT_COMMITTER_EMAIL", "checkpoint@moderado.local")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", repo.join("moderado-no-global-config"))
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Git unavailable: {error}"))?;
    child
        .stdin
        .take()
        .ok_or("Git input unavailable")?
        .write_all(input)
        .map_err(|error| format!("Could not send Git input: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Git failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Checkpoint Git command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> &'static str {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o111 != 0 {
        "100755"
    } else {
        "100644"
    }
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> &'static str {
    "100644"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_restores_modified_and_new_files_without_touching_user_index() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        fs::create_dir(&workspace).unwrap();
        let status = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(status.success());
        fs::write(workspace.join("a.txt"), "before").unwrap();
        let store = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let checkpoint = store.create(&workspace, "session-1", "a.txt").unwrap();
        let original_status = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["status", "--porcelain"])
            .output()
            .unwrap()
            .stdout;
        fs::write(workspace.join("a.txt"), "after").unwrap();
        fs::write(workspace.join("new.txt"), "new").unwrap();
        let preview = store.preview(&workspace, &checkpoint).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(
            preview
                .changes
                .iter()
                .find(|item| item.path == "a.txt")
                .unwrap()
                .after,
            "before"
        );
        assert_eq!(
            store
                .restore(&workspace, &checkpoint, &preview.current_tree)
                .unwrap(),
            2
        );
        assert_eq!(
            fs::read_to_string(workspace.join("a.txt")).unwrap(),
            "before"
        );
        assert!(!workspace.join("new.txt").exists());
        let final_status = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["status", "--porcelain"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(original_status, final_status);
    }

    #[test]
    fn shadow_git_checkpoint_rejects_stale_restore_preview() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("a.txt"), "before").unwrap();
        let store = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let checkpoint = store.create(&workspace, "session-2", "a.txt").unwrap();
        fs::write(workspace.join("a.txt"), "after").unwrap();
        let preview = store.preview(&workspace, &checkpoint).unwrap();
        fs::write(workspace.join("a.txt"), "external").unwrap();
        assert!(store
            .restore(&workspace, &checkpoint, &preview.current_tree)
            .unwrap_err()
            .contains("changed after"));
        assert_eq!(
            fs::read_to_string(workspace.join("a.txt")).unwrap(),
            "external"
        );
    }

    #[test]
    fn checkpoints_do_not_execute_repository_clean_filters() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        fs::create_dir(&workspace).unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args([
                "config",
                "filter.unsafe.clean",
                "moderado-filter-must-not-run"
            ])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["config", "filter.unsafe.required", "true"])
            .status()
            .unwrap()
            .success());
        fs::write(workspace.join(".gitattributes"), "*.txt filter=unsafe\n").unwrap();
        fs::write(workspace.join("file.txt"), "before").unwrap();
        let store = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let checkpoint = store.create(&workspace, "session", "file.txt").unwrap();
        fs::write(workspace.join("file.txt"), "after").unwrap();
        let preview = store.preview(&workspace, &checkpoint).unwrap();
        assert_eq!(
            preview
                .changes
                .iter()
                .find(|change| change.path == "file.txt")
                .unwrap()
                .after,
            "before"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_recovers_executable_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        fs::create_dir(&workspace).unwrap();
        let path = workspace.join("script.sh");
        fs::write(&path, "echo ready\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let store = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let checkpoint = store.create(&workspace, "session", "script.sh").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let preview = store.preview(&workspace, &checkpoint).unwrap();
        assert_eq!(preview.changes.len(), 1);
        store
            .restore(&workspace, &checkpoint, &preview.current_tree)
            .unwrap();
        assert_ne!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
    }
}

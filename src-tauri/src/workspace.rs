use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_PROJECT_ENTRIES: usize = 1000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn resolve_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let input = Path::new(relative);
    if input
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Path is outside workspace".into());
    }
    let mut result = root.clone();
    for part in input.components() {
        if let Component::Normal(name) = part {
            result.push(name);
            match fs::symlink_metadata(&result) {
                Ok(_) => {
                    result = result.canonicalize().map_err(|error| error.to_string())?;
                    if !result.starts_with(&root) {
                        return Err("Path is outside workspace".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(result)
}

pub fn read_text(root: &Path, relative: &str) -> Result<String, String> {
    resolve_path(root, relative)?;
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    let size = dir
        .metadata(relative)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("File exceeds 256 KiB limit".into());
    }
    dir.read_to_string(relative)
        .map_err(|error| error.to_string())
}

pub fn read_optional(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let path = resolve_path(root, relative)?;
    match fs::symlink_metadata(path) {
        Ok(_) => read_text(root, relative).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn write_text(root: &Path, relative: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("Content exceeds 256 KiB limit".into());
    }
    write_bytes(root, relative, content.as_bytes())
}

pub fn write_bytes(root: &Path, relative: &str, content: &[u8]) -> Result<(), String> {
    if content.len() > 32 * 1024 * 1024 {
        return Err("Checkpoint file exceeds 32 MiB limit".into());
    }
    resolve_path(root, relative)?;
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    let parent = Path::new(relative).parent().ok_or("Invalid file path")?;
    dir.create_dir_all(parent)
        .map_err(|error| error.to_string())?;
    resolve_path(root, relative)?;
    dir.write(relative, content)
        .map_err(|error| error.to_string())
}

pub fn remove_file(root: &Path, relative: &str) -> Result<(), String> {
    resolve_path(root, relative)?;
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    dir.remove_file(relative).map_err(|error| error.to_string())
}

pub fn list_files(root: &Path, relative: &str) -> Result<Vec<String>, String> {
    resolve_path(root, relative)?;
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in dir
        .read_dir(relative)
        .map_err(|error| error.to_string())?
        .take(201)
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let mut name = entry.file_name().to_string_lossy().into_owned();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            name.push('/');
        }
        entries.push(name);
    }
    if entries.len() > 200 {
        return Err("Directory exceeds 200 entry limit".into());
    }
    entries.sort();
    Ok(entries)
}

pub fn list_project_entries(root: &Path, relative: &str) -> Result<Vec<ProjectEntry>, String> {
    resolve_path(root, relative)?;
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    let relative_path = if relative.is_empty() { "." } else { relative };
    let mut entries = Vec::new();
    for entry in dir
        .read_dir(relative_path)
        .map_err(|error| error.to_string())?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_symlink() || name == ".git" {
            continue;
        }
        if entries.len() == MAX_PROJECT_ENTRIES {
            return Err(format!(
                "Folder exceeds {MAX_PROJECT_ENTRIES} visible entries"
            ));
        }
        let path = Path::new(relative_path)
            .join(&name)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(ProjectEntry {
            name,
            path,
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

pub fn search_files(root: &Path, query: &str) -> Result<Vec<String>, String> {
    if query.is_empty() || query.len() > 200 {
        return Err("Search query must be 1–200 characters".into());
    }
    let dir =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| error.to_string())?;
    let mut queue = vec![(PathBuf::from("."), 0usize)];
    let mut results = Vec::new();
    let mut visited = 0usize;
    let mut skipped = 0usize;
    while let Some((folder, depth)) = queue.pop() {
        for entry in dir.read_dir(&folder).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            let relative = folder.join(name);
            if kind.is_dir() {
                if depth < 8 {
                    queue.push((relative, depth + 1));
                }
            } else if kind.is_file() {
                visited += 1;
                if visited > 1000 {
                    return Err("Search stopped after 1,000 files".into());
                }
                match read_text(root, &relative.to_string_lossy()) {
                    Ok(text) => {
                        for (line, content) in text.lines().enumerate() {
                            if content.contains(query) {
                                let snippet: String = content.chars().take(200).collect();
                                let display = relative.strip_prefix(".").unwrap_or(&relative);
                                results.push(format!(
                                    "{}:{}:{}",
                                    display.to_string_lossy().replace('\\', "/"),
                                    line + 1,
                                    snippet
                                ));
                                if results.len() == 100 {
                                    return Ok(results);
                                }
                            }
                        }
                    }
                    Err(_) => skipped += 1,
                }
            }
        }
    }
    if skipped > 0 {
        results.push(format!("Skipped {skipped} unreadable or oversized files"));
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn project_entries_sort_folders_first_and_hide_git_metadata() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("z-folder")).unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join("a.txt"), "text").unwrap();
        let entries = list_project_entries(root.path(), ".").unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["z-folder", "a.txt"]
        );
        assert!(entries[0].is_dir);
        assert!(!entries[1].is_dir);
    }

    #[test]
    fn project_entries_reject_parent_escape() {
        let root = tempfile::tempdir().unwrap();
        assert!(list_project_entries(root.path(), "../").is_err());
    }

    #[test]
    fn rejects_parent_escape() {
        let root = tempfile::tempdir().unwrap();
        assert!(resolve_path(root.path(), "../outside.txt").is_err());
    }

    #[test]
    fn rejects_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        assert!(resolve_path(root.path(), root.path().join("file.txt").to_str().unwrap()).is_err());
    }

    #[test]
    fn reads_and_writes_inside_workspace() {
        let root = tempfile::tempdir().unwrap();
        write_text(root.path(), "src/a.txt", "hello").unwrap();
        assert_eq!(read_text(root.path(), "src/a.txt").unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(resolve_path(root.path(), "link/file.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink_write_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("new.txt");
        symlink(&target, root.path().join("link.txt")).unwrap();
        assert!(write_text(root.path(), "link.txt", "escaped").is_err());
        assert!(!target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::windows::fs::symlink_dir;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        if symlink_dir(outside.path(), root.path().join("link")).is_ok() {
            assert!(resolve_path(root.path(), "link/file.txt").is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_dangling_symlink_write_escape() {
        use std::os::windows::fs::symlink_file;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("new.txt");
        if symlink_file(&target, root.path().join("link.txt")).is_ok() {
            assert!(write_text(root.path(), "link.txt", "escaped").is_err());
            assert!(!target.exists());
        }
    }

    #[test]
    fn lists_entries() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "a").unwrap();
        assert!(list_files(root.path(), ".")
            .unwrap()
            .contains(&"a.txt".to_string()));
    }

    #[test]
    fn searches_nested_text_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(
            root.path().join("src").join("a.txt"),
            "one\nneedle here\nthree",
        )
        .unwrap();
        let matches = search_files(root.path(), "needle").unwrap();
        assert_eq!(matches, vec!["src/a.txt:2:needle here"]);
    }
}

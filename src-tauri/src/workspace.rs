use cap_std::ambient_authority;
use cap_std::fs::Dir;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_FILE_BYTES: u64 = 256 * 1024;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
}

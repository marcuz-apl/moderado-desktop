//! Launch the workspace in an external editor, terminal, or file browser.
//!
//! Programs are fixed candidates; the webview never supplies one. The workspace
//! is passed as an argv entry, never interpolated into a shell command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub new_console: bool,
}

impl Launch {
    fn new(program: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self { program: program.into(), args, current_dir: None, new_console: false }
    }

    // Only the terminal fallbacks that cannot take a working-directory flag use
    // this; macOS launches Terminal.app by path, so the method is absent there.
    #[cfg(any(windows, all(unix, not(target_os = "macos"))))]
    fn in_dir(mut self, root: &Path) -> Self {
        self.current_dir = Some(root.to_path_buf());
        self
    }
}

fn path_arg(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

pub fn editor_candidates(root: &Path) -> Vec<Launch> {
    let arg = path_arg(root);
    let mut candidates = Vec::new();
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs");
        candidates.push(Launch::new(base.join("Microsoft VS Code").join("Code.exe"), vec![arg.clone()]));
        candidates.push(Launch::new(base.join("Microsoft VS Code Insiders").join("Code - Insiders.exe"), vec![arg.clone()]));
        candidates.push(Launch::new(base.join("cursor").join("Cursor.exe"), vec![arg.clone()]));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(Launch::new("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", vec![arg.clone()]));
        candidates.push(Launch::new("/Applications/Cursor.app/Contents/Resources/app/bin/cursor", vec![arg.clone()]));
    }
    candidates.extend([
        Launch::new("code", vec![arg.clone()]),
        Launch::new("code-insiders", vec![arg.clone()]),
        Launch::new("cursor", vec![arg]),
    ]);
    candidates
}

pub fn terminal_candidates(root: &Path) -> Vec<Launch> {
    let arg = path_arg(root);
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        candidates.push(Launch::new("wt.exe", vec!["-d".into(), arg]));
        let mut fallback = Launch::new("cmd.exe", Vec::new()).in_dir(root);
        fallback.new_console = true;
        candidates.push(fallback);
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(Launch::new("open", vec!["-a".into(), "Terminal".into(), arg]));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(Launch::new("x-terminal-emulator", Vec::new()).in_dir(root));
        candidates.push(Launch::new("gnome-terminal", vec!["--working-directory".into(), arg.clone()]));
        candidates.push(Launch::new("konsole", vec!["--workdir".into(), arg.clone()]));
        candidates.push(Launch::new("xterm", Vec::new()).in_dir(root));
    }
    candidates
}

pub fn file_browser_candidates(root: &Path) -> Vec<Launch> {
    let arg = path_arg(root);
    #[cfg(windows)]
    {
        vec![Launch::new("explorer.exe", vec![arg])]
    }
    #[cfg(target_os = "macos")]
    {
        vec![Launch::new("open", vec![arg])]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            Launch::new("xdg-open", vec![arg.clone()]),
            Launch::new("gio", vec!["open".into(), arg]),
        ]
    }
}

fn launch(candidates: &[Launch], missing: &str) -> Result<(), String> {
    for candidate in candidates {
        let mut command = Command::new(&candidate.program);
        command
            .args(&candidate.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(directory) = &candidate.current_dir {
            command.current_dir(directory);
        }
        #[cfg(windows)]
        if candidate.new_console {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0000_0010);
        }
        match command.spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not start {}: {error}", candidate.program.display())),
        }
    }
    Err(missing.into())
}

pub fn open_editor(root: &Path) -> Result<(), String> {
    launch(
        &editor_candidates(root),
        "No supported editor was found. Install VS Code or Cursor, or add its command to PATH.",
    )
}

pub fn open_terminal(root: &Path) -> Result<(), String> {
    launch(
        &terminal_candidates(root),
        "No supported terminal was found. Use the embedded terminal panel instead.",
    )
}

pub fn open_file_browser(root: &Path) -> Result<(), String> {
    launch(
        &file_browser_candidates(root),
        "No supported file browser was found.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_candidates_always_pass_the_workspace_as_one_argument() {
        let root = Path::new("workspace");
        let candidates = editor_candidates(root);
        assert!(!candidates.is_empty());
        for candidate in &candidates {
            assert_eq!(candidate.args, vec!["workspace".to_string()]);
            assert!(candidate.current_dir.is_none());
        }
    }

    #[test]
    fn terminal_candidates_are_platform_appropriate() {
        let root = Path::new("workspace");
        let candidates = terminal_candidates(root);
        assert!(!candidates.is_empty());
        #[cfg(windows)]
        {
            assert_eq!(candidates[0].program, PathBuf::from("wt.exe"));
            assert_eq!(candidates[0].args, vec!["-d".to_string(), "workspace".to_string()]);
            assert!(candidates[1].new_console);
            assert_eq!(candidates[1].current_dir.as_deref(), Some(root));
        }
        #[cfg(target_os = "macos")]
        assert_eq!(candidates[0].program, PathBuf::from("open"));
    }

    #[test]
    fn file_browser_candidates_open_the_platform_file_manager() {
        let root = Path::new("workspace");
        let candidates = file_browser_candidates(root);
        assert!(!candidates.is_empty());
        #[cfg(windows)]
        assert_eq!(candidates[0].program, PathBuf::from("explorer.exe"));
        #[cfg(target_os = "macos")]
        assert_eq!(candidates[0].program, PathBuf::from("open"));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(candidates[0].program, PathBuf::from("xdg-open"));
        for candidate in &candidates {
            let mut expected = vec!["workspace".to_string()];
            if candidate.program == Path::new("gio") {
                expected.insert(0, "open".to_string());
            }
            assert_eq!(candidate.args, expected);
            assert!(candidate.current_dir.is_none());
        }
    }
}

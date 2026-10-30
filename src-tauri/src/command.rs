use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_ARGUMENTS: usize = 256;
const MAX_ARG_BYTES: usize = 32 * 1024;
const MAX_WORKSPACE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_WORKSPACE_FILES: usize = 100_000;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub output_truncated: bool,
    pub changed_files: Vec<String>,
}

pub fn validate_request(workspace: &Path, request: &CommandRequest) -> Result<(PathBuf, PathBuf, Duration), String> {
    if request.program.is_empty() || request.program.len() > 4096 || request.program.contains('\0') {
        return Err("A valid program path is required".into());
    }
    if request.args.len() > MAX_ARGUMENTS || request.args.iter().any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0')) {
        return Err("Command arguments exceed the limit".into());
    }
    let root = workspace.canonicalize().map_err(|error| format!("Workspace unavailable: {error}"))?;
    let relative = if request.working_directory.is_empty() { Path::new(".") } else { Path::new(&request.working_directory) };
    if relative.is_absolute() || relative.components().any(|part| matches!(part, Component::ParentDir | Component::Prefix(_))) {
        return Err("Working directory must stay inside the workspace".into());
    }
    let cwd = root.join(relative).canonicalize().map_err(|error| format!("Working directory unavailable: {error}"))?;
    if !cwd.starts_with(&root) || !cwd.is_dir() { return Err("Working directory must stay inside the workspace".into()); }
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if !(100..=MAX_TIMEOUT_MS).contains(&timeout_ms) { return Err("Command timeout must be between 100 ms and 10 minutes".into()); }
    Ok((root, cwd, Duration::from_millis(timeout_ms)))
}

/// Runs a command in a disposable AppContainer workspace copy. Only the
/// resulting workspace diff is copied back, after checking the source did not
/// change while the command was running. Dropping this future kills the job.
pub async fn execute_sandboxed(workspace: &Path, request: CommandRequest) -> Result<CommandResult, String> {
    let (root, cwd, timeout) = validate_request(workspace, &request)?;
    #[cfg(windows)]
    {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_guard = CancelGuard(cancelled.clone());
        let task = tokio::task::spawn_blocking(move || windows::execute(root, cwd, request, timeout, cancelled));
        let result = task.await.map_err(|error| format!("Command worker failed: {error}"))?;
        drop(cancellation_guard);
        result
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        {
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancellation_guard = CancelGuard(cancelled.clone());
            let task = tokio::task::spawn_blocking(move || linux::execute(root, cwd, request, timeout, cancelled));
            let result = task.await.map_err(|error| format!("Command worker failed: {error}"))?;
            drop(cancellation_guard);
            result
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            let _ = (root, cwd, request, timeout);
            Err("Command execution is not available on this Linux architecture".into())
        }
    }
    #[cfg(all(not(windows), not(target_os = "linux")))]
    {
        let _ = (root, cwd, request, timeout);
        Err("Sandboxed command execution is not available on this platform yet".into())
    }
}

struct CancelGuard(Arc<AtomicBool>);
impl Drop for CancelGuard { fn drop(&mut self) { self.0.store(true, Ordering::Release); } }

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::FromRawHandle;
    use std::thread;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
    use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{CreateProcessW, GetExitCodeProcess, InitializeProcThreadAttributeList, UpdateProcThreadAttribute, DeleteProcThreadAttributeList, ResumeThread, TerminateProcess, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW};
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};

    struct Handle(HANDLE);
    impl Drop for Handle { fn drop(&mut self) { unsafe { if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { CloseHandle(self.0); } } } }

    struct ProcessOutput { stdout: String, stderr: String, exit_code: Option<i32>, timed_out: bool, output_truncated: bool, cancelled: bool }

    pub fn execute(root: PathBuf, cwd: PathBuf, request: CommandRequest, timeout: Duration, cancelled: Arc<AtomicBool>) -> Result<CommandResult, String> {
        let profile_name = format!("ModeradoCommand-{}", crate::sessions::new_id());
        let (profile_sid, profile) = get_sid_and_folder(&profile_name)?;
        unsafe { LocalFree(profile_sid); }
        let sandbox_root = profile.join(crate::sessions::new_id());
        fs::create_dir(&sandbox_root).map_err(|error| format!("Could not create command workspace: {error}"))?;
        let operation = (|| {
            let baseline = copy_workspace(&root, &sandbox_root)?;
            let relative_cwd = cwd.strip_prefix(&root).map_err(|_| "Working directory escapes the workspace")?;
            let sandbox_cwd = sandbox_root.join(relative_cwd);
            let program = resolve_program(&request.program)?;
            let output = run_appcontainer(&profile_name, &program, &request.args, &sandbox_cwd, &sandbox_root, timeout, &cancelled)?;
            if output.cancelled { return Err("Command was cancelled".into()); }
            let after = snapshot(&sandbox_root)?;
            apply_workspace_diff(&root, &sandbox_root, &baseline, &after)?;
            Ok(CommandResult { stdout: output.stdout, stderr: output.stderr, exit_code: output.exit_code, timed_out: output.timed_out, cancelled: false, output_truncated: output.output_truncated, changed_files: diff_names(&baseline, &after) })
        })();
        let _ = fs::remove_dir_all(&sandbox_root);
        let profile_w = wide(OsStr::new(&profile_name));
        unsafe { windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(profile_w.as_ptr()); }
        operation
    }

    fn wide(value: &OsStr) -> Vec<u16> { value.encode_wide().chain(std::iter::once(0)).collect() }

    unsafe fn nul_len(ptr: *const u16) -> usize { let mut len = 0; while *ptr.add(len) != 0 { len += 1; } len }

    fn copy_workspace(root: &Path, destination: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
        let mut result = BTreeMap::new();
        copy_dir(root, root, destination, &mut result, &mut 0u64)?;
        Ok(result)
    }

    fn copy_dir(root: &Path, source: &Path, target: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>, bytes: &mut u64) -> Result<(), String> {
        for entry in fs::read_dir(source).map_err(|error| format!("Could not scan workspace: {error}"))? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() { return Err(format!("Command sandbox does not support symbolic links: {}", entry.path().display())); }
            let target_path = target.join(entry.file_name());
            if metadata.is_dir() {
                fs::create_dir(&target_path).map_err(|error| error.to_string())?;
                copy_dir(root, &entry.path(), &target_path, files, bytes)?;
            } else if metadata.is_file() {
                *bytes = bytes.saturating_add(metadata.len());
                if *bytes > MAX_WORKSPACE_BYTES || files.len() >= MAX_WORKSPACE_FILES { return Err("Workspace exceeds the command sandbox size limit".into()); }
                let content = fs::read(entry.path()).map_err(|error| error.to_string())?;
                fs::write(&target_path, &content).map_err(|error| error.to_string())?;
                files.insert(entry.path().strip_prefix(root).map_err(|_| "Workspace entry escaped root")?.to_owned(), content);
            } else { return Err(format!("Unsupported workspace item: {}", entry.path().display())); }
        }
        Ok(())
    }

    fn snapshot(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
        let mut map = BTreeMap::new();
        snapshot_dir(root, root, &mut map, &mut 0u64)?;
        Ok(map)
    }

    fn snapshot_dir(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>, bytes: &mut u64) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if meta.file_type().is_symlink() { return Err(format!("Command created a symbolic link: {}", entry.path().display())); }
            if meta.is_dir() { snapshot_dir(root, &entry.path(), files, bytes)?; }
            else if meta.is_file() {
                *bytes = bytes.saturating_add(meta.len());
                if *bytes > MAX_WORKSPACE_BYTES || files.len() >= MAX_WORKSPACE_FILES { return Err("Command output exceeds the sandbox size limit".into()); }
                files.insert(entry.path().strip_prefix(root).map_err(|_| "Command output escaped its workspace")?.to_owned(), fs::read(entry.path()).map_err(|error| error.to_string())?);
            }
        }
        Ok(())
    }

    fn apply_workspace_diff(root: &Path, sandbox: &Path, before: &BTreeMap<PathBuf, Vec<u8>>, after: &BTreeMap<PathBuf, Vec<u8>>) -> Result<(), String> {
        for (relative, original) in before {
            let destination = safe_destination(root, relative)?;
            if fs::read(&destination).map_err(|error| format!("Workspace changed during command: {error}"))? != *original { return Err(format!("Workspace file changed while command was running: {}", relative.display())); }
        }
        for relative in after.keys().filter(|path| !before.contains_key(*path)) {
            if safe_destination(root, relative)?.exists() { return Err(format!("Workspace file appeared while command was running: {}", relative.display())); }
        }
        for relative in before.keys().filter(|path| !after.contains_key(*path)) {
            fs::remove_file(safe_destination(root, relative)?).map_err(|error| error.to_string())?;
        }
        for (relative, content) in after {
            if before.get(relative) == Some(content) { continue; }
            let destination = safe_destination(root, relative)?;
            let parent = destination.parent().ok_or("Invalid command output path")?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            fs::copy(sandbox.join(relative), &destination).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn safe_destination(root: &Path, relative: &Path) -> Result<PathBuf, String> {
        if relative.is_absolute() || relative.components().any(|component| !matches!(component, Component::Normal(_))) { return Err("Invalid path in command result".into()); }
        let destination = root.join(relative);
        let mut parent = destination.parent().ok_or("Invalid command result path")?.to_path_buf();
        while parent != root {
            if parent.exists() && fs::symlink_metadata(&parent).map_err(|error| error.to_string())?.file_type().is_symlink() { return Err("Workspace path became a symbolic link during command".into()); }
            if !parent.starts_with(root) { return Err("Command result escaped the workspace".into()); }
            parent.pop();
        }
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("Workspace file became a symbolic link during command".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
        Ok(destination)
    }

    fn diff_names(before: &BTreeMap<PathBuf, Vec<u8>>, after: &BTreeMap<PathBuf, Vec<u8>>) -> Vec<String> {
        let mut names: Vec<String> = before.iter().filter(|(path, bytes)| after.get(*path) != Some(*bytes)).map(|(path, _)| path.to_string_lossy().into_owned()).collect();
        names.extend(after.keys().filter(|path| !before.contains_key(*path)).map(|path| path.to_string_lossy().into_owned()));
        names.sort(); names
    }

    fn resolve_program(program: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(program);
        if candidate.is_absolute() { return candidate.canonicalize().map_err(|error| format!("Command program unavailable: {error}")); }
        let path = std::env::var_os("PATH").ok_or("Could not resolve command program")?;
        for directory in std::env::split_paths(&path) {
            for suffix in ["", ".exe", ".cmd", ".bat"] {
                let candidate = directory.join(format!("{program}{suffix}"));
                if candidate.is_file() { return candidate.canonicalize().map_err(|error| error.to_string()); }
            }
        }
        Err("Command program was not found in PATH".into())
    }

    fn quote_arg(argument: &str) -> String {
        if !argument.is_empty() && !argument.chars().any(|c| c == ' ' || c == '\t' || c == '"') { return argument.to_owned(); }
        let mut out = String::from("\""); let mut slashes = 0;
        for ch in argument.chars() {
            if ch == '\\' { slashes += 1; }
            else if ch == '"' { out.push_str(&"\\".repeat(slashes * 2 + 1)); out.push('"'); slashes = 0; }
            else { out.push_str(&"\\".repeat(slashes)); slashes = 0; out.push(ch); }
        }
        out.push_str(&"\\".repeat(slashes * 2)); out.push('"'); out
    }

    fn read_pipe(handle: HANDLE) -> thread::JoinHandle<(Vec<u8>, bool)> {
        let raw_handle = handle as usize;
        thread::spawn(move || {
            let handle = raw_handle as HANDLE;
            let mut file = unsafe { File::from_raw_handle(handle) };
            let mut output = Vec::with_capacity(8192); let mut buffer = [0u8; 8192]; let mut truncated = false;
            loop { match file.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(count) => { let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len()); output.extend_from_slice(&buffer[..count.min(remaining)]); truncated |= count > remaining; } } }
            (output, truncated)
        })
    }

    fn run_appcontainer(profile_name: &str, program: &Path, args: &[String], cwd: &Path, sandbox: &Path, timeout: Duration, cancelled: &AtomicBool) -> Result<ProcessOutput, String> {
        let (sid, _folder) = get_sid_and_folder(profile_name)?;
        let local_app_data = sandbox.join(".moderado-appdata-local");
        let roaming_app_data = sandbox.join(".moderado-appdata-roaming");
        fs::create_dir_all(&local_app_data).map_err(|error| error.to_string())?;
        fs::create_dir_all(&roaming_app_data).map_err(|error| error.to_string())?;
        let security = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
        let (mut out_read, mut out_write) = (std::ptr::null_mut(), std::ptr::null_mut());
        let (mut err_read, mut err_write) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut out_read, &mut out_write, &security, 0) } == 0 || unsafe { CreatePipe(&mut err_read, &mut err_write, &security, 0) } == 0 { return Err(format!("Could not create command output pipes: {}", unsafe { GetLastError() })); }
        if unsafe { SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0) } == 0 || unsafe { SetHandleInformation(err_read, HANDLE_FLAG_INHERIT, 0) } == 0 { return Err("Could not secure command output pipes".into()); }
        let nul = wide(OsStr::new("NUL"));
        let stdin = unsafe { CreateFileW(nul.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, std::ptr::null_mut()) };
        if stdin.is_null() || stdin == INVALID_HANDLE_VALUE { return Err("Could not open the sandboxed command input".into()); }
        let _stdin = Handle(stdin);

        let mut attributes_size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut attributes_size); }
        if attributes_size == 0 { return Err("Windows does not support the required AppContainer process attributes".into()); }
        let mut attribute_storage = vec![0usize; attributes_size.div_ceil(std::mem::size_of::<usize>())];
        let attributes = attribute_storage.as_mut_ptr().cast::<core::ffi::c_void>();
        if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut attributes_size) } == 0 { return Err("Could not initialize AppContainer process attributes".into()); }
        struct AttrGuard(*mut core::ffi::c_void); impl Drop for AttrGuard { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.0); } } }
        let _attr_guard = AttrGuard(attributes);
        let mut capabilities = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
        if unsafe { UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(), std::mem::size_of::<SECURITY_CAPABILITIES>(), std::ptr::null_mut(), std::ptr::null()) } == 0 { return Err("Could not configure AppContainer isolation".into()); }
        let mut inherited_handles = [stdin, out_write, err_write];
        if unsafe { UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, inherited_handles.as_mut_ptr().cast(), std::mem::size_of_val(&inherited_handles), std::ptr::null_mut(), std::ptr::null()) } == 0 { return Err("Could not restrict inherited command handles".into()); }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin;
        startup.StartupInfo.hStdOutput = out_write;
        startup.StartupInfo.hStdError = err_write;
        startup.lpAttributeList = attributes;
        let mut process = PROCESS_INFORMATION::default();
        let program_w = wide(program.as_os_str());
        let cwd_w = wide(cwd.as_os_str());
        let mut command = std::iter::once(program.to_string_lossy().into_owned()).chain(args.iter().cloned()).map(|arg| quote_arg(&arg)).collect::<Vec<_>>().join(" ").encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
        let child_env = sanitized_environment(sandbox)?;
        if unsafe { CreateProcessW(program_w.as_ptr(), command.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, child_env.as_ptr().cast(), cwd_w.as_ptr(), (&startup as *const STARTUPINFOEXW).cast(), &mut process) } == 0 { return Err(format!("Sandboxed command could not start: Windows error {}", unsafe { GetLastError() })); }
        let _process = Handle(process.hProcess); let _thread = Handle(process.hThread);
        unsafe { CloseHandle(out_write); CloseHandle(err_write); }
        let stdout_thread = read_pipe(out_read); let stderr_thread = read_pipe(err_read);
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() { unsafe { TerminateProcess(process.hProcess, 1); } return Err("Could not create a child-process job for command containment".into()); }
        let _job = Handle(job);
        let mut job_limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&job_limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&job_limits) as u32) } == 0 || unsafe { AssignProcessToJobObject(job, process.hProcess) } == 0 { unsafe { TerminateProcess(process.hProcess, 1); } return Err("Could not contain child processes in a Windows job".into()); }
        if unsafe { ResumeThread(process.hThread) } == u32::MAX { unsafe { TerminateProcess(process.hProcess, 1); } return Err("Could not start the sandboxed command".into()); }
        let deadline = Instant::now() + timeout; let (mut timed_out, mut was_cancelled) = (false, false);
        loop {
            if cancelled.load(Ordering::Acquire) { was_cancelled = true; unsafe { TerminateProcess(process.hProcess, 1); } break; }
            if Instant::now() >= deadline { timed_out = true; unsafe { TerminateProcess(process.hProcess, 1); } break; }
            match unsafe { WaitForSingleObject(process.hProcess, 40) } { WAIT_OBJECT_0 => break, WAIT_TIMEOUT => {}, _ => { unsafe { TerminateProcess(process.hProcess, 1); } return Err("Could not wait for sandboxed command".into()); } }
        }
        unsafe { WaitForSingleObject(process.hProcess, 5000); }
        let mut exit_code = 1u32; let _ = unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) };
        drop(_job);
        let (out, trunc_out) = stdout_thread.join().map_err(|_| "Could not read command output")?;
        let (err, trunc_err) = stderr_thread.join().map_err(|_| "Could not read command errors")?;
        let stdout = String::from_utf8_lossy(&out).into_owned(); let stderr = String::from_utf8_lossy(&err).into_owned();
        unsafe { LocalFree(sid); }
        Ok(ProcessOutput { stdout, stderr, exit_code: Some(exit_code as i32), timed_out, output_truncated: trunc_out || trunc_err, cancelled: was_cancelled })
    }

    fn get_sid_and_folder(profile_name: &str) -> Result<(windows_sys::Win32::Security::PSID, PathBuf), String> {
        let profile = wide(OsStr::new(profile_name)); let label = wide(OsStr::new("Moderado Desktop Command Sandbox"));
        let mut sid = std::ptr::null_mut(); let result = unsafe { CreateAppContainerProfile(profile.as_ptr(), label.as_ptr(), label.as_ptr(), std::ptr::null(), 0, &mut sid) };
        if result < 0 { let derived = unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) }; if derived < 0 { return Err(format!("Could not initialize AppContainer (HRESULT 0x{:08x})", result as u32)); } }
        let mut sid_string = std::ptr::null_mut(); if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 { unsafe { LocalFree(sid); } return Err("Could not resolve AppContainer storage".into()); }
        let mut path_ptr = std::ptr::null_mut(); let hr = unsafe { GetAppContainerFolderPath(sid_string, &mut path_ptr) };
        unsafe { LocalFree(sid_string.cast()); }
        if hr < 0 || path_ptr.is_null() { unsafe { LocalFree(sid); } return Err(format!("Could not resolve AppContainer storage (HRESULT 0x{:08x})", hr as u32)); }
        let path = unsafe { std::ffi::OsString::from_wide(std::slice::from_raw_parts(path_ptr, nul_len(path_ptr))) };
        unsafe { LocalFree(path_ptr.cast()); }
        let path = PathBuf::from(path); fs::create_dir_all(&path).map_err(|error| error.to_string())?; Ok((sid, path))
    }

    fn sanitized_environment(temp: &Path) -> Result<Vec<u16>, String> {
        let block = unsafe { GetEnvironmentStringsW() };
        if block.is_null() { return Err("Could not read the process environment".into()); }
        let mut entries = Vec::<String>::new();
        let mut offset = 0usize;
        unsafe {
            loop {
                let start = block.add(offset);
                if *start == 0 { break; }
                let mut len = 0usize;
                while *start.add(len) != 0 { len += 1; }
                let entry = std::ffi::OsString::from_wide(std::slice::from_raw_parts(start, len)).to_string_lossy().into_owned();
                offset += len + 1;
                let name = if let Some(stripped) = entry.strip_prefix('=') { stripped.split_once('=').map(|(key, _)| key).unwrap_or("") } else { entry.split_once('=').map(|(key, _)| key).unwrap_or("") };
                let lowered = name.to_ascii_lowercase();
                if ["secret", "token", "password", "credential", "apikey", "api_key", "auth", "private_key", "privatekey"].iter().any(|part| lowered.contains(part)) { continue; }
                if lowered == "temp" { entries.push(format!("TEMP={}", temp.display())); }
                else if lowered == "tmp" { entries.push(format!("TMP={}", temp.display())); }
                else if lowered == "userprofile" || lowered == "home" { entries.push(format!("{}={}", name, temp.display())); }
                else if lowered == "localappdata" { entries.push(format!("LOCALAPPDATA={}", temp.join(".moderado-appdata-local").display())); }
                else if lowered == "appdata" { entries.push(format!("APPDATA={}", temp.join(".moderado-appdata-roaming").display())); }
                else { entries.push(entry); }
            }
            FreeEnvironmentStringsW(block);
        }
        entries.sort_by_key(|entry| entry.to_ascii_lowercase());
        let mut environment = entries.iter().flat_map(|entry| wide(OsStr::new(entry))).collect::<Vec<_>>();
        environment.push(0);
        Ok(environment)
    }

}

/// Linux backend: runs the command in the workspace with a Landlock ruleset
/// that allows read/execute on system paths and read/write on the workspace
/// and a private temp folder, denying everything else. It fails closed when
/// Landlock is unavailable rather than running the command unsandboxed.
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::CString;
    use std::fs;
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::thread;

    const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

    const ACCESS_EXECUTE: u64 = 1 << 0;
    const ACCESS_WRITE_FILE: u64 = 1 << 1;
    const ACCESS_READ_FILE: u64 = 1 << 2;
    const ACCESS_READ_DIR: u64 = 1 << 3;
    const ACCESS_REMOVE_DIR: u64 = 1 << 4;
    const ACCESS_REMOVE_FILE: u64 = 1 << 5;
    const ACCESS_MAKE_CHAR: u64 = 1 << 6;
    const ACCESS_MAKE_DIR: u64 = 1 << 7;
    const ACCESS_MAKE_REG: u64 = 1 << 8;
    const ACCESS_MAKE_SOCK: u64 = 1 << 9;
    const ACCESS_MAKE_FIFO: u64 = 1 << 10;
    const ACCESS_MAKE_BLOCK: u64 = 1 << 11;
    const ACCESS_MAKE_SYM: u64 = 1 << 12;
    const ACCESS_REFER: u64 = 1 << 13;
    const ACCESS_TRUNCATE: u64 = 1 << 14;
    const ACCESS_IOCTL_DEV: u64 = 1 << 15;

    struct ProcessOutput {
        stdout: String,
        stderr: String,
        exit_code: Option<i32>,
        timed_out: bool,
        output_truncated: bool,
        cancelled: bool,
    }

    pub fn execute(
        root: PathBuf,
        cwd: PathBuf,
        request: CommandRequest,
        timeout: Duration,
        cancelled: Arc<AtomicBool>,
    ) -> Result<CommandResult, String> {
        let temp = std::env::temp_dir().join(format!("moderado-command-{}", crate::sessions::new_id()));
        fs::create_dir_all(&temp).map_err(|error| format!("Could not create command temp folder: {error}"))?;
        let operation = (|| {
            let before = snapshot(&root)?;
            let output = run_landlocked(&root, &temp, &cwd, &request, timeout, &cancelled)?;
            let after = snapshot(&root)?;
            Ok(CommandResult {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code,
                timed_out: output.timed_out,
                cancelled: output.cancelled,
                output_truncated: output.output_truncated,
                changed_files: diff_names(&before, &after),
            })
        })();
        let _ = fs::remove_dir_all(&temp);
        operation
    }

    fn run_landlocked(
        root: &Path,
        temp: &Path,
        cwd: &Path,
        request: &CommandRequest,
        timeout: Duration,
        cancelled: &AtomicBool,
    ) -> Result<ProcessOutput, String> {
        let abi = abi_version();
        if abi == 0 {
            return Err("Landlock is unavailable on this kernel; refusing to run an unsandboxed command".into());
        }
        let handled = full_access(abi);
        let rules = landlock_rules(root, temp, handled)?;
        let program = resolve_program(&request.program)?;
        let mut command = std::process::Command::new(&program);
        command
            .args(&request.args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.env_clear();
        for (key, value) in std::env::vars_os() {
            let name = key.to_string_lossy().to_ascii_lowercase();
            if ["secret", "token", "password", "credential", "apikey", "api_key", "auth", "private_key", "privatekey"]
                .iter()
                .any(|part| name.contains(part))
            {
                continue;
            }
            command.env(&key, &value);
        }
        let _ = fs::create_dir_all(temp.join("cache"));
        let _ = fs::create_dir_all(temp.join("config"));
        command
            .env("HOME", temp)
            .env("TMPDIR", temp)
            .env("XDG_CACHE_HOME", temp.join("cache"))
            .env("XDG_CONFIG_HOME", temp.join("config"));
        unsafe {
            command.pre_exec(move || apply_landlock(&rules, handled));
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Sandboxed command could not start: {error}"))?;
        let stdout = child.stdout.take().ok_or("Command has no stdout")?;
        let stderr = child.stderr.take().ok_or("Command has no stderr")?;
        let out_thread = read_pipe(stdout);
        let err_thread = read_pipe(stderr);
        let deadline = Instant::now() + timeout;
        let (mut timed_out, mut was_cancelled) = (false, false);
        loop {
            if cancelled.load(Ordering::Acquire) {
                was_cancelled = true;
                let _ = child.kill();
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("Could not wait for sandboxed command: {error}"));
                }
            }
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        let (out, trunc_out) = out_thread.join().map_err(|_| "Could not read command output")?;
        let (err, trunc_err) = err_thread.join().map_err(|_| "Could not read command errors")?;
        Ok(ProcessOutput {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit_code: status.code(),
            timed_out,
            output_truncated: trunc_out || trunc_err,
            cancelled: was_cancelled,
        })
    }

    struct Rule {
        path: CString,
        access: u64,
    }

    fn abi_version() -> u64 {
        let value = unsafe {
            libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                std::ptr::null::<u8>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };
        if value < 0 { 0 } else { value as u64 }
    }

    fn full_access(abi: u64) -> u64 {
        let mut access = ACCESS_EXECUTE
            | ACCESS_WRITE_FILE
            | ACCESS_READ_FILE
            | ACCESS_READ_DIR
            | ACCESS_REMOVE_DIR
            | ACCESS_REMOVE_FILE
            | ACCESS_MAKE_CHAR
            | ACCESS_MAKE_DIR
            | ACCESS_MAKE_REG
            | ACCESS_MAKE_SOCK
            | ACCESS_MAKE_FIFO
            | ACCESS_MAKE_BLOCK
            | ACCESS_MAKE_SYM;
        if abi >= 2 {
            access |= ACCESS_REFER;
        }
        if abi >= 3 {
            access |= ACCESS_TRUNCATE;
        }
        if abi >= 5 {
            access |= ACCESS_IOCTL_DEV;
        }
        access
    }

    fn landlock_rules(workspace: &Path, temp: &Path, access: u64) -> Result<Vec<Rule>, String> {
        let mut rules = Vec::new();
        let read_only = ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_READ_DIR;
        // Landlock rules apply to a directory subtree; a rule for a file is
        // rejected with EINVAL, so only directories are added here.
        for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/proc"] {
            if Path::new(path).is_dir() {
                if let Ok(name) = CString::new(path) {
                    rules.push(Rule { path: name, access: read_only });
                }
            }
        }
        // `/dev` needs write access for `/dev/null`; Landlock cannot target a
        // single file, so the whole `/dev` subtree is allowed.
        if Path::new("/dev").is_dir() {
            if let Ok(name) = CString::new("/dev") {
                rules.push(Rule {
                    path: name,
                    access: ACCESS_READ_FILE | ACCESS_READ_DIR | ACCESS_WRITE_FILE,
                });
            }
        }
        for path in [workspace, temp] {
            let name = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| "Command path contains a NUL byte")?;
            rules.push(Rule { path: name, access });
        }
        Ok(rules)
    }

    fn apply_landlock(rules: &[Rule], handled: u64) -> std::io::Result<()> {
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            #[repr(C)]
            struct RulesetAttr {
                handled_access_fs: u64,
            }
            let attr = RulesetAttr { handled_access_fs: handled };
            let ruleset = libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                &attr as *const RulesetAttr,
                std::mem::size_of::<RulesetAttr>(),
                0u32,
            );
            if ruleset < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let ruleset = ruleset as i32;
            #[repr(C, packed)]
            struct PathBeneathAttr {
                allowed_access: u64,
                parent_fd: i32,
            }
            for rule in rules {
                let fd = libc::open(rule.path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC);
                if fd < 0 {
                    let error = std::io::Error::last_os_error();
                    libc::close(ruleset);
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("Landlock could not open a rule path: {error}"),
                    ));
                }
                let path_rule = PathBeneathAttr {
                    allowed_access: rule.access,
                    parent_fd: fd,
                };
                let result = libc::syscall(
                    SYS_LANDLOCK_ADD_RULE,
                    ruleset,
                    LANDLOCK_RULE_PATH_BENEATH,
                    &path_rule as *const PathBeneathAttr,
                    0u32,
                );
                libc::close(fd);
                if result < 0 {
                    let error = std::io::Error::last_os_error();
                    libc::close(ruleset);
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("Landlock add_rule failed: {error}"),
                    ));
                }
            }
            let result = libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0u32);
            libc::close(ruleset);
            if result < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn read_pipe(mut reader: impl Read + Send + 'static) -> thread::JoinHandle<(Vec<u8>, bool)> {
        thread::spawn(move || {
            let mut output = Vec::with_capacity(8192);
            let mut buffer = [0u8; 8192];
            let mut truncated = false;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                        truncated |= count > remaining;
                    }
                }
            }
            (output, truncated)
        })
    }

    fn resolve_program(program: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(program);
        if candidate.is_absolute() {
            return candidate
                .canonicalize()
                .map_err(|error| format!("Command program unavailable: {error}"));
        }
        let path = std::env::var_os("PATH").ok_or("Could not resolve command program")?;
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(program);
            if candidate.is_file() {
                return candidate.canonicalize().map_err(|error| error.to_string());
            }
        }
        Err("Command program was not found in PATH".into())
    }

    type Snapshot = BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)>;

    fn snapshot(root: &Path) -> Result<Snapshot, String> {
        let mut map = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                let name = entry.file_name();
                if metadata.is_dir() {
                    if matches!(name.to_str(), Some(".git" | "node_modules" | "target")) {
                        continue;
                    }
                    stack.push(entry.path());
                } else if metadata.is_file() {
                    let relative = entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|_| "Workspace entry escaped root")?
                        .to_owned();
                    map.insert(relative, (metadata.len(), metadata.modified().ok()));
                }
            }
        }
        Ok(map)
    }

    fn diff_names(before: &Snapshot, after: &Snapshot) -> Vec<String> {
        let mut names: Vec<String> = before
            .iter()
            .filter(|(path, value)| after.get(*path) != Some(*value))
            .map(|(path, _)| path.to_string_lossy().into_owned())
            .collect();
        names.extend(
            after
                .keys()
                .filter(|path| !before.contains_key(*path))
                .map(|path| path.to_string_lossy().into_owned()),
        );
        names.sort();
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_or_parent_working_directories() {
        let root = tempfile::tempdir().unwrap();
        for cwd in ["../outside", "C:\\Windows"] {
            let request = CommandRequest { program: "cmd.exe".into(), args: vec![], working_directory: cwd.into(), timeout_ms: None };
            assert!(validate_request(root.path(), &request).is_err());
        }
    }

    #[test]
    fn validates_argv_and_bounds_timeout() {
        let root = tempfile::tempdir().unwrap();
        let request = CommandRequest { program: "tool.exe".into(), args: vec!["a b".into(), "&".into()], working_directory: "".into(), timeout_ms: Some(500) };
        assert!(validate_request(root.path(), &request).is_ok());
        let bad = CommandRequest { timeout_ms: Some(MAX_TIMEOUT_MS + 1), ..request };
        assert!(validate_request(root.path(), &bad).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn appcontainer_command_changes_only_the_workspace_copy() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().parent().unwrap().join(format!("moderado-outside-{}.txt", crate::sessions::new_id()));
        std::fs::write(&outside, "must remain private").unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("input.txt"), "before").unwrap();
        let request = CommandRequest {
            program: "cmd.exe".into(),
            args: vec!["/c".into(), format!("echo after>output.txt & type \"{}\"", outside.display())],
            working_directory: String::new(),
            timeout_ms: Some(10_000),
        };
        let result = execute_sandboxed(&workspace, request).await.unwrap();
        assert_eq!(std::fs::read_to_string(workspace.join("output.txt")).unwrap().trim(), "after");
        assert!(!result.stdout.contains("must remain private"));
        assert!(result.changed_files.iter().any(|path| path == "output.txt"));
        std::fs::remove_file(outside).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn landlock_command_changes_only_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = root
            .path()
            .parent()
            .unwrap()
            .join(format!("moderado-outside-{}.txt", crate::sessions::new_id()));
        std::fs::write(&outside, "must remain private").unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let request = CommandRequest {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                format!(
                    "echo after > output.txt; cat '{}' 2>/dev/null || true",
                    outside.display()
                ),
            ],
            working_directory: String::new(),
            timeout_ms: Some(10_000),
        };
        let result = execute_sandboxed(&workspace, request).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("output.txt"))
                .unwrap()
                .trim(),
            "after"
        );
        assert!(
            !result.stdout.contains("must remain private"),
            "{}",
            result.stdout
        );
        assert!(result.changed_files.iter().any(|path| path == "output.txt"));
        std::fs::remove_file(outside).unwrap();
    }
}

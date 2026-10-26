# Activity Bar, Project Browser, and Source Control Design

## Intent

Give Moderado Desktop a VS Code style workbench layout while keeping the conversation as the main work area. This design responds to the requested navigation, Settings placement, Project Browser, and commit history. The app retains its existing colors and identity.

## Layout

- The leftmost Activity Bar is a narrow icon rail, about 52 px wide. Its upper group contains Sessions, Workspace, Checkpoints, Schedules, and Source Control in that order. Its lower group contains Profile immediately above Settings.
- Selecting an icon shows one contextual panel beside the rail. The panel is about 260 px wide and has a heading, relevant actions, and a scrollable body. The conversation remains visible to the right.
- The selected icon has a visible accent marker and background. Every icon button has a tooltip, an accessible name, a keyboard focus state, and `aria-pressed` or equivalent selection semantics. Use a consistent set of inline SVG icons; no new icon package or network asset is needed.
- At the current 760 px minimum window width, the rail and panel leave at least 448 px for the conversation. At narrow widths the panel can overlay the conversation when opened, with a clear close action; the rail remains accessible.

## Panels

### Sessions

Keep the existing session list and New session action. Show the active session, a running indicator, and its workspace path. Switching sessions updates every contextual panel without losing drafts or an in-progress turn.

### Workspace / Project Browser

Show the selected workspace name and path, followed by a lazy folder tree. The root loads when the panel opens; expanding a folder loads only that folder. Folders appear before files; `.git` is hidden, symlinks are omitted, and very large directories report a clear limit error. An explicit Refresh action reloads the visible tree. Selecting a UTF-8 file opens a read-only preview with its relative path; the existing 256 KiB file limit applies. No file edit action is added here.

The renderer obtains entries and previews only through Tauri commands that call the jailed workspace functions. The renderer never receives an unrestricted filesystem path to open itself.

### Checkpoints and Schedules

Move the existing lists and actions into separate panels without changing their behavior. Checkpoint restore keeps its diff preview and confirmation. Scheduled runs and approval dialogs continue to work regardless of which panel is selected.

### Source Control

For a Git repository whose root equals the selected workspace, show the current branch, changed and untracked files, and the 50 most recent commits with short hash, subject, author, and local date. The view has Refresh and explicit empty/error states. Git calls are read-only; this scope does not add staging, committing, checkout, fetch, or push controls. If the selected workspace is not a repository root, show a message to open the repository root as the workspace. This keeps Git inspection inside the workspace boundary. Commit rows can reveal the files changed in that commit if the bounded history contract supports it; the first implementation can present the commit list without a graph.

### Profile

Keep the Profile panel available in both modes. In Work mode, show a local profile and make clear that no GitHub account is needed. In Code mode, offer optional GitHub sign-in and show the connected account when available. Keep account credentials in the OS keychain. About information belongs in Settings and must describe the app independently of source-control hosting.

### Settings

Group Connection and Web Search controls under the bottom gear icon, followed by an About section with the app's version and build. Both existing settings sections retain their validation, keychain handling, and per-session behavior. Navigating away must not silently discard typed provider drafts; secret input fields remain transient and are cleared after saving or changing sessions.

## Backend contracts

- `list_project_entries(session_id, relative_path)` returns a bounded list of `{name, path, isDir}` for one jailed directory. It rejects traversal, absolute paths, and symlink escapes. `read_project_file(session_id, relative_path)` reuses the existing jailed UTF-8 reader and size limit.
- `get_source_control(session_id)` returns `{branch, changes, commits}`. Git is run with explicit arguments, no shell, no pager, no interactive prompt, and no mutating subcommand. A canonical Git root check rejects a repository rooted above or outside the selected workspace. Output size and commit count are bounded. No Git command runs from the renderer.
- Errors are returned to the panel as text instead of silently yielding an empty list. Both views are refreshed when the selected session changes and after a completed agent turn that may have changed files.

## Verification

- Rust tests cover folder ordering, workspace path and symlink rejection, file preview bounds, a local Git repository with a commit and a dirty file, and rejection of a nested workspace in a parent repository.
- Frontend checks cover Activity Bar selection and keyboard labels, tree expand/collapse, file preview, Settings visibility, empty states, and source control history rendering.
- Run `npm test`, `npm run lint`, `npm run build`, and a Tauri startup check. Inspect the layout at the minimum window width and at a wide desktop width.

## Reference

VS Code's [Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) describes an outer Activity Bar switching views in the Primary Side Bar and Account/Manage buttons at its bottom. Its [Source Control history guide](https://code.visualstudio.com/docs/sourcecontrol/history) describes a dedicated history view. Moderado follows those placement patterns without copying VS Code's branding or full Git workflow.

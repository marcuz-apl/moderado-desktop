# Workbench Layout, Project Browser, and Source Control Design

## Intent

Give Moderado Desktop a VS Code style workbench layout while keeping the conversation as the main work area. This design responds to the requested navigation, Settings placement, Project Browser, and commit history. The app retains its existing colors and identity.

## Layout

Revised 2026-11-03: the window is four vertical regions — Activity Rail, Left Pane,
Workspace, and Right Pane.

- The 52 px Activity Rail and the resizable Left Pane (200-560 px, 260 px default)
  share one 56 px merged header. The header carries the Moderado mark and wordmark
  plus the Work/Code segmented control. Below the header the rail and the Left Pane
  are separate columns.
- The rail's top group selects the Left Pane contents: Workspaces, Files, Git, and
  Schedules. Its bottom group — User (Profile), Docs, and Settings — opens each as a
  full-width page; activating the active page button returns to the conversation.
- The conversation column owns the 56 px topbar (session stamp, project or task
  context, actions, Plan/Act (hidden in Work mode), theme), the transcript, the composer, and a terminal drawer
  below the composer. The drawer is Code-only and keeps its PTY alive while hidden.
- The Right Pane is the Task Monitor, open by default. At 1200 px and wider it is a
  320 px grid column; below 1200 px it overlays the workspace's right edge as
  `min(340px, calc(100vw - 60px))`, so the rail, Left Pane and workspace stay visible
  and the grid has no third column while overlaying. It leaves the grid when
  collapsed, and page mode also closes its column. Its 56 px header has exactly three
  controls: Tools
  (Open File Browser, Open system terminal, Open in VS Code), the terminal-panel toggle,
  and the collapse triangle. Collapsing leaves a 24 x 64 px edge tab that reopens it.
- Page mode hides the conversation (topbar and transcript), the composer, the drawer
  and the Right Pane, and closes the pane column, leaving the rail and Left Pane
  beside the page.
- At 999 px and below the Left Pane is clamped to 220 px, the resizer is hidden, and
  the workspace context line in the topbar hides. Session actions stay reachable at
  every width, so New, Rename, and Delete never disappear. The rail never hides, and
  the window minimum stays 760 px.
- The rail selection persists in `moderado-left-view` (`workspaces`, `files`, `git`,
  `schedules`; default `workspaces`), the Git switch in `moderado-git-view`
  (`changes` or `checkpoints`; default `changes`), the Left Pane width in
  `moderado-sidebar-width` (200-560 px; default 260), and the Right Pane in
  `moderado-task-monitor`, open unless stored as `false`. The retired keys
  `moderado-sidebar-collapsed` and `moderado-workspace-view` are ignored: stored
  values are not migrated.

## Panels

### Workspaces

The Workspaces rail tab keeps the existing session list and New session action. Session rows are labelled with their creation time as `YY-MM-DD HH:MM:SS` in the local zone instead of the generated `Session N` name; a name typed through Rename replaces the stamp. Show the active session, a running indicator, and its workspace path in the row tooltip. Switching sessions updates every contextual panel without losing drafts or an in-progress turn.

The conversation topbar reads `AGENT SESSION` above the same creation stamp. Its secondary line names the project or task, never the full folder path; the full path remains in the line's tooltip and in the Files view.

### Workspace / Project Browser

Show the selected workspace name and path, followed by a lazy folder tree. The root loads when the Left Pane opens; expanding a folder loads only that folder. Folders appear before files; `.git` is hidden, symlinks are omitted, and very large directories report a clear limit error. An explicit Refresh action reloads the visible tree. Selecting a UTF-8 file opens a read-only preview with its relative path; the existing 256 KiB file limit applies. No file edit action is added here.

The renderer obtains entries and previews only through Tauri commands that call the jailed workspace functions. The renderer never receives an unrestricted filesystem path to open itself.

### Checkpoints and Schedules

The Checkpoints and Schedules views keep the existing lists and actions without changing their behavior: Checkpoints under the Git rail tab, Schedules under its own tab. Checkpoint restore keeps its diff preview and confirmation. Scheduled runs and approval dialogs continue to work regardless of which rail tab is selected.

### Source Control

For a Git repository whose root equals the selected workspace, the Git rail tab shows
the current branch, changed and untracked files, and the 50 most recent commits with
short hash, subject, author, and local date. The view has Refresh and explicit empty/error states. Git calls are read-only; this scope does not add staging, committing, checkout, fetch, or push controls. If the selected workspace is not a repository root, show a message to open the repository root as the workspace. This keeps Git inspection inside the workspace boundary. Commit rows can reveal the files changed in that commit if the bounded history contract supports it; the first implementation can present the commit list without a graph.

### Profile

Keep the Profile page available in both modes. In Work mode, show a local profile and make clear that no GitHub account is needed. In Code mode, offer optional GitHub sign-in and show the connected account when available. Keep account credentials in the OS keychain. About belongs in Settings and must describe the app independently of source-control hosting.

### Settings

Settings opens as a full-width page from the rail bottom; group the Connection and
Web Search controls there with an About section that carries the app's version and build. Both existing settings sections retain their validation, keychain handling, and per-session behavior. Navigating away must not silently discard typed provider drafts; secret input fields remain transient and are cleared after saving or changing sessions.

## Backend contracts

- `list_project_entries(session_id, relative_path)` returns a bounded list of `{name, path, isDir}` for one jailed directory. It rejects traversal, absolute paths, and symlink escapes. `read_project_file(session_id, relative_path)` reuses the existing jailed UTF-8 reader and size limit.
- `get_source_control(session_id)` returns `{branch, changes, commits}`. Git is run with explicit arguments, no shell, no pager, no interactive prompt, and no mutating subcommand. A canonical Git root check rejects a repository rooted above or outside the selected workspace. Output size and commit count are bounded. No Git command runs from the renderer.
- Errors are returned to the panel as text instead of silently yielding an empty list. Both views are refreshed when the selected session changes and after a completed agent turn that may have changed files.

## Verification

- Rust tests cover folder ordering, workspace path and symlink rejection, file preview bounds, a local Git repository with a commit and a dirty file, and rejection of a nested workspace in a parent repository.
- Frontend checks cover the rail tabs and their keyboard roving, the merged header, each Left Pane destination, the Files preview sub-view, the Git Changes/Checkpoints switch, the three-control Right Pane header and its edge tab, page mode keeping the rail and Left Pane, the Tools menu actions, and the light counterparts of every new surface. `tests/session-kind.test.mjs`, `tests/right-panel.test.mjs`, `tests/pages.test.mjs`, `tests/tools-menu.test.mjs`, and `tests/theme.test.mjs` carry those checks.
- Run `npm test`, `npm run lint`, `npm run build`, and a Tauri startup check. Inspect the layout at 760 px, 1180 px, and a wide desktop width.

## Reference

VS Code's [Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) describes an outer Activity Bar switching views in the Primary Side Bar and Account/Manage buttons at its bottom. Its [Source Control history guide](https://code.visualstudio.com/docs/sourcecontrol/history) describes a dedicated history view. Moderado follows those placement patterns without copying VS Code's branding or full Git workflow.

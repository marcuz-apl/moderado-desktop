# Workbench Layout, Project Browser, and Source Control Design

## Intent

Give Moderado Desktop a VS Code style workbench layout while keeping the conversation as the main work area. This design responds to the requested navigation, Settings placement, Project Browser, and commit history. The app retains its existing colors and identity.

## Layout

Revised 2026-11-03: the window is four vertical regions — Activity Rail, Left Pane,
Workspace, and Right Pane.

- The 52 px Activity Rail and the resizable Left Pane (272-560 px, 272 px default)
  share one 56 px merged header. The header carries the "Moderado Desktop" wordmark
  plus the Work/Code segmented control; the OS window icon carries the brand mark.
  Below the header the rail and the Left Pane are separate columns.
- The rail's top group selects the Left Pane contents: Library, Files, Git, and
  Schedules. Its bottom group — User (still a Left Pane view), Docs, and Settings —
  puts the account entry above the pages. Docs and Settings open as full-width
  pages; activating the active page button returns to the conversation.
- The conversation column owns the 56 px topbar (session stamp, project or task
  context, actions, Plan/Act (hidden in Work mode), theme), the transcript, the composer, and a terminal drawer
  below the composer. The drawer is Code-only and keeps its PTY alive while hidden.
- The Right Pane is the Task Monitor. At 1200 px and wider it is a
  288 px grid column; below 1200 px it overlays the workspace's right edge as
  `min(308px, calc(100vw - 60px))`, so the rail, Left Pane and workspace stay visible
  and the grid has no third column while overlaying. It leaves the grid when
  collapsed, and page mode also closes its column. Switching to Code opens it, since
  that mode's work lives in the monitor; switching back to Work closes it unless the
  user opened the pane by hand, and that manual choice survives restarts. Its 56 px
  header has exactly three controls: Tools
  (Open File Browser, Open system terminal, Open in VS Code), the terminal-panel toggle,
  and the collapse triangle. Collapsing leaves a 24 x 64 px edge tab that reopens it.
- Page mode hides the conversation (topbar and transcript), the composer, the drawer
  and the Right Pane, and collapses the Left Pane, leaving only the activity rail
  beside a full-width page.
- At 999 px and below the Left Pane is clamped to 220 px, the resizer is hidden, and
  the workspace context line in the topbar hides. Session actions stay reachable at
  every width, so New, Rename, and Delete never disappear. The rail never hides, and
  the window minimum stays 760 px.
- The Left Pane collapses to the 52 px rail from the triangle in the merged header; the rail stays navigable, and choosing a destination or pressing the same triangle reopens it. The state persists.
- The rail selection persists in `moderado-left-view` (`library`, `files`, `git`,
  `schedules`; default `library`), the Git switch in `moderado-git-view`
  (`changes` or `checkpoints`; default `changes`), the Left Pane width in
  `moderado-sidebar-width` (272-560 px; default 272), the Left Pane collapse state
  in `moderado-sidebar-collapsed` (`true` hides the pane, leaving the rail; default
  expanded), the Right Pane in
  `moderado-task-monitor`, open unless stored as `false`, and a manual Right Pane
  open in `moderado-task-monitor-pinned`, which outranks the mode default. The
  retired key `moderado-workspace-view` is ignored: stored values are not migrated.

## Panels

### Library

The Library rail tab keeps the existing task and project list and its context actions; the name avoids colliding with the central workspace. In Work mode it owns task management: New Task creates a numbered `work-task-##`, and Rename/Delete act on the selected task; deleting a task deletes its sessions while the managed folder and files remain. In Code mode it owns project management: New Project creates a folder, Open registers one, and Rename/Delete act on the selected project; deleting a project deletes its sessions and histories while the project folder and files remain. Its view id is `library`; a stored `workspaces` value from before the rename still opens Library. A new Code session is named with its creation time as `YYYY-MM-DD HH:MM:SS` in the local zone; older auto-named sessions are labelled the same way, and a name typed through Rename replaces the stamp. Show the active session, a running indicator, and its workspace path in the row tooltip. Switching sessions updates every contextual panel without losing drafts or an in-progress turn.

The conversation topbar always reads `AGENT SESSION` beside the session's creation stamp, in both Work and Code. Its **New Session** action starts a session in the selected task (Work) or project (Code); tasks are managed in the Library. Its secondary line names the project or task, never the full folder path; the full path remains in the line's tooltip and in the Files view.

### Workspace / Project Browser

Show the selected workspace name and path, followed by a lazy folder tree. The root loads when the Left Pane opens; expanding a folder loads only that folder. Folders appear before files; `.git` is hidden, symlinks are omitted, and very large directories report a clear limit error. An explicit Refresh action reloads the visible tree. Selecting a UTF-8 file opens a read-only preview with its relative path; the existing 256 KiB file limit applies. No file edit action is added here.

The renderer obtains entries and previews only through Tauri commands that call the jailed workspace functions. The renderer never receives an unrestricted filesystem path to open itself.

### Checkpoints and Schedules

The Checkpoints and Schedules views keep the existing lists and actions without changing their behavior: Checkpoints under the Git rail tab, Schedules under its own tab. Checkpoint restore keeps its diff preview and confirmation. Scheduled runs and approval dialogs continue to work regardless of which rail tab is selected. Git is Code-only: in Work the rail entry is disabled, explains that it needs Code mode, and the Left Pane falls back to the Library, so Work cannot open Git or Checkpoints.

### Source Control

For a Git repository whose root equals the selected workspace, the Git rail tab shows
the current branch, changed and untracked files, and the 50 most recent commits with
short hash, subject, author, and local date. The view has Refresh and explicit empty/error states. Git calls are read-only; this scope does not add staging, committing, checkout, fetch, or push controls. If the selected workspace is not a repository root, show a message to open the repository root as the workspace. This keeps Git inspection inside the workspace boundary. Commit rows can reveal the files changed in that commit if the bounded history contract supports it; the first implementation can present the commit list without a graph.

### User

User is a Left Pane view in both modes, not a full page: its content is small enough to read beside the conversation. It shows the account and, when a Code workspace is a repository, the Git identity. The current session, provider, and Work/Code mode are deliberately absent: the topbar, composer, and the shell's mode control already show that live state, and a second copy goes stale. The Account block offers a Sign in action that opens the Moderado account page at `https://modr.alfazen.org/account?mode=signin` in the system browser. The app keeps working locally without an account. Profile data is not yet pulled back into the pane, because that needs an account API contract; when it exists, tokens belong in the OS keychain and only the display name, email, and plan are cached. About belongs in Settings and must describe the app independently of source-control hosting.

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

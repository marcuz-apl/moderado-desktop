# Activity Rail Shell Design

> Supersedes the rail-free layout in `2026-11-03-qoder-style-shell.md`.

## Intent

Restore a persistent Activity Rail and organize the window into four vertical regions: Activity Rail, Left Pane, Workspace, and Right Pane. The Work/Code selector moves out of the workspace topbar into one header that spans the rail and the Left Pane. The Right Pane is the Task Monitor, with a three-control header.

## Layout

Three top-level grid children:

```
grid-template-columns: auto minmax(0, 1fr) auto;
grid-template-rows: minmax(0, 1fr);

.left-shell    { grid-column: 1; }   /* rail 52px + left pane 260px */
.main          { grid-column: 2; }   /* topbar + transcript + composer + drawer */
.task-monitor  { grid-column: 3; }   /* header + three sections */
```

- `.left-shell` is an internal 2 x 2 grid: `52px var(--sidebar-width, 260px)` by `56px minmax(0, 1fr)`.
  - The merged header (`.shell-head`) spans both columns in row 1.
  - The rail (`.rail`) occupies row 2, column 1.
  - The Left Pane (`.sidebar`) occupies row 2, column 2.
- `.main` is a flex column: 56 px topbar, transcript, composer, terminal drawer, and the full-width pages.
- `.task-monitor` is a flex column: 56 px header, then the three Task Monitor sections.
- All three 56 px rows align horizontally, so the shell reads as one header band.
- The Left Pane is always in the grid. There is no left collapse.
- The Right Pane is open by default on first run. Collapsing it removes its column; a 24 x 64 px edge tab pinned to the right edge of the workspace reopens it.

## Merged header (`.shell-head`)

- Spans the rail and Left Pane columns; 56 px tall.
- Rail column: the 36 px brand mark.
- Pane column: the "Moderado" wordmark and the Work/Code segmented control (`#kind-work`, `#kind-code`), which fills the remaining width.
- The selector keeps its current labels, `aria-pressed` state, and switching behavior. It moves; it does not change.
- The selector and brand are the only content in this header.

## Activity Rail (`.rail`, 52 px, always visible)

Two groups.

Top group, `role="tablist" aria-orientation="vertical"`, top to bottom:

| Tab | Icon | Left Pane shows |
| --- | --- | --- |
| Workspaces | `icon-projects` | Tasks in Work mode, projects in Code mode, with their New/Rename/Delete actions |
| Files | `icon-folder` | Explorer only: root name, Refresh, folder tree, file preview sub-view |
| Git | `icon-source` | Changes, Checkpoints, Git actions, and recent commits |
| Schedules | `icon-clock` | Schedule list, + New, Import transcript |

- Each tab is a `button role="tab"` with `aria-selected`, `aria-controls="sidebar"`, a visible tooltip (`title`), and an accessible name.
- Arrow Up/Down, Home, and End move focus; Enter/Space or click selects.
- The selected tab shows a 2 px accent bar on its left edge plus a tinted background.

Bottom group, pinned to the rail bottom, as plain buttons:

| Button | Icon | Opens |
| --- | --- | --- |
| User | `icon-user` | Profile page |
| Docs | `icon-book` | Docs page |
| Settings | `icon-settings` | Settings page |

- The active page's button carries `aria-current="page"` and the selected styling.
- Activating the already-active bottom button returns to the conversation.
- Tooltips and accessible names are required on every icon.

## Left Pane (`.sidebar`)

- Width 260 px by default, resizable 200-560 px with the existing 7 px handle; double-click resets to 260; arrow keys step 16 px; persists in `moderado-sidebar-width`.
- One view at a time, selected solely by the rail. The selected rail tab is the only navigation state.
- **Workspaces**: the current library list and its actions (New Task, Rename, Delete in Work mode; New, Open, Rename, Remove in Code mode). Heading "Workspaces". Session rows are labelled with their creation time (`YY-MM-DD HH:MM:SS`, local zone) rather than `Session N`; a name typed through Rename wins over the stamp. The row tooltip keeps the workspace path.
- **Files**: the current Explorer view without the Explorer/Changes/Checkpoints tab row. Selecting a file opens the Preview sub-view, which keeps the Files tab selected and offers "Back to files".
- **Git**: branch name, Changes list, commit/push controls, Recent commits, and Checkpoints. The Changes/Checkpoints switch is a two-tab row persisted in `moderado-git-view`. A non-repository workspace keeps the current explanation.
- **Schedules**: the current schedule list and Import transcript.
- Empty states are preserved: no session, no project, no repository, no checkpoints.

## Workspace (`.main`)

- **Topbar** (56 px): the `AGENT SESSION` eyebrow above the session's creation stamp, a secondary line naming the project or task (never the full path, which stays in its tooltip), session actions, Plan/Act control (hidden in Work mode), theme toggle. The Work/Code selector, the sidebar toggle, and the Tools menu are removed from it.
- Transcript, empty state, composer, status, auto-approve bar, and model usage are unchanged.
- The terminal drawer stays below the composer, Code-only, PTY kept alive while hidden. The Right Pane's terminal icon toggles the same drawer.
- The topbar compacts below 1000 px: the project or task context line hides, while session actions stay reachable at every width so New, Rename, and Delete never disappear; the stamp, Plan/Act, and theme remain.

## Right Pane (`.task-monitor`)

- Header (56 px) contains exactly three controls, left to right:
  1. **Tools** dropdown (`▾`).
  2. **Terminal** toggle (`>_`).
  3. **Collapse** triangle (`⧉`).
- No title text in the header. Each control is a 32 px icon button with an accessible name and tooltip.
- **Tools menu**: Open File Browser, Open system terminal, Open in VS Code. Each launches the operating system's file manager (Explorer, Finder, or the Linux file manager), terminal, or editor at the workspace root. Settings and Docs are not in this menu; they live at the rail bottom.
- **Terminal**: toggles the drawer below the composer and reflects its state with `aria-pressed`.
- **Collapse**: closes the pane, removes its column, and shows the edge tab. The edge tab reopens the pane and returns focus to the collapse control.
- Body, unchanged in derivation and rendering: **Updates** (turn completion, completed tools, errors, checkpoints, newest-first), **Background processes**, **Artifacts**. Artifact rows still open the Preview sub-view.
- Width is fixed at 320 px. A resizer is out of scope.

## Pages

- Settings, Docs, and Profile render inside the workspace column, replacing the topbar, transcript, composer, and drawer. The rail and Left Pane remain visible.
- The Right Pane hides while a page is open; its open state is remembered and restored on return.
- The page keeps its own header and "Back to conversation".
- The Profile page reuses the current Profile panel content: mode description, current session, provider, and Git identity.
- Activating Work or Code while a page is open leaves the page and shows that mode's conversation.
- Activating the active bottom rail button, or Back, returns to the conversation and restores focus to the originating button.

## Responsive rules

- **1200 px and wider**: rail, Left Pane, workspace, Right Pane all in the grid.
- **1000-1199 px**: the Right Pane overlays the workspace's right edge at `min(340px, calc(100vw - 60px))` with a shadow; the rail, Left Pane, and workspace stay visible, and the grid has no third column while the pane overlays.
- **760-999 px**: the Left Pane stays in the grid at a clamped 220 px; the Right Pane overlays as above. The topbar compacts.
- The rail is never overlaid or hidden.
- The window minimum stays 760 px.
- The unreachable `<650 px` layout rules are removed.

## Persistence

| Key | Values | Default |
| --- | --- | --- |
| `moderado-left-view` (new) | `workspaces` \| `files` \| `git` \| `schedules` | `workspaces` |
| `moderado-git-view` (new) | `changes` \| `checkpoints` | `changes` |
| `moderado-sidebar-width` (kept) | 200-560 | 260 |
| `moderado-task-monitor` (kept) | `true` = open | `true` |
| `moderado-navigation` (kept) | session/project ids | - |
| `moderado-last-kind` (kept) | `work` \| `code` | `work` |
| `moderado-theme` (kept) | `auto` \| `light` \| `dark` | `auto` |
| `moderado-display-size` (kept) | display size | - |

- Removed: `moderado-sidebar-collapsed` and `moderado-workspace-view`. Stored values are ignored, not migrated.
- Unknown stored values fall back to the defaults.

## Accessibility

- The rail top group is a vertical tablist with roving tabindex and arrow/Home/End keys.
- Rail buttons have accessible names and tooltips; the selected tab exposes `aria-selected`; the active page button exposes `aria-current`.
- The Tools menu keeps its `menu`/`menuitem` roles, Escape-to-close, and focus return to its trigger.
- Collapsing the Right Pane moves focus to the edge tab; reopening returns focus to the collapse control.
- Page transitions move focus into the page and return it to the originating rail button on Back.
- Focus rings remain visible in both themes.
- Every icon control is keyboard reachable; the terminal drawer keeps its keyboard access.

## Backend and data

- No Rust changes, no schema change, no migration, and no new dependency.
- Reuse the existing commands unchanged: `list_project_entries`, `read_project_file`, `get_source_control`, `git_identity`, `git_commit`, `git_push`, `list_checkpoints`, schedule commands, `terminal_*`, `open_in_editor`, `open_system_terminal`.
- The workspace jail, approval gate, fixed external-launch candidates, and secret handling are untouched.
- The Task Monitor remains derived from existing state; its module and tests do not change.

## Error handling

- A failed or rejected action still surfaces in the status line; nothing is swallowed.
- No session: Workspaces shows its empty state; Files, Git, and Schedules say to select a task or project; the monitor says to select a session.
- Non-repository Git keeps the current explanation.
- A failed external launch keeps its explicit status message.

## Non-goals

- Badges or counters on rail icons.
- A Right Pane resizer.
- Any left-pane collapse or overlay mode.
- Schedule changes, Git features, terminal behavior, approval changes, or new backend commands.
- Visual redesign beyond the layout and the surfaces named here.

## Verification

Automated:

- The rail exists with four tab buttons and three bottom buttons; the tabs expose `aria-selected` and arrow-key navigation; the selection persists in `moderado-left-view`.
- The merged header contains the Work/Code selector; the topbar does not.
- Each rail tab shows exactly its view; Files no longer shows Changes/Checkpoints; Git shows both and persists `moderado-git-view`.
- The Right Pane header has exactly three controls; the Tools menu has exactly three items and no Settings or Docs; collapse shows the edge tab and persists.
- Pages keep the rail and Left Pane, hide the Right Pane, and Back returns to the conversation.
- Existing suites for the terminal key, Task Monitor derivation, and external launch remain green.
- Theme tests cover the rail, merged header, Right Pane header, and edge tab light counterparts.
- `npm test`, `npm run lint`, and `npm run build` pass offline.

Manual smoke:

1. The rail, Left Pane, workspace, and Right Pane render as four regions with one aligned header band.
2. Work/Code in the merged header switches modes and panes; it is absent from the topbar.
3. Each rail tab opens its view; Git shows Changes and Checkpoints; Files has no tab row.
4. Settings, Docs, and Profile open as pages with the rail and Left Pane still visible; Back returns.
5. The Right Pane's Tools menu opens the OS file browser, VS Code, and the system terminal at the workspace root.
6. The terminal icon toggles the drawer; the triangle collapses the pane and the edge tab reopens it after a restart.
7. At 1180 px the Right Pane overlays; below 1000 px the topbar compacts; at 800 px the Left Pane stays at 220 px and the rail never disappears.

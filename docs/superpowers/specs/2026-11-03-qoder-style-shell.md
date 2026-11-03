# Qoder-style Shell Design

**Date:** 2026-11-03
**Status:** Proposed
**Supersedes:** the activity-bar layout in `docs/sidebar-design.md`

## Goal

Replace the three-column activity-bar shell with a Qoder-style workbench:

- one left panel that owns navigation and contextual views,
- one right Task Monitor sidecar,
- one terminal drawer inside the conversation column, below the composer,
- one top-right Tools menu for panels, external launchers, and app pages.

The conversation remains the primary work area. Colors, typography, controls, and the
existing Tauri command contracts stay unchanged.

## Non-goals

- No new database tables or migrations. The Task Monitor derives its data from the
  session history, checkpoints, and schedules that already exist.
- No OS process monitor. "Background processes" means agent turns and scheduled runs.
- No new dependency. Menus, popovers, and external launch use platform APIs and the
  runtime's standard library.
- No editor configuration UI in this iteration. The backend tries a fixed whitelist of
  known editor executables.

## Layout

```
+-------------------------+-----------------------------------+----------------------+
| Left panel (resizable)  | Main column                       | Task Monitor         |
|                         |                                   | (right sidecar)      |
| [Sessions Files ...]    | topbar: [panel] [tools] [Plan]    | Updates              |
|                         | transcript                        | Background processes |
| library / explorer /    | composer                          | Artifacts            |
| preview / schedules /   | terminal drawer (collapsed)       |                      |
| profile                 |                                   |                      |
+-------------------------+-----------------------------------+----------------------+
```

- The 52 px Activity Bar is removed. There is no icon rail anywhere.
- The left panel is the only navigation surface. Its width is resizable from 240 to 420 px
  and it can be collapsed to zero from a topbar toggle.
- The right Task Monitor is about 320 px wide. It is closed by default, toggled from the
  Tools menu, and overlays the main column below 1100 px.
- The terminal drawer sits inside the main column after `.composer-wrap`, is closed by
  default, and keeps its PTY alive when hidden. It is available in Code sessions only.

## Navigation model

### Left panel

A compact tab row at the top of the left panel replaces the activity bar:

| Tab | Panel | Contents |
| --- | --- | --- |
| Sessions | `library` | Tasks and projects, existing `library` body |
| Files | `workspace` | Explorer / Changes / Checkpoints tabs, existing body |
| Schedules | `schedules` | Existing schedule CRUD and transcript import |
| Profile | `profile` | Existing profile and Git identity block |

`preview` is a transient view, opened by selecting a file. While it is active the Files
tab stays selected; the Preview header carries a "Back to files" action.

A topbar toggle (far left, before the Work/Code switch) collapses or expands the left
panel. Collapsing must not destroy drafts or an in-progress turn.

### Top-right Tools menu

A single icon button in `.topbar-controls` opens a popover with three groups:

| Group | Item | Action |
| --- | --- | --- |
| Panels | File browser | Open the left panel on Files / Explorer |
| Panels | Task monitor | Toggle the right sidecar |
| Panels | Terminal panel | Toggle the bottom drawer (Code only) |
| Open in | VS Code | Launch the workspace in a known editor executable |
| Open in | System terminal | Launch a native terminal rooted at the workspace |
| App | Settings | Open the existing full-width Settings page |
| App | Docs | Open the existing full-width Docs page |

Panel toggles use `role="menuitemcheckbox"` with `aria-checked`. One-shot actions use
`role="menuitem"`. Disabled items expose a reason through `title` and `aria-disabled`.
The menu closes on Escape, on outside click, and after an action; focus returns to the
trigger.

## Task Monitor

The sidecar has three stacked sections, in this order.

### Updates

A newest-first activity feed for the active session:

- completed tool calls, labeled with the existing tool titles,
- tool errors,
- checkpoint creation,
- turn completion.

Updates are derived from `views.get(sessionId)` (the existing persisted tool messages)
plus `list_checkpoints`, so they survive a session reload without a schema change.
Streaming assistant text does not enter the feed; the transcript already owns it.

### Background processes

- The active turn for the session, with a start time and elapsed label.
- Scheduled runs from `list_schedules`: in-flight runs as "Running now", enabled runs
  with their next run time, paused runs with their last error.

This section is read-only. Schedule creation and deletion stay in the Schedules panel.

### Artifacts

Files the agent created, edited, or changed during the session, derived from completed
tool results:

- `write_file` result `Wrote <path>` -> created,
- `edit_file` result `Edited <path>` -> updated,
- `execute_command` JSON `changedFiles` -> changed.

Artifacts are deduplicated by path with the latest action winning. Selecting an artifact
opens the existing read-only Preview panel.

### Limitations accepted for v1

- The feed is per active session, not a global task list.
- Tool arguments are not shown for read/search tools because the completion event does
  not carry them. A future event contract can add a structured detail field.
- Nothing is persisted beyond the session history and checkpoints already stored.

## Terminal drawer

- The xterm host moves from the left panel into `.main`, after `.composer-wrap`.
- `terminalOpen` replaces `activePanel === 'terminal'`.
- Opening the drawer calls the existing `ensureTerminal()`, fits the terminal, and
  focuses it. Closing hides the drawer without killing the PTY.
- Switching to Work closes the drawer. Switching projects while it is open re-keys the
  shell through the existing `terminalKey()` / `terminal_open` contract.
- The drawer has a fixed default height of 260 px and a close button. A drag-to-resize
  handle is out of scope.

## External launch

Two Tauri commands resolve the workspace with the existing `browser_workspace()` helper
and launch a detached process. They never accept a program name from the webview.

- Editors, in order: platform-specific VS Code executable, `code`, `code-insiders`,
  `cursor`.
- Terminals, in order: Windows Terminal (`wt.exe -d <root>`), `cmd.exe` with
  `CREATE_NEW_CONSOLE` and `current_dir(root)`; Linux `x-terminal-emulator`,
  `gnome-terminal --working-directory`, `konsole --workdir`, `xterm`; macOS
  `open -a Terminal`.
- Arguments are passed as an argv array. No shell string is constructed. A missing
  executable falls through to the next candidate; the final failure is returned to the
  status line.

## State and persistence

| Key | Value |
| --- | --- |
| `moderado-navigation` | existing session navigation |
| `moderado-sidebar-width` | existing left panel width |
| `moderado-sidebar-collapsed` | `true` / `false` |
| `moderado-task-monitor` | `true` / `false` |

The active left tab is not persisted; Sessions is the default on launch. The terminal
drawer starts closed.

## Accessibility and responsive behavior

- Left tabs use `role="tablist"` / `role="tab"` with `aria-selected`.
- The Tools popover supports ArrowUp, ArrowDown, Home, End, Escape, and focus return.
- The topbar toggle exposes `aria-expanded`.
- Below 1100 px the Task Monitor overlays from the right.
- Below 850 px the left panel is narrower; below 650 px it overlays the conversation.
- Page mode hides the left panel, the Task Monitor, the terminal drawer, and the
  conversation.

## Security

- UI-only external launch stays in Rust with fixed executable candidates.
- The workspace is resolved server-side; the renderer never supplies a filesystem path
  to launch.
- No secrets, no new HTTP calls, no telemetry.
- The workspace jail, approval gate, and keychain rules are unchanged.

## Verification

- `tests/tools-menu.test.mjs`: enablement rules and keyboard index wrapping.
- `tests/task-monitor.test.mjs`: update/artifact/process derivation, artifact parsing,
  elapsed labels.
- `tests/right-panel.test.mjs`: no activity rail; left tabs; right sidecar sections;
  terminal drawer placement; PTY key behavior.
- `tests/pages.test.mjs` and `tests/session-kind.test.mjs`: updated navigation model.
- `src-tauri/src/external.rs` unit tests: candidate lists and argv construction.
- `npm test`, `npm run lint`, `npm run build`, plus a manual startup smoke test on
  Windows and, for external launch, Linux and macOS.

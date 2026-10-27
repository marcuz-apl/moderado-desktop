# Auto-Approve, Command Tools, MCP, and Compact Mode Design

**Status:** Implemented with subsequent user-directed scope updates
**Date:** 2026-10-26

## Goal

Make Work/Code selection compact and always visible, let the user explicitly select the active Work task or Code project from its list, and add per-session approval preferences with command execution and local MCP tool support.

## Product decisions

### Compact mode selector

- Remove the Mode activity-bar item and its sidebar panel.
- Put a compact Work/Code segmented selector in the main top bar beside the session title. Keep Plan/Act and the light/dark control on the right.
- Switching mode selects the most recent session of that kind when one exists. Work remains the startup mode.
- Remove the coral dot from the ⌘ welcome symbol. The M-and-coral-dot app icon remains unchanged.

### Explicit task and project selection

- Put a radio button at the right edge of each Work task row and Code project row.
- There is one active conversation in the main canvas, so task/project selection is exclusive: at most one radio button in the current mode is selected. Selecting another row activates it.
- Selecting a Work task activates that Work session. Selecting a Code project activates the project and its most recently updated Code session.
- Project session selection remains available in the Sessions panel. Changing sessions within a project leaves the project radio button selected.
- A radio button cannot be toggled off by clicking it. No item is selected when the list has no available items or when the active item is deleted. The composer must not send against a stale session; its empty state directs the user to select or create a task/project.
- Clicking the row label retains its current selection behavior. The radio button is an explicit, accessible indicator and selection control.

### Per-session Auto-Approve

- Add an **Auto-Approve** section in Settings for Code sessions, with checkboxes for **Read files**, **Edit files**, **Fetch web content**, **Execute command**, and **Use MCP servers**.
- New and existing Code sessions default to all five checked. Existing user-customized policies are preserved during migration. Checked means the implemented action runs without a per-call approval prompt; unchecked means the user must approve each call.
- Work sessions expose no file, command, or MCP tools. Their existing optional web-search behavior is unchanged.
- MCP remains a checked, disabled placeholder until MCP tools are implemented.
- The preference is persisted per session and enforced in Rust. Renderer or model prompt text is not an authorization boundary.

### Tool behavior

- Keep Plan mode structural. Plan mode does not expose or dispatch file edits, command execution, or MCP tool calls, even when a preference is checked. These tools are Code Act capabilities.
- When a category is unchecked, a shared approval flow identifies the action before it runs: file and web target, full command plus working directory, or MCP server and tool name with arguments.
- File mutations retain the existing diff preview, stale-file check, and checkpoint-before-write behavior when approved automatically or manually.
- Add an `execute_command` tool on Windows that accepts a program and argument array (no implicit shell parsing), uses the session workspace as its working directory, supports cancellation, and bounds execution time and captured output. It runs in a Windows AppContainer against a disposable workspace copy; unsupported platforms fail closed and do not advertise the tool.
- Keep **Use MCP servers** as a checked, disabled placeholder. No MCP processes or tools are available yet.

### Persistence and migration

- Add a numbered SQLite migration that stores the five per-session auto-approval booleans.
- Enable all five categories for Code sessions with the previous default policy; preserve any customized policy values.
- New Code sessions receive all-enabled defaults. New Work sessions retain Work-only capabilities.
- MCP server configuration and invocation are deferred.
- No project/session identity redesign or provider contract changes are part of this feature.

## Architecture

- All model tool calls continue through Rust `agent.rs`; provider HTTP remains in `provider.rs`.
- The renderer displays and edits per-session settings through Tauri commands but cannot execute tools or contact MCP servers directly.
- The Rust dispatcher classifies each tool into its approval category, checks session kind and Plan/Act mode, reads the session policy, and either requests approval or invokes the capability.
- MCP server startup, discovery, namespacing, calls, cancellation, and shutdown are owned by a Rust MCP manager. The manager returns normalized tool definitions and results to the existing agent loop.
- Command execution and MCP calls surface explicit failures as tool results; a missing sandbox or unavailable server must never silently degrade to unsandboxed execution.

## Out of scope

- Remote Streamable HTTP MCP, MCP OAuth, MCP prompts/resources/sampling, server marketplace, and tool-install automation.
- Multi-selecting several Work tasks or Code projects for one conversation.
- Changing the existing checkpoint model or making remote MCP side effects reversible.
- Changing provider settings or Work-mode filesystem access.

## Acceptance criteria

1. The welcome ⌘ symbol has no red dot; the app icon remains the M with coral dot.
2. Work/Code is a compact top-bar control; there is no Mode sidebar item or panel. Plan/Act and theme remain at the right.
3. Work task rows and Code project rows each show an accessible radio button aligned to the right.
4. At most one task or project radio button is selected in the current mode; selecting a task/project activates its context.
5. A selected project opens its most recent session, and selecting another session within it keeps the project radio button selected.
6. New Code sessions show all five Auto-Approve boxes checked; existing default Code policies migrate to all enabled while customized policies remain unchanged.
7. Policy changes persist across restart.
8. With a category unchecked, each matching operation waits for an explicit approval describing the operation before it runs.
9. Plan mode structurally blocks edits, command execution, and MCP calls regardless of preferences.
10. On Windows, command execution is limited to Code Act, runs in an AppContainer with a disposable workspace copy, supports cancellation and bounded output/time, and fails closed if sandboxing is unavailable. Other platforms do not expose the command tool.
11. MCP remains a checked, disabled placeholder; no MCP process is launched.
12. Work sessions retain no file/command/MCP capability.
13. Unit tests verify defaults, migration behavior, read/web permission gates, Plan-mode enforcement, workspace sandbox boundaries, and command execution. Tests run offline using local mock commands.

## Risks and open implementation checks

- The current command sandbox is Windows-only; other platforms fail closed and do not advertise command execution.
- The all-checked default for new Code sessions intentionally removes per-call confirmations for file edits, commands, and configured MCP tools. The Settings text must make this explicit before the user sends work.
- Existing sessions keep the prior effective policy rather than inheriting all-enabled defaults. This avoids silently widening permissions during upgrade.
- MCP implementation remains deferred; its checked placeholder does not enable a runtime capability.

## References

- Official Rust MCP SDK (`rmcp`), including client and stdio transport support: <https://github.com/modelcontextprotocol/rust-sdk>
- Microsoft AppContainer process isolation: <https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer>
- Linux Landlock access-control sandbox: <https://www.man7.org/linux/man-pages/man7/Landlock.7.html>
- Apple sandboxed helper tools and inherited entitlements: <https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app>

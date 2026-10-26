# Auto-Approve, Command Tools, MCP, and Compact Mode Design

**Status:** Approved for specification; awaiting user review before implementation
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
- Newly created Code sessions start with all five checked, as requested. Checked means the listed action runs without a per-call approval prompt; unchecked means the user must approve each call.
- Existing sessions preserve current effective behavior during migration: reads and configured web search remain automatic; file edits continue to prompt; command and MCP permissions start disabled. This avoids silently changing the trust policy of existing conversations.
- Work sessions expose no file, command, or MCP tools. Their existing optional web-search behavior is unchanged.
- Clearly state that auto-approved MCP calls can change connected services and cannot be reverted by local workspace checkpoints.
- The preference is persisted per session and enforced in Rust. Renderer or model prompt text is not an authorization boundary.

### Tool behavior

- Keep Plan mode structural. Plan mode does not expose or dispatch file edits, command execution, or MCP tool calls, even when a preference is checked. These tools are Code Act capabilities.
- When a category is unchecked, a shared approval flow identifies the action before it runs: file and web target, full command plus working directory, or MCP server and tool name with arguments.
- File mutations retain the existing diff preview, stale-file check, and checkpoint-before-write behavior when approved automatically or manually.
- Add an `execute_command` tool that accepts a program and argument array (no implicit shell parsing), uses the session workspace as its working directory, supports cancellation, and bounds execution time and captured output. It must run in an OS-enforced sandbox restricted to the workspace. If the platform sandbox cannot be established, command execution fails closed and reports the reason.
- Configure the command sandbox separately per platform. Windows uses an AppContainer process with workspace access granted explicitly; Linux uses Landlock when available; macOS uses a sandboxed helper with inherited App Sandbox entitlements. The command capability is unavailable when the required sandbox is not present.
- Add local stdio MCP client support using the official Rust MCP SDK. MCP servers are explicitly configured by the user in Settings; server definitions are local-device configuration, while the **Use MCP servers** permission remains per session.
- Initially expose MCP tools only (not prompts, resources, sampling, or remote HTTP transports). Namespace model-visible tool names by the configured server identity to prevent collisions. Do not expose these tools in Work or Plan mode.
- Start MCP processes only when needed, keep protocol stdout separate from diagnostic stderr, enforce call timeouts/output limits, and terminate child processes on cancellation or session shutdown.
- MCP server binaries are user-selected code and may perform network actions. Auto-approval of MCP calls is a trust decision; it grants the configured server's available tools permission to run without per-call approval.
- Store secrets used by MCP server configuration in the OS keychain; do not put secret values in logs, tool results, or session history.

### Persistence and migration

- Add a numbered SQLite migration that stores the five per-session auto-approval booleans.
- Populate existing Code sessions with the legacy-effective policy: read and web enabled, edit, command, and MCP disabled.
- New Code sessions receive all-enabled defaults. New Work sessions retain Work-only capabilities.
- Store local stdio MCP server definitions in app data, with secret references resolved through the keychain.
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
6. New Code sessions show all five Auto-Approve boxes checked and persist changes across restart.
7. Existing sessions retain their effective prior approval behavior after migration.
8. With a category unchecked, each matching operation waits for an explicit approval describing the operation before it runs.
9. Plan mode structurally blocks edits, command execution, and MCP calls regardless of preferences.
10. Command execution is limited to Code Act, runs with an OS sandbox rooted at the workspace, supports cancellation and bounded output/time, and fails closed if sandboxing is unavailable.
11. MCP stdio tools are configurable locally, namespaced, exposed only in Code Act, and use per-session auto-approval. No MCP process is launched from renderer code.
12. Work sessions retain no file/command/MCP capability.
13. Unit tests verify defaults, migration behavior, each permission gate, Plan-mode enforcement, workspace sandbox boundaries, MCP tool namespacing, and process cancellation. Tests run offline using local mock commands and MCP servers.

## Risks and open implementation checks

- AppContainer, Landlock, and macOS App Sandbox have platform/version and packaging constraints. Each backend must be verified in CI or a platform test environment; unsupported configurations fail closed.
- The all-checked default for new Code sessions intentionally removes per-call confirmations for file edits, commands, and configured MCP tools. The Settings text must make this explicit before the user sends work.
- Existing sessions keep the prior effective policy rather than inheriting all-enabled defaults. This avoids silently widening permissions during upgrade.
- Local MCP servers are arbitrary user-selected programs. Server setup must identify executable and arguments clearly, and server identity must remain visible in tool results and approval prompts.

## References

- Official Rust MCP SDK (`rmcp`), including client and stdio transport support: <https://github.com/modelcontextprotocol/rust-sdk>
- Microsoft AppContainer process isolation: <https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer>
- Linux Landlock access-control sandbox: <https://www.man7.org/linux/man-pages/man7/Landlock.7.html>
- Apple sandboxed helper tools and inherited entitlements: <https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app>

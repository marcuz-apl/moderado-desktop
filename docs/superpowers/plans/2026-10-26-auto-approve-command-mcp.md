# Auto-Approve, Command Tools, MCP, and Compact Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact Work/Code selector, explicit task/project radio selection, per-session Auto-Approve controls, sandboxed command execution. MCP is a checked placeholder for later implementation.

**Architecture:** Keep all authorization and tool dispatch in Rust. Store five permission booleans with each session, use a shared typed approval request for every unchecked category, run commands in a fail-closed platform sandbox, and adapt local stdio MCP servers through the official Rust SDK. The renderer edits settings and displays approvals but never launches tools or MCP processes.

**Tech Stack:** Rust, Tauri 2, SQLite migrations, TypeScript, Node test runner, Windows AppContainer.

**Spec:** `docs/superpowers/specs/2026-10-26-auto-approve-command-mcp-design.md`

## Global Constraints

- Preserve the single Rust tool dispatcher and keep Plan-mode restrictions structural.
- Never invoke tools or provider APIs directly from the renderer.
- New and existing default Code sessions start with all five Auto-Approve preferences enabled; preserve customized policies. MCP remains a checked, disabled placeholder.
- Work sessions retain no file, command, or MCP capability.
- Windows command execution must be restricted to a disposable workspace copy by AppContainer and fail closed when unavailable. Other platforms do not advertise command execution.
- MCP runtime and configuration are deferred; keep its checkbox checked and disabled.
- Secrets remain in the OS keychain; tests run offline with local mock commands.
- Keep the M-and-coral-dot app icon; remove the dot only from the ⌘ welcome symbol.
- Work/Code appears in the top bar beside the session title; Plan/Act and theme remain at the right.
- Task/project selectors are exclusive accessible radio buttons, one selected per mode.

## Review Focus

- A version-3 database migrates without changing existing edit approvals: covered by Task 1 migration tests.
- A provider-invented or stale tool call cannot bypass permission or Plan mode: covered by Task 2 dispatch tests.
- A command cannot read/write outside the workspace or continue after cancellation: covered by Task 3 sandbox tests.
- Duplicate/invalid MCP server and tool names cannot select another server's tool: covered by Task 4 registry tests and Task 5 dispatch tests.
- Deleting the active Work task or Code project cannot leave a stale checked radio/session context: covered by Task 7 renderer state tests.

## File Map

- `src-tauri/src/approval_policy.rs` — typed category settings and defaults.
- `src-tauri/src/db.rs`, `src-tauri/src/sessions.rs` — schema migration and per-session policy persistence.
- `src-tauri/src/agent.rs`, `src-tauri/src/agent/runner.rs`, `src-tauri/src/lib.rs` — policy enforcement, generic approval requests, command/MCP tool dispatch and Tauri APIs.
- `src-tauri/src/command.rs` — bounded Windows AppContainer command execution.
- MCP runtime is deferred; no module is needed for its checked placeholder.
- `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/sessions-view.ts`, `src/renderer/style.css`, `src/renderer/theme.css` — compact mode control, task/project radio controls, permission editor, and approval UI.
- `tests/approval-policy.test.mjs`, `tests/session-kind.test.mjs`, Rust module tests — defaults, UI helpers, migrations, and security boundaries.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — Windows AppContainer dependency/features.

## Tasks

### Task 1: Per-session approval policy and migration

**Files:** Create `src-tauri/src/approval_policy.rs`, `tests/approval-policy.test.mjs`; modify `src-tauri/src/db.rs`, `src-tauri/src/sessions.rs`, `src-tauri/src/lib.rs`, and Rust module declarations.

**Interfaces:**
- `ApprovalCategory::{ReadFiles, EditFiles, FetchWebContent, ExecuteCommand, UseMcpServers}` serialized as snake_case.
- `AutoApprovePolicy { read_files, edit_files, fetch_web_content, execute_command, use_mcp_servers: bool }` serialized as camelCase.
- `AutoApprovePolicy::for_new_session(kind: SessionKind) -> Self`, `legacy_default(kind: SessionKind) -> Self`, and `allows(category: ApprovalCategory) -> bool`.
- `SessionRecord` and `SessionSummary` expose `auto_approve: AutoApprovePolicy`.
- `SessionStore::update_auto_approve(session_id: &str, policy: AutoApprovePolicy) -> Result<(), String>`.

- [ ] **Step 1: Write failing Rust tests** for new Code defaults (all true), Work defaults (all false except existing web behavior), and the legacy Code policy (read/web true; edit/command/MCP false).
- [ ] **Step 2: Write failing migration tests** upgrading a version-3 database, preserving session rows and backfilling policies; reopening the database is a no-op.
- [ ] **Step 3: Run the focused Rust tests** and confirm they fail because policy persistence/migration is missing.
- [ ] **Step 4: Implement migration 4** adding a non-null JSON policy column, backfilling legacy-effective values, and updating `SCHEMA_VERSION`.
- [ ] **Step 5: Implement the typed policy and session store read/update paths**; initialize new sessions from `for_new_session`.
- [ ] **Step 6: Run focused Rust tests** and confirm all policy and migration cases pass.

### Task 2: Typed approvals and structural policy enforcement

**Files:** Modify `src-tauri/src/agent.rs`, `src-tauri/src/agent/runner.rs`, `src-tauri/src/lib.rs`; test in those modules.

**Interfaces:**
- `ApprovalRequest { category: ApprovalCategory, title: String, detail: String, preview: Option<Approval> }`.
- Approval callback accepts `ApprovalRequest`; existing write diff preview continues through `preview`.
- `tool_category(name: &str) -> Option<ApprovalCategory>` is the single category mapping used by dispatcher and tests.
- `tool_definitions` receives session kind, mode, configured web search, policy, and available MCP tools.

- [ ] **Step 1: Add failing dispatcher tests** proving each tool maps to its category and unchecked categories request approval before execution.
- [ ] **Step 2: Add failing Plan-mode tests** proving edits, command, and MCP are blocked before the approval callback even when their preferences are enabled.
- [ ] **Step 3: Add failing Work-mode tests** proving file, command, and MCP tools remain unavailable.
- [ ] **Step 4: Run focused Rust tests** and confirm the expected policy-bypass failures.
- [ ] **Step 5: Implement the approval request contract and central category mapping**; route reads/list/search, writes/edits, web search, commands, and MCP calls through it.
- [ ] **Step 6: Preserve write preview, stale-file check, and checkpoint ordering** for both prompt-approved and auto-approved writes.
- [ ] **Step 7: Run focused agent tests** and confirm category and mode gates pass.

### Task 3: Bounded sandboxed command runner

**Files:** Create `src-tauri/src/command.rs` and target-specific sandbox modules; modify `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`, and agent tests.

**Interfaces:**
- `CommandRequest { program: String, args: Vec<String>, working_directory: String, timeout_ms: u64 }`.
- `CommandResult { stdout: String, stderr: String, exit_code: Option<i32>, truncated: bool }`.
- `execute_sandboxed(workspace: &Path, request: CommandRequest, cancel: watch::Receiver<bool>) -> Result<CommandResult, String>`.
- No shell is invoked implicitly. Working directory must resolve within the canonical workspace.

- [ ] **Step 1: Write failing tests** for argv preservation, relative working-directory validation, time limit, output cap, cancellation/child termination, nonzero exit reporting, and workspace escape rejection.
- [ ] **Step 2: Run focused tests** and confirm no command runner exists.
- [ ] **Step 3: Implement a target-independent command request/result layer** with explicit timeout, output cap, cancellation, and error reporting.
- [ ] **Step 4: Implement Windows AppContainer launching** granting only the session workspace and required standard pipes; test unsupported setup fails closed.
- [ ] **Step 5: Implement Linux Landlock launching** and test that file operations outside the workspace are denied; fail closed when Landlock is unavailable.
- [ ] **Step 6: Implement a macOS sandboxed helper with inherited App Sandbox entitlements** and add packaging configuration/tests. Disable command capability when the helper or entitlement cannot be verified.
- [ ] **Step 7: Run target-specific command tests** on available CI/platforms; document skipped host-only tests without treating them as passing platform verification.

### Task 4: Local stdio MCP server configuration and lifecycle

**Files:** Create `src-tauri/src/mcp.rs`; modify `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/db.rs`, `src-tauri/src/lib.rs`; add local MCP fixtures/tests.

**Interfaces:**
- `McpServerConfig { id: String, name: String, program: String, args: Vec<String>, working_directory: Option<String>, secret_env_refs: BTreeMap<String, String>, enabled: bool }`.
- `McpToolDefinition { server_id: String, server_name: String, tool_name: String, model_name: String, description: String, input_schema: Value }`.
- `McpManager::{list_servers, save_server, delete_server, tools_for_session, call_tool, shutdown_session}`; all errors are explicit `Result<_, String>`.
- Store config and secret references in app data; resolve secret environment values from OS keychain only when starting a child.

- [x] Keep the MCP checkbox checked, disabled, and labeled as a placeholder; runtime support is deferred.
- [ ] **Step 2: Confirm the tests fail** because no MCP manager or SDK exists.
- [ ] **Step 3: Add official `rmcp` client/stdio child-process features and only the Tokio process/I/O features required by them.**
- [ ] **Step 4: Add migration 5 and configuration CRUD** with stable server IDs, validation, and keychain references.
- [ ] **Step 5: Implement lazy stdio startup, discovery, namespacing as `mcp__{server_id}__{tool_name}`, bounded results, timeouts, cancellation, stderr capture, and lifecycle cleanup.**
- [ ] **Step 6: Run local fixture tests offline** and confirm protocol errors, duplicate tool names across servers, and unavailable servers surface correctly.

### Task 5: Agent integration for command tools

**Files:** Modify `src-tauri/src/agent.rs`, `src-tauri/src/agent/runner.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/mcp.rs`; add Rust integration tests.

**Interfaces:**
- Agent run configuration receives `&AutoApprovePolicy`, `&McpManager`, and the session cancellation receiver.
- MCP tool model names map back to `(server_id, tool_name)` only through the manager registry; model-supplied names never select an unconfigured process.
- `execute_command` accepts validated JSON matching `CommandRequest`; returned output is bounded by the runner.

- [ ] **Step 1: Write failing end-to-end agent tests** where the model requests a command and an MCP tool; assert they are unavailable in Work/Plan and available only in Code/Act.
- [ ] **Step 2: Add failing approval tests** showing unchecked command/MCP preferences wait for approval, checked preferences skip approval, and cancellation terminates the underlying operation.
- [ ] **Step 3: Implement tool definitions and dispatch** using the central category policy; MCP tools are discovered only for configured enabled servers.
- [ ] **Step 4: Route command execution through `execute_sandboxed`** and MCP execution through `McpManager::call_tool`.
- [ ] **Step 5: Persist each tool result/error into session history and emit it to the UI** without logging secret environment values.
- [ ] **Step 6: Run agent integration tests** with mock command and stdio MCP fixtures; verify Plan and Work remain structurally restricted.

### Task 6: Tauri approval and settings APIs

**Files:** Modify `src-tauri/src/lib.rs`, `src-tauri/src/sessions.rs`, `src-tauri/src/mcp.rs`; add Tauri command/unit tests where feasible.

**Interfaces:**
- Tauri commands `get_auto_approve`, `save_auto_approve`, `list_mcp_servers`, `save_mcp_server`, `delete_mcp_server`, and `test_mcp_server`.
- Approval event includes category, title, detail, session ID, and optional diff preview.
- Secret-bearing configuration accepts secret values only at save time and returns masked/no secret values on list.

- [ ] **Step 1: Write failing command-contract tests** for per-session load/save, no cross-session policy leakage, MCP CRUD, and masked secret round trips.
- [ ] **Step 2: Implement Tauri commands** that delegate to Store/Manager; do not execute provider or MCP traffic in the webview.
- [ ] **Step 3: Generalize pending-approval tracking** so request kind is preserved when activated, responded to, expired, or cancelled.
- [ ] **Step 4: Run Rust tests** and verify approval event serialization uses camelCase and old write events remain representable.

### Task 7: Compact mode, radio selection, and settings UI

**Files:** Modify `index.html`, `src/renderer/main.ts`, `src/renderer/sessions-view.ts`, `src/renderer/style.css`, `src/renderer/theme.css`, `tests/session-kind.test.mjs`; add renderer tests if needed.

**Interfaces:**
- `defaultPanelForKind` no longer returns a Mode panel; mode state remains `SessionKind`.
- Task/project rows render `<input type="radio">` with separate names for Work task and Code project groups.
- `AutoApprovePolicy` TypeScript shape mirrors the Rust camelCase response.

- [ ] **Step 1: Add failing tests** for compact mode defaults, Work/Code task/project radio selection, selected-project latest-session behavior, and deletion clearing stale active state.
- [ ] **Step 2: Add failing markup tests** for the top-bar Work/Code segmented control, no Mode sidebar entry, and right-aligned radio inputs.
- [ ] **Step 3: Replace the Mode panel** with a compact segmented control beside the session title; preserve Plan/Act and theme on the right.
- [ ] **Step 4: Render radio controls** on each Work task and Code project item; selection activates the corresponding session/project and cannot become multi-select.
- [ ] **Step 5: Restore the plain ⌘ welcome symbol without the dot**; keep app icon assets unchanged.
- [ ] **Step 6: Add the Auto-Approve Settings group** with five checkboxes, show checked defaults for new Code sessions, load/save per-session settings, and clearly label the consequences of auto-approved MCP calls.
- [ ] **Step 7: Add MCP server management controls** for local stdio name, executable, arguments, working directory, secret environment fields, enable/disable, test, and delete.
- [ ] **Step 8: Render typed approval prompts** for reads, web search, command details, MCP server/tool/arguments, and existing file diffs.
- [ ] **Step 9: Run targeted frontend tests and `tsc --noEmit`**; confirm all radio and permission state behavior passes.

### Task 8: Documentation, full verification, and delivery

**Files:** Modify `docs/work-code-modes.md`, `docs/sidebar-design.md`, `docs/progress.md`, and relevant PRD/security notes.

- [ ] **Step 1: Document** the top-bar mode control, exclusive task/project radios, per-session migration defaults, command sandbox limitations, local stdio MCP setup, and auto-approval consequences.
- [ ] **Step 2: Run `npm test`** and confirm all Rust and Node tests pass offline.
- [ ] **Step 3: Run `npm run lint`** and confirm ESLint, TypeScript, and Clippy pass.
- [ ] **Step 4: Run `npm run build`** and confirm Vite and Tauri release build pass with updated macOS helper entitlements and icons.
- [ ] **Step 5: Verify platform sandbox tests** on Windows, Linux, and macOS CI; an unavailable backend must report unsupported and never launch unsandboxed.
- [ ] **Step 6: Run `git diff --check`, review changed files, then make one version-stamped feature commit and push after all verification is green.**

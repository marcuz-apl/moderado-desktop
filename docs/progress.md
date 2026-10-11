# M1 Progress

- Inspected the clean `master` branch at the initial Tauri slice.
- Mapped M1 gaps against PRD section 9 and current Rust/UI code.
- Added the testable Rust agent runner, mock Gateway tests for approval, rejection, and Plan mode, and `/v1/models` discovery.
- Added search/edit tools, editable approval previews, per-mode model fields, and a configurable Gateway URL.
- Added a file-change check between preview and write after a failing race test.
- `npm test`: 28 Rust tests and 1 frontend test passed offline.
- `npm run lint`: ESLint, TypeScript, and Clippy passed.
- `npm run build`: Vite and Rust builds passed.
- `npm run dev` started Vite and the Tauri executable; stopped the development process after startup.
- Completed a read-only code review, fixed its provider timeout and stream-size findings, and reran test, lint, and build successfully.

## M2

- Added eight provider profiles with documented preset endpoints and editable Gateway/custom URLs.
- Added selected-provider settings without secrets, custom `/v1/models` validation before save, and startup probes for Ollama and LM Studio.
- Connected provider selection, per-provider model drafts, keychain lookup, model discovery, and turn execution in the UI.
- Added eight offline SSE fixtures and a shared end-to-end agent task test that exercises every profile.
- Full test, lint, build, and Tauri startup smoke checks passed.
- Review found a settings-load recovery issue and a provider-switch history leak; both were fixed. A settings parse error now surfaces while the app remains usable, and provider/URL changes start a fresh conversation.
- Reran verification after the privacy fix: 34 Rust tests, 1 frontend test, lint, and build passed. Tauri started successfully again.
- M2 implementation and review are complete; no live provider credentials were used.

## M3

- Added SQLite session records and histories in app data, with create, switch, rename, delete, and restart recovery.
- Added per-session turn and approval state, workspace turn serialization, and concurrent turns for separate workspaces.
- Added Git-backed checkpoints before approved writes, a visible diff preview, confirmed restore, and a safety checkpoint before restore.
- Review found that `git add` could execute configured clean filters. Replaced staging with direct blob hashing and index plumbing; a regression test uses a required filter command that must not run.
- Restore now attempts to roll back partial application, tracks executable bits on Unix, and records a context marker in every session sharing the workspace. The approval timeout starts when its dialog is shown, and expired approvals leave the UI queue.
- Offline tests, lint, build, and Tauri startup smoke checks passed.

## M4

- Added persistent one-time and recurring schedules with explicit write approval policies. Scheduled Act runs create a checkpoint before execution, and each approved write retains the normal checkpoint and workspace jail behavior.
- Claims prevent duplicate recurring runs while a prior run is active. Interrupted runs pause on restart and require a visible retry; provider or model changes pause schedules until recreated.
- Added Codex and Claude Code JSONL text import into a new persistent session, excluding tool payloads and thinking content.
- Added a per-session web search toggle, configurable API endpoint, and optional key stored in the OS keychain. The agent sees web search only when the endpoint is configured and search is enabled.
- Read-only review identified interrupted-run recovery, recurring backlog, startup approval delivery, and provider and search capability binding risks; fixes were applied. Search endpoints with a pre-existing `q` parameter are rejected.
- Final verification: 49 Rust tests and 1 frontend test passed offline; lint and build passed; Vite and the Tauri executable started successfully.

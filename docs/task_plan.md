# M1 Core Loop Plan

## Goal
Meet the PRD M1 exit criterion: an agent task completes end to end through Moderado Gateway compatible streaming, file tools, Plan/Act enforcement, and user approval, with offline tests green.

## Scope
- Configurable Gateway base URL and `/v1/models` discovery; stored key from OS keychain.
- Per-mode model selection with one conversation history.
- Read/list/search and write/edit file tools through the Rust dispatcher and workspace jail.
- Approval, rejection, and edited approval with a clear preview.
- Agent loop extraction and local mock-server integration tests for approved, rejected, and Plan-mode flows.
- Update UI and README; verify test, lint, build, and app startup.

## Out of scope for M1
Parallel/persistent sessions and checkpoints (M3); provider matrix (M2); scheduling/import (M4); arbitrary shell execution until a real command jail exists.

## Phases
1. Provider and agent-loop tests and implementation — complete
2. File tools and approval editing — complete
3. Gateway and per-mode UI wiring — complete
4. End-to-end verification and documentation — complete

## Errors encountered
- PowerShell does not accept `&&` in this environment; ran sequential commands instead.
- TypeScript flagged the first discovered model as possibly undefined; guarded the value.
- The approval race test caught an overwrite when a file changed during review; the dispatcher now rejects that write.
- Final review found stalled provider reads and unbounded SSE content; added idle timeouts and size limits with regression tests.

# M2 Provider Matrix Plan

## Goal
Support the PRD provider matrix through one OpenAI-compatible transport. A task with a streamed tool call should complete against every provider profile using offline fixtures; remote keys stay in the OS keychain.

## Scope
- Provider catalog for Moderado Gateway, NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama, LM Studio, and custom endpoints.
- Provider selection UI with editable Gateway/custom URLs, per-provider model choices, and local runtime availability probes.
- Custom endpoint validation against `/v1/models` before saving settings.
- Shared SSE/tool-call conformance fixtures and local mock-server agent runs for every profile.
- Verify offline tests, lint, build, and app startup.

## Phases
1. Provider catalog and conformance tests — complete
2. Settings, keychain, and local probes — complete
3. Provider selection UI and documentation — complete
4. Full verification and review — complete

## Verification
- `npm test`: 34 Rust and 1 frontend tests passed offline.
- `npm run lint`: ESLint, TypeScript, and Clippy passed.
- `npm run build`: frontend and Rust builds passed.
- `npm run dev`: Vite and the Tauri executable started.
- Live provider accounts were unavailable, so endpoint behavior was checked with local mock servers and eight SSE fixtures.

# M3 Sessions and Checkpoints Plan

## Goal
Meet the PRD M3 exit criterion: independent parallel sessions survive app restart, and a confirmed Git-backed rollback restores workspace files after a visible preview.

## Scope
- SQLite session records in the app-data directory, with names, workspace/provider binding, models, and conversation history.
- Multiple session runtimes with independent turn locks and approval requests; events carry session IDs.
- UI to create, switch, rename, and delete sessions, preserving each transcript while turns run concurrently.
- Git-backed checkpoint before each approved file mutation; reuse a workspace-root Git repository when available, otherwise use an app-data Git store.
- Checkpoint list, diff preview, and confirmed restore through the workspace jail.
- Offline tests for restart persistence, parallel isolation, checkpoint creation and rollback; lint, build, startup.

## Phases
1. SQLite session store and restart tests — complete
2. Session runtime and parallel UI — complete
3. Git checkpoints and restore preview — complete
4. End-to-end verification, review, docs — complete

## Verification

- `npm test`: 40 Rust and 1 frontend tests passed offline.
- `npm run lint`: ESLint, TypeScript, and Clippy passed.
- `npm run build`: frontend and Rust builds passed.
- `npm run dev`: Vite and the Tauri executable started.
- Checkpoint tests cover existing and separate Git stores, stale previews, user index preservation, and configured clean filters. An end-to-end test covers approved mutation, database reopen, and rollback.

# M4 Scheduling and Import Plan

## Goal

Meet the PRD M4 exit criterion: a recurring task runs while the app is open without intervention under an explicit auto-approval policy, and supported JSONL transcripts import into restart-safe sessions.

## Design

- Persist schedule definitions and run outcomes in the existing SQLite database. Poll due schedules from the Tauri runtime; claim each due run in SQLite before execution. Interrupted runs pause for explicit retry on restart.
- Reuse the manual turn path for scheduled runs, including workspace locks, provider/keychain handling, history persistence, tool dispatcher, and checkpoints. An explicit per-schedule approval preset controls whether writes prompt or auto-approve. A scheduled Act run gets a checkpoint before contacting the model.
- Import user and assistant text from Codex rollout JSONL and Claude Code session JSONL. Drop tool payloads and thinking blocks; reject empty/oversized input. Save into a new SQLite session bound to the selected workspace and current provider settings.
- Add schedule and import controls to the session UI, plus run-status and validation feedback. Keep all scheduling local to the desktop process.
- Add per-session web search settings, default enabled, backed by a user-configured API endpoint. Store optional keys in the OS keychain and expose the tool only when configured.

## Phases

1. SQLite schedule model, validation, claiming, and restart tests — complete
2. Shared scheduled turn execution and policy tests — complete
3. Transcript parsers and import tests — complete
4. UI, settings hardening, docs, full verification and review — complete

## Verification

- `npm test`: 49 Rust tests and 1 frontend test passed offline.
- `npm run lint`: ESLint, TypeScript, and Clippy passed.
- `npm run build`: frontend and Rust builds passed.
- `npm run dev`: Vite and the Tauri executable started; the development process was stopped after startup.
- Local mock tests cover unattended recurring writes with checkpoints, restart recovery, transcript parsing, web search, and schedule migration. A read-only review's scheduler and search binding findings were fixed.

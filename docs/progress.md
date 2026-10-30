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


## Activity Bar and Project Browser

- Added a VS Code inspired Activity Bar for Sessions, Workspace, Checkpoints, Schedules, and Source Control, with local Profile and Settings actions at the bottom.
- Grouped Connection and Web Search under Settings and preserved the existing per-session settings behavior.
- Added a lazy, read-only project tree and UTF-8 file preview through workspace-jailed Tauri commands.
- Added read-only Git branch, working tree, and 50-commit history views. Git inspection rejects repositories rooted outside the selected workspace.
- Settings now place API Key directly after Base URL, use dropdowns for Plan and Act models, and select the fixed Gateway Prod or Dev endpoint with Prod as the default.
- `npm test`: 54 Rust tests and 1 frontend test passed offline; `npm run lint` and `npm run build` passed.
- Playwright UI checks passed at 760 px for the sidebar and Gateway settings flows; `npm run dev` started Vite and the Tauri executable successfully.

## Appearance and Provider Setup Links

- Added a theme control beside the Plan/Act selector with Auto, Light, and Dark. Auto resolves from local time (light 07:00–18:59), re-resolves every minute and when the window regains focus, and persists the choice in `localStorage`. Light is a `:root[data-theme="light"]` override layer, so dark stays the default.
- Added the missing provider links in Settings. Moderado Gateway, NVIDIA NIM, and OpenRouter point at their key pages; Ollama and LM Studio point at their installer pages because neither local runtime needs a key. The link renders immediately right of the API key box and hides for a custom endpoint.
- Replaced the removed `@tauri-apps/api/shell` module with the Tauri opener plugin, and dropped the duplicated key-URL map so the URL comes from the Rust provider catalog instead of a second source in the renderer.
- Added `provider::tests::every_named_provider_links_to_a_key_or_install_page`, which fails if any named provider loses its https link or label, and pins the Moderado Gateway URL.
- Browser checks against the dev server: the theme control sits 10 px right of the Plan/Act group, Auto resolved to light at 11:00 local, Light and Dark persisted across reload, and all five providers showed their link 8 px right of the API key box.
- `npm test`: 58 Rust tests and 4 frontend suites passed offline; `npm run lint` and `npm run build` passed.

## Theme Toggle as an Icon

- Replaced the Auto/Light/Dark text buttons with a single sun/moon icon button beside the Plan/Act selector. The icon shows the current theme and the accessible name and tooltip name the theme it switches to.
- Auto is now the initial state rather than a visible option: with nothing saved, the theme resolves from local time (light 07:00–18:59) and re-checks every minute and on focus. The first click writes an explicit `light` or `dark` choice that persists across restarts.
- `oppositeTheme` moved into `theme.ts` so the toggle is covered by the offline unit tests.
- Browser check: 36x36 icon 10 px right of the Plan/Act group on the same row, no button text, initial state light at 12:15 with the sun icon, click flipped to the moon and persisted across reload, second click returned to light.
- `npm test`: 58 Rust tests and 4 frontend suites passed offline; `npm run lint` and `npm run build` passed.

## Versioning: Patch to 99, Minor on Request

- Commits no longer move the patch digit. The pre-commit hook advances only the daily build counter, so a docs or chore commit keeps the same semver and only `+YYMMDD<n>` changes.
- Added `npm run version:patch|minor|major` (scripts/bump-version.mjs), which moves the semver before a feature commit and mirrors the hook's single-digit rollover rules. The hook keeps the new semver and advances the counter.
- The message-driven bump is impossible in one pass: git writes the commit message after `pre-commit` runs, and index changes made in `prepare-commit-msg` or `commit-msg` stay staged without reaching the commit. Verified against this git build, so `prepare-commit-msg` now prints a reminder when a feat commit kept the semver instead of failing it.
- Policy: `npm run version:patch` advances the patch from 0 to 99 (0.4.9 → 0.4.10) and refuses past 99; minor and major move only when requested explicitly with `version:minor`/`version:major`. The hook's identifier check accepts a two-digit patch.
- `npm test`: 58 Rust tests and 6 versioning tests passed offline.

## Schema Migrations and Session Kind

- Added `src-tauri/src/db.rs` as the single owner of the SQLite schema. Every table is created there, changes are numbered migrations recorded in `PRAGMA user_version`, and each migration runs in a transaction.
- Migration 1 is the schema as it shipped before versioning, written with `IF NOT EXISTS` so an older database passes through unchanged. It also carries the former ad-hoc repair for `schedules.settings_json`, `search_json`, and `in_flight`, including the pause-and-review behaviour when a schedule predates those columns.
- Migration 2 adds `sessions.kind` with `DEFAULT 'code'`, so existing sessions read back as Code. `SessionKind` (`work` | `code`) is now on `SessionRecord` and `SessionSummary`, and `SessionStore::create_with_kind` writes it.
- `SessionStore`, `ScheduleStore`, and `SearchStore` no longer carry DDL; they open through `db::open`, which migrates once, and `db::connect`, which does not.
- Provider settings stay in `~/.moderado/config.json`. `$HOME` and `%USERPROFILE%` resolve to the same user folder, so the path is already correct on every platform; the code now documents that the location is deliberate.
- `cargo test --lib -- --test-threads=1`: 61 tests passed, including a fresh-database migration, a pre-versioning database that gains `kind` while keeping its rows, and an idempotent second open.

## Work and Code Modes with Attachments

- Added the Work/Code switch at the top of the Sessions panel. It filters the list and decides what **New session** creates; selecting a session of the other kind moves the switch.
- Work sessions get a private scratch folder under app-data instead of a folder picker, so every session still has a jailed root. The Workspace, Checkpoints, and Source Control icons, the Plan/Act selector, and the workspace context line are hidden while a Work session is active.
- Gated the tool surface by kind: a Work session is offered only `web_search`, and `dispatch_tool` rejects every file tool with `Work sessions have no file access` before it can reach the workspace. The write tools are now added only for Code sessions.
- Added `attachments.rs`: the composer's Attach button copies the chosen files into `<app-data>/attachments/<session>/`, rejecting anything over 256 KiB of text, 5 MB per image, 10 files, or 20 MB per message, and anything that is neither UTF-8 text nor a supported image. Deleting a session removes its copies.
- History stores an attachment reference block, expanded into text or an `image_url` data part only when the provider call is built, so `history_json` never carries base64. A missing copy degrades to a note instead of failing the turn.
- Migration 3 adds the `attachments` table; `cargo test --lib` covers the migration, the store caps, the expansion, the missing-file case, and the dispatch gate.
- Browser checks: a Work session hides three activity icons, Plan/Act, and the workspace line; chips render for two attached files; selecting a Code session restores every control. `npm test` frontend suites: 11 passed.
- The schedule dialog uses the selected session's kind: Work runs in Act mode and hides the write-approval choice and its hint; Code keeps both options.
- Work now opens by default. If no Work session exists, startup creates and selects `Documents/Moderado-Desktop/work-session0`; later Work sessions receive the next available numbered folder.
- The Sessions panel uses a single accessible Work/Code switch and labels the creation action for the selected mode. Workspace is labeled Projects, Source Control is labeled Git, the Profile panel distinguishes local Work profile from optional Code-mode GitHub identity, and Settings includes an About section with the full `VERSION+BUILD` value.
- GitHub sign-in remains unconfigured until a GitHub App client ID is registered and supplied to the build.

## M5 — Code Explorer panel (0.4.0)

- Revealed the Code Explorer activity panel in the sidebar by removing the `hidden` attribute from the workspace/folder activity button; the panel renders a nested project file tree with indentation, folder expanders, row selection, and a read-only file-preview dialog.
- Right-click context menu on any tree entry provides **New File**, **New Folder**, **Open**, **Rename**, and **Delete**, each confirmed server-side by the existing workspace-jail Rust commands (`list_project_entries`, `read_project_file`, `create_project_file`, `create_project_folder`, `rename_project_entry`, `delete_project_entry`).
- Path-escape and symlink guards reject any attempt to write outside the workspace root; invalid names (`.git`, `..`, etc.) are rejected before reaching the backend.
- Delete shows a confirmation dialog and clears selection/preview state for removed items; rename updates expanded-folder tracking and preserves selection on the renamed path.
- Verification: 95 Rust tests and 35 Node tests pass offline; `tsc --noEmit`, `eslint`, and `cargo clippy -D warnings` are clean; `npm run build` passes.

## Startup flash removed (0.4.x)

- The launch "white box inside a black box" was WebView2's default surface painting before the themed page: `tauri-runtime-wry` feeds the window config's `backgroundColor` to the webview via `with_background_color`, and falls back to white when it is unset.
- The main window now starts `visible: false` with `backgroundColor: "#0d1b2b"`, so no white surface is ever shown. The renderer reveals it after the themed first paint (`getCurrentWindow().show()` after a double rAF, with a 400 ms timer guard), and `core:window:allow-show` is granted.
- A 4 s Rust fallback in `setup` shows the window if the frontend never asks, so a webview load failure cannot leave the app invisible.
- Verification: `tsc --noEmit` and `cargo check` are clean; `npm run build` passes.

## Keyless Gateway models (0.4.x)

- The Moderado Gateway now serves two pinned stealth models to every connection without an API key. `discover_models` returns the full catalog with `access`, `capabilities`, and `section` metadata instead of bare ids, and sorts the pinned defaults (`section: "default"`) first.
- The provider catalog marks Moderado `keyless: true`. The renderer labels models **free, no key**, **free, key required**, or **paid**, preselects a stealth default, shows a "no key needed" hint under the API key field, and reports "N work without a key" after discovery.
- A keyless turn that picks a key-required model now explains the 401 ("this model needs a Moderado API key; the free stealth models work without one") instead of surfacing a raw status.
- Tests: `catalog_keeps_gateway_metadata_and_leads_with_pinned_defaults`, `only_moderado_is_keyless`, and `tests/models.test.mjs` (5 cases). `cargo check`, `tsc --noEmit`, and `npm run build` pass.

## MCP runtime (0.4.2)

- Stdio MCP servers are configured in `~/.moderado/mcp.json` (`servers[]` with `id`, `command`, `args`, `env`, `enabled`). `mcp.rs` spawns enabled servers per Code turn, performs the `initialize` / `tools/list` handshake over newline-delimited JSON-RPC 2.0, and exposes each tool as `mcp__<server>__<tool>`.
- Tools are advertised only to Code/Act sessions. Dispatch is gated by the `UseMcpServers` Auto-Approve category; Plan mode and Work sessions reject MCP calls before approval. A server that fails to start is recorded and skipped, never blocking the turn, and its process is killed when the turn ends (`kill_on_drop`).
- Settings gains an **MCP servers** section to edit the JSON config, save it, and discover tools; discovery reports both tools and per-server errors.
- Tests: `mcp.rs` covers config validation, public-name parsing, registry list/call, failing/unknown tools, and a broken server alongside a healthy one; runner tests cover auto-approved dispatch and the Plan-mode guard, all against a local Node mock server.

## MCP hardening (0.4.3)

- Added Streamable HTTP alongside stdio: `transport: "http"` with a `url`, POSTing JSON-RPC and accepting either `application/json` or `text/event-stream` responses; the `Mcp-Session-Id` header is carried forward.
- Added a per-server tool allow-list (`tools: ["echo"]`); omitting it still exposes every advertised tool.
- `discover_mcp_tools` now returns per-server status (connected, tool count, error) in addition to tools. Settings renders an add/edit/remove form with id, transport, command/URL, args, tools, and env, and **Test / reconnect** lists each server's tools by name so the allow-list is easy to fill.
- Tests: HTTP JSON + SSE round trip, allow-list filtering, per-server status, and HTTP/tool validation. Stop already cancels a hung call through the turn-level `tokio::select!`.

## Agent tool parity (0.4.5)

- Added `git_diff` (working tree against HEAD, falling back to the plain working-tree diff before the first commit, with untracked entries listed when there is no diff), `find_references` and `get_definition` (workspace text search; `get_definition` filters common declaration patterns), and `diagnostics` (language server).
- `git_diff` and the symbol searches are Code-only read tools under the Read files category; `diagnostics` is Code-only and spawns the language server matching the file extension.
- Added `lsp.rs` with a `~/.moderado/lsp.json` config (id, extensions, command, args, env, languageId), a `Content-Length` framed LSP client (`initialize`, `didOpen`, `publishDiagnostics`), and a registry that skips broken servers. Settings gains a Language Servers JSON editor.
- Tests: `git_diff` (tracked diff, untracked fallback, non-repository, path escape), the symbol tools, and LSP diagnostics against a Node mock server.

## Linux command sandbox (0.4.6)

- Added a Landlock backend in `command.rs`: the command runs in the workspace with read/execute on system paths and read/write on the workspace plus a private temp folder, and every other path is denied. It fails closed when Landlock is unavailable instead of running unsandboxed.
- `execute_command` is now advertised on Windows and Linux (x86_64/aarch64); macOS still fails closed.
- Added `.github/workflows/ci.yml` so `npm test` runs on Ubuntu and Windows, which compiles and exercises the Linux backend (WSL is unavailable in the local environment).
- Tests: a Linux-only test proves a command can write inside the workspace while an outside file stays unreadable.

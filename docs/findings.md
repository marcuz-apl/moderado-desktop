# M1 Findings

- Current Rust provider already streams SSE and assembles tool-call deltas, but only exposes chat completions.
- The UI defaults to Ollama; Moderado Gateway has no configured base URL or model-list flow.
- The loop is embedded in a Tauri command, making approval-to-finish behavior hard to test offline.
- Plan/Act uses one model input, and approval supports only accept/reject.
- Current file tools are list/read/write. PRD M1 specifies file tools and the P0 tool list also names search and edit.
- The user chose a configurable Gateway URL.

## M2

- M1 already has one OpenAI-compatible HTTP/SSE transport and keychain entries scoped by base URL.
- The provider matrix is currently a freeform URL field; only Ollama has a shortcut.
- The PRD M2 exit criterion requires the same task to run on each provider, streaming tool calls, and keychain storage.
- Official provider documentation confirms current OpenAI-compatible base URLs for NIM, OpenRouter, Ollama, and LM Studio; Gateway remains configurable.

## M3

- Current `Session` is a single in-memory object with one turn lock and approval slot. A provider switch clears its history, so no session can be resumed after restart.
- `run_turn` keeps a mutable history in memory; persistence must occur at safe message boundaries, including failed turns.
- File writes occur inside `dispatch_tool` immediately after approval. The checkpoint hook belongs between approval and write.
- SQLite is required by the PRD; `rusqlite` is the minimal direct dependency. Git CLI can provide object storage and refs without a new Git library.
# Activity Bar Research

- VS Code uses the Activity Bar on the outer edge to switch views in the Primary Side Bar. Account and Manage buttons normally sit at its bottom. Source Control has a distinct view and graph/history area. Moderado will use the same information architecture with its own visual style and local SVG icons.
- Existing `workspace::read_text` already enforces the workspace jail and a 256 KiB text limit. A new typed directory listing can reuse the same jailed root; no general file execution is needed.
- Existing checkpoints use Git internally, but Source Control must inspect only a repository rooted at the selected workspace so it does not read outside the workspace jail.

## Appearance and Provider Links

- The theme is applied by setting `data-theme` on the root element, so the light palette is a `:root[data-theme="light"]` override layer over the existing dark styles instead of a second stylesheet. The saved choice lives in `localStorage` and Auto uses local time with a 07:00–18:59 light window, which needs no permission and no network. Applying it from the module script means the first paint is dark; that flash is short on a local webview and was accepted rather than duplicating the time window in an inline boot script.
- Tauri v2 removed `@tauri-apps/api/shell`, so an external link cannot be opened from the renderer without a plugin. `tauri-plugin-opener` is the official replacement; its `opener:allow-open-url` permission plus the `opener:allow-default-urls` scope covers https links without granting filesystem reveal or arbitrary commands.
- The provider key URL belongs in the Rust catalog, not the renderer: `provider_catalog` already returns the preset list, so a second map in the renderer would be a second source of truth for provider data (AGENTS.md P4).
- Ollama and LM Studio have no key page for local use — the API key field is disabled for them — so their link points at the installer and is labelled per preset instead of saying "apply for API key".

## Schema Migrations and Versioning

- The schema had no version marker: tables were created with `CREATE TABLE IF NOT EXISTS` by whichever store opened the database first, and schedule columns were repaired with `PRAGMA table_info` checks inside `ScheduleStore::open`. That works once and does not extend, so `db.rs` now owns every table and records the applied version in `PRAGMA user_version`.
- `PRAGMA user_version` was chosen over a migration crate: it is one integer in the database header, needs no dependency, and every migration here is plain SQL. A migration library would add a dependency for behaviour that fits in about forty lines (Decision Ladder, N6).
- Version 1 has to be idempotent rather than conditional. An existing install reports `user_version = 0` while already holding the tables, so version 1 is written with `IF NOT EXISTS` and carries the old column repair. That lets one code path serve both a fresh database and a pre-versioning one, with no baseline detection branch.
- Staging inside `prepare-commit-msg` or `commit-msg` does not reach the commit: git freezes the tree after `pre-commit`. That is why the version bump stays in `pre-commit`, and why the patch digit moves through an explicit `npm run version:patch` rather than from the commit message.

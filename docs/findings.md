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
- Official provider documentation confirms current OpenAI-compatible base URLs for NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama, and LM Studio; Gateway remains configurable.

## M3

- Current `Session` is a single in-memory object with one turn lock and approval slot. A provider switch clears its history, so no session can be resumed after restart.
- `run_turn` keeps a mutable history in memory; persistence must occur at safe message boundaries, including failed turns.
- File writes occur inside `dispatch_tool` immediately after approval. The checkpoint hook belongs between approval and write.
- SQLite is required by the PRD; `rusqlite` is the minimal direct dependency. Git CLI can provide object storage and refs without a new Git library.
# Activity Bar Research

- VS Code uses the Activity Bar on the outer edge to switch views in the Primary Side Bar. Account and Manage buttons normally sit at its bottom. Source Control has a distinct view and graph/history area. Moderado will use the same information architecture with its own visual style and local SVG icons.
- Existing `workspace::read_text` already enforces the workspace jail and a 256 KiB text limit. A new typed directory listing can reuse the same jailed root; no general file execution is needed.
- Existing checkpoints use Git internally, but Source Control must inspect only a repository rooted at the selected workspace so it does not read outside the workspace jail.

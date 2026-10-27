Plan file identity: docs/superpowers/plans/2026-10-26-auto-approve-command-mcp.md

Rulings:
- Continue in the normal master checkout; no worktree migration is needed.
- All five Auto-Approve options default enabled for new Code sessions and for existing Code sessions that still have the previous defaults. Customized policies are preserved.
- MCP is a checked, disabled placeholder per the user's explicit scope update.
- Windows command execution uses AppContainer and fails closed on other platforms.

Progress:
- Added typed approval policy, schema version 5 migration, per-session persistence, and Settings controls.
- Enforced read, edit, web, and command policy in the Rust dispatcher with typed approval requests for unchecked operations; MCP remains unavailable.
- Added Windows disposable-workspace AppContainer command execution, checkpoint ordering, and sandbox tests.
- Moved Work/Code selection to the compact top bar and rendered task/project selection as radio buttons.
- Full tests pass: 86 Rust tests and 28 Node tests.
- `npm run lint` and `npm run build` both pass; release app built at `src-tauri/target/release/moderado-desktop.exe`.

# Office and document capability — deferred plan

> **Status**: design note, 2026-11-06. Nothing here is implemented. It records the sequencing decision made before the v0.4.49 release so the next session does not start at the wrong layer. See [PRD.md](./PRD.md) NG1 (marketplace deferred to v2) and the discussion about daily-work skills.

## The observed gap

A 12-day Spain itinerary came back as a good plan, but the request to turn it into PowerPoint slides produced an `.html` file instead of a `.pptx`. That is a capability gap, not a prompting gap.

The agent's current tool surface is text-only: `list_files`, `read_file`, `search_files`, `web_search`, `git_diff`, `find_references`, `get_definition`, `diagnostics`, `write_file`, `edit_file`, `execute_command`, plus configured MCP tools. `write_file` accepts a **UTF-8 string**, not bytes. The **Preview** panel renders a workspace file with `textContent` — it is not a viewer for HTML, images, PDFs or office files. `execute_command` can resolve any program on `PATH` (sandboxed and approval-gated), but it has no output contract, no artifact preview and no verification loop.

## Why a Skills page is not first

A skill is an instruction bundle: "for a deck, do X in this order". With today's tools, the instruction can only steer the model toward `write_file` (HTML) or an ad-hoc `execute_command` (whatever happens to be installed). Installing skills into that surface produces **better-looking HTML** — the same failure, with more ceremony. The blocker is the absence of a generator and a viewer, not the absence of a picker.

## Dependency order

1. **Artifact preview panel.** Render generated HTML, PDF, images and office files inside the app so an artifact is actually usable. Generated HTML must be inert: no scripts, no network, a strict CSP, and treated as untrusted content. Small, and it makes today's HTML output useful immediately.
2. **Typed generators with verification.** Rust commands such as `make_deck` / `render_deck` (and their document, sheet and chart counterparts) that emit real binary files into the workspace, plus a render-to-image step that feeds the result back to the model as images so it can check its own layout. The sandbox copy-back already streams and fingerprints bytes, so binary artifacts survive a sandboxed command.
3. **Skills layer.** `~/.moderado/skills/<name>/SKILL.md`, folder-scanned like `load_mcp_config`, with an explicit install / enable / pick UI. A skill names a workflow and the typed tools it needs; the app resolves them to commands it already owns. Work and Code scopes may need different defaults.
4. **Registry.** Only after 1–3. PRD NG1 defers a marketplace to v2, and a registry is a distribution and trust problem, not a capability one.

## Three product assumptions that break

- **Approval previews are text diffs.** A binary artifact has no meaningful text diff; approving it needs a rendered preview, not `old_text` / `new_text`.
- **Checkpoints are reviewed as text.** Git-backed snapshots handle binary bytes, but the restore review UI assumes text changes.
- **Generated artifacts are visible.** Today they are not. Without a viewer the user has to leave the app to check the result, and the model never sees what it produced.

## Security boundary

Skills are executable content, not documentation. Installing one is a trust decision with a prompt-injection surface: a skill must not be able to bypass the approval gate, widen the workspace jail, exfiltrate files through a provider call, or fetch remote instructions at run time. Skills should be local, reviewable text, versioned and explicitly enabled; no auto-install and no network fetch during a turn. This is the reason a registry comes last.

## Decision

v0.4.49 ships without a Skills page. Start at step 1 when work resumes, then step 2; revisit the Skills page only once a real artifact can be generated, previewed, approved and checkpointed. Until then, Work mode is a strong planner and a text-document editor, not an office suite.

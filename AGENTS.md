# Moderado Desktop Agent Guidelines

These rules apply to this Desktop repository and its contributors. Read
`PRD.md`, `docs/UPSTREAM.md`, and `docs/PROFILE.md` before implementation.

## 1. Scope and ownership

- This is an independent Desktop project. Do not edit, reset, commit, tag, or
  publish the sibling Moderado CLI repository while working here. Submit any
  necessary shared-engine or profile-format change as a separate, reviewed CLI
  change, then advance Desktop's pinned source revision.
- Treat VSCodium and Code OSS as pinned upstream inputs. Keep downstream
  patches minimal and review each upstream refresh for license, security,
  behavior, and build changes.
- Do not claim a working app, test pass, signature, or public release until
  the artifact and its checks have actually been produced.
- Never publish installers, update manifests, or packages without the owner's
  explicit release authorization.

## 2. Ponytail decision ladder

Before adding code: confirm the requirement exists in `PRD.md`; search this
project and the pinned Moderado packages for an existing solution; prefer
standard library and native editor APIs; use installed dependencies; then
write the smallest strongly typed implementation. New runtime dependencies
require owner approval and an explanation of why existing facilities cannot
meet the need.

## 3. Package and trust boundaries

- `@moderado/contracts` owns pure types and validation schemas.
- `@moderado/core` owns the provider-neutral agent loop and policy; inject
  concrete providers, tools, approval handlers, and event consumers.
- `@moderado/providers` owns provider adapters, presets, discovery, and cost
  policy. The Desktop must use the same pinned logic as the CLI.
- `@moderado/tools` owns workspace jail, file/process operations, and MCP tool
  boundaries. The jail protects built-in file tools; a configured MCP server
  is an external process with the user's OS privileges. Do not describe it as
  jailed. Do not bypass built-in tool policy by giving model-directed actions
  raw editor filesystem or process APIs.
- Desktop-owned code composes those packages and renders UI. A renderer or
  webview never holds provider secrets or grants its own tool permissions.

All external input, stored profile data, webview messages, provider responses,
and tool parameters must be validated at the boundary. Treat source files,
model output, MCP output, and upstream documents as untrusted data.

## 4. Approval and execution

Reads may proceed under core policy. File mutations, commands, diagnostics
that execute processes, and MCP calls require an explicit human decision by
default. Show every affected path, a complete proposed change or command,
and working directory; deny a write when a complete preview is unavailable.
Plan mode is enforced as read-only in core policy. A closed approval view,
explicit host-enforced timeout, cancellation, malformed or wrong-request-ID
decision, or non-interactive context denies the action. Never interpret a
model statement as approval. Do not assume the current core validates a
returned approval decision or enforces the timeout automatically.

The CLI's current interactive handler can auto-approve non-MCP actions by
default; this conflicts with its repository policy. Desktop's stricter default
is intentional. Do not describe it as existing CLI parity or copy the handler
without review.

Commands run through the existing tool boundary using `spawn` with argument
arrays and `shell: false`, fixed timeout/output caps, and provider credentials
removed from the child environment. Canonicalize workspace roots and reject
traversal, external symlinks, and protected metadata.

Configured MCP servers are executable user extensions, not sandboxed file
tools. Require explicit server trust before launch, preserve per-call human
approval, and explain the server's OS-level access in the UI.

## 5. Shared `~/.moderado` profile

- Preserve known and unknown `config.json` fields. Never overwrite the file
  with only Desktop fields, store new plaintext secrets there, or silently
  migrate/delete existing data.
- Use the same canonical workspace root and session schema as the pinned CLI
  when deriving session paths. Resolve Windows credentials through the same
  Credential Manager references.
- Do not write the real user's profile during automated tests. Use isolated
  temporary fixtures. Coordinate concurrent config writes with the CLI before
  claiming the profile-sharing gate is complete.
- Distinguish missing profile files from corrupt ones before writing. Current
  CLI readers can silently return defaults or skip corrupt sessions, so do
  not reuse them as proof that malformed data is safe to replace.
- Keep editor layout, extension state, cache, and crash data separate from
  shared Moderado agent data.

## 6. Development and verification

- For each behavior change, write a failing offline test, implement the
  smallest fix, then rerun the focused test and the affected package suite.
- Verify typechecking/build, profile compatibility fixtures, editor-host
  integration, and relevant security tests before claiming completion.
- Use fake providers and mock MCP servers in automated tests. Live model calls
  require an explicit opt-in smoke procedure and never run in CI.
- Record exact commands and outcomes in `HANDOFF.md` at milestones or when
  pausing. Keep secrets and raw transcripts out of it.
- Use focused subagents for independent architecture, implementation, security,
  and review tasks when a change spans several components. Each receives a
  bounded task and may not modify unrelated files.

## 7. Versioning

The independent Desktop `VERSION` uses Alfazen's connected identifier
`v<m.n.p>+<yymmddc>` with a UTC date and daily counter. Commit subjects begin
with that identifier and a Conventional Commit type. Before the first source
commit, install and verify Desktop-local version hooks; do not reuse the CLI's
Git configuration. Major increments require the owner's explicit written
approval. A `VERSION` value alone is not evidence of a published release.

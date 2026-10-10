# moderado-desktop Agent Guidelines (`AGENTS.md`)

> **Scope**: Guidelines and operating manual for AI coding agents and human contributors to `moderado-desktop`.
> **Product**: Cross-platform desktop app for autonomous coding agent sessions (see `PRD.md`).
> **Ecosystem**: Node.js / TypeScript / Electron

---

## 1. Core Engineering Philosophy: Minimalist Engineering

Follow the Decision Ladder:
1. **YAGNI**: If speculative or unrequested, do not write it.
2. **Reuse**: Check for existing utilities, contracts, or schemas before authoring new ones.
3. **Standard Library**: Prefer runtime built-ins over adding third-party dependencies.
4. **Safety**: Validate boundary inputs with schemas and handle errors explicitly. Never fail silently.

---

## 2. Directory Layout & Architecture

```
src/
  main/          # Electron main process: session lifecycle, scheduler, checkpoints, keychain
  agent/         # Agent loop, tool dispatcher, approval gate, Plan/Act mode enforcement
  providers/     # Provider adapters (see §4)
  workspace/     # Workspace jail, file tools, git/checkpoint integration
  renderer/      # UI: session tabs, chat, approval prompts, diffs, settings
  shared/        # Types, contracts, zod schemas shared across main/renderer
```

- **One tool dispatcher.** All tool calls flow through `agent/` — no tool may bypass the approval gate or workspace jail.
- **One provider contract.** All model access goes through `providers/`; never call provider HTTP APIs from UI or agent code directly.

## 3. Development Commands & Verification

- `npm test`: Run automated test suites (must pass offline)
- `npm run build`: Compile and build project artifacts
- `npm run lint`: Lint TypeScript

**Definition of done for any change**: typecheck clean, lint clean, tests green offline, relevant behavior covered by a test.

## 4. Provider Layer Rules

All providers are normalized to a single `ChatCompletion` contract (OpenAI-compatible core: `messages`, `tools`, `stream`, `usage`). One `OpenAICompatibleProvider` base; adapters only override what differs (base URL, auth header, model listing).

| Provider | Notes |
| --- | --- |
| Moderado Gateway | Default; org-scoped API key; model list from `/v1/models`. |
| NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter | OpenAI-compatible HTTPS + API key. |
| Ollama (`http://localhost:11434`), LM Studio (`http://localhost:1234`) | Local, no auth; probe availability at startup. |
| Custom endpoint | User-supplied base URL + optional key; validate against `/v1/models` before saving. |

Rules:
- **P1** — Streaming (SSE) is mandatory; reassemble streaming tool-call deltas into complete tool invocations before dispatch.
- **P2** — API keys live in the OS keychain, never in plaintext config, logs, or session transcripts.
- **P3** — Local providers must work fully offline; provider tests use recorded fixtures or a local mock server, never live endpoints.
- **P4** — Adding a provider = one adapter + fixture tests + model-list mapping. No provider-specific branches anywhere else in the codebase.

## 5. Agent Behavior & Tool Discipline

- **Plan/Act enforcement is structural, not prompt-based.** Plan mode blocks write/edit/run-command at the tool-dispatch layer. Prompt text alone is never a security boundary.
- Every mutating action (file write/edit, command execution) requires explicit user approval with a diff preview, unless a per-session auto-approval rule says otherwise. Defaults: reads auto-approved, writes and commands prompt.
- All filesystem and command operations are jailed to the session workspace root. Reject and report any path escape attempt explicitly.
- Never fail silently: failed or rejected tool calls must surface an explicit error to the model and the UI.
- Before fixing a bug, reproduce it and identify the root cause first (no blind patching). Prefer test-driven changes: failing test → minimal fix → green.

## 6. Data & State

- Session history: SQLite in the local app-data directory; sessions resumable after restart.
- Checkpoints: git-backed snapshots per workspace; created before the first mutating action of each agent step; restore requires confirmation with diff preview.
- No telemetry by default. No data leaves the machine except calls to explicitly configured remote providers.

## 7. Operational Boundaries & Security

- **Human-in-the-Loop**: All state mutations (file writes, edits, process executions) require interactive approval.
- **Workspace Jail**: Filesystem operations must remain inside the workspace jail. Never traverse outside the root.
- **Secrets**: Never hardcode API keys or endpoints; read from keychain/config at runtime. Never log secrets.
- **Offline Integrity**: Automated unit tests must run offline without external API requirements.
- **Dependencies**: Justify every new dependency against the Decision Ladder. No heavyweight frameworks without an approved PRD requirement behind them.

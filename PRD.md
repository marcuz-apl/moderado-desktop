# PRD — Moderado Desktop

> **Version**: 0.1 (Draft)
> **Status**: Proposed
> **Owner**: Moderado
> **Reference product**: Cline Desktop (open-source agent harness for open-weight models)

---

## 1. Summary

Moderado Desktop is a cross-platform desktop application that hosts autonomous AI coding agent sessions outside the IDE. It follows the interaction model proven by Cline Desktop — parallel sessions, Plan/Act dual modes, explicit tool approval, checkpoints, and a capability marketplace — while remaining **provider-agnostic** by default: Moderado Gateway (first-party) plus major OpenAI-compatible providers and local runtimes.

## 2. Problem

- IDE-bound agents couple agent state to a single editor window; users cannot run several tasks in parallel or schedule recurring work.
- Most agent UIs hard-bind to one vendor. Teams with a self-hosted gateway (Moderado Gateway) or local runtimes (Ollama, LM Studio) get second-class support.
- Agent work needs human control: reviewers must approve file mutations and commands before they execute.

## 3. Goals & Non-Goals

### Goals
1. G1 — Run multiple isolated agent sessions in parallel against any configured workspace folder.
2. G2 — First-class provider support: Moderado Gateway, NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama (local), LM Studio (local), and any generic OpenAI-compatible endpoint.
3. G3 — Plan/Act dual mode with independently configurable models per mode.
4. G4 — Human-in-the-loop approval for every state mutation (file write/edit, command execution), with per-session auto-approval rules.
5. G5 — Checkpoints: snapshot workspace state before mutating actions; support rollback.
6. G6 — Offline unit tests; no external API required for CI.

### Non-Goals (v1)
- NG1 — Marketplace/plugin ecosystem (defer to v2).
- NG2 — Cloud session sync or account system.
- NG3 — Multi-agent teams / orchestration.
- NG4 — Fine-tuning or model hosting (Moderado Gateway handles that upstream).

## 4. Users & Personas

| Persona | Need |
| --- | --- |
| Solo developer | Run refactors and research tasks side by side on local models. |
| Platform team | Point every seat at Moderado Gateway with org-approved models. |
| Privacy-conscious dev | Fully local loop: Ollama/LM Studio only, zero egress. |

## 5. Providers & Model Layer

All providers are normalized to one internal `ChatCompletion` contract (OpenAI-compatible core: `messages`, `tools`, `stream`, `usage`).

| Provider | Transport | Auth | Notes |
| --- | --- | --- | --- |
| Moderado Gateway | OpenAI-compatible HTTPS | API key (org-scoped) | Default provider; model list fetched from `/v1/models`. |
| NVIDIA NIM | OpenAI-compatible HTTPS | API key | `integrate.api.nvidia.com` base URL. |
| OpenRouter | OpenAI-compatible HTTPS | API key | Supports provider routing hints. |
| Agnes AI | OpenAI-compatible HTTPS | API key | |
| OrcaRouter | OpenAI-compatible HTTPS | API key | |
| Ollama (local) | OpenAI-compatible `http://localhost:11434` | none | Auto-detect running instance. |
| LM Studio (local) | OpenAI-compatible `http://localhost:1234` | none | Auto-detect running server. |
| Custom OpenAI-compatible | User-supplied base URL | Optional key | Validated against `/v1/models` before save. |

Requirements:
- R1 — Streaming (SSE) mandatory; tool-call deltas must reassemble into complete tool invocations.
- R2 — Per-mode model binding: separate model for Plan mode and Act mode, switchable on the fly.
- R3 — API keys stored in the OS keychain (never in plaintext config).
- R4 — Local providers must work with the app fully offline.

## 6. Functional Requirements

### 6.1 Sessions (P0)
- F1 — Create/delete/rename sessions; each session is bound to one workspace folder and one provider/model pair.
- F2 — Parallel sessions run concurrently in isolated contexts (separate conversation history, separate approval queue).
- F3 — Session history persisted locally (SQLite); resumable after restart.

### 6.2 Plan & Act Modes (P0)
- F4 — Plan mode: read-only tools (`read_file`, `list_files`, `search_files`, `get_definition`, `find_references`, web search). File writes and commands are blocked at the tool-dispatch layer, not by prompt alone.
- F5 — Act mode: full toolset subject to approval policy.
- F6 — Mode switch preserves full conversation context.
- F7 — Per-mode model override (see R2).

### 6.3 Tools & Approval (P0)
- F8 — Core toolset mirrors the agent runtime: read/list/search files, write/edit files, run command, diagnostics, git diff, web search.
- F9 — Every mutating tool call requires explicit user approval with diff preview before execution (Approve / Reject / Edit-then-approve).
- F10 — Auto-approval rules per session (e.g., auto-approve reads, always prompt for shell commands). Defaults: all reads auto, all writes and commands prompt.
- F11 — Workspace jail: filesystem and command operations constrained to the session's workspace root. No silent failures — every rejected or failed tool call surfaces an explicit error to the model.

### 6.4 Checkpoints (P1)
- F12 — Snapshot workspace state before the first mutating action of each agent step.
- F13 — Restore checkpoint (rollback files) with confirmation; diffs shown before restore.

### 6.5 Scheduled Tasks (P2)
- F14 — One-time and recurring task schedules (cron-like) that start a session with a given prompt and workspace.
- F15 — Scheduled runs obey the same approval policy; unattended runs must use explicit auto-approval presets or pause for approval.

### 6.6 Import & Extras (P2)
- F16 — Import conversation history from supported external agent formats (e.g., Claude Code, Codex session transcripts) into a new Moderado session.
- F17 — Optional web-search toggle per session (default on for new sessions).

## 7. Non-Functional Requirements

| ID | Requirement |
| --- | --- |
| N1 | Cross-platform: Windows, macOS, Linux (Electron + TypeScript). |
| N2 | First app launch usable with zero accounts; local providers reachable immediately. |
| N3 | Unit tests run offline; provider layer tested against recorded fixtures and a local mock server. |
| N4 | No telemetry by default. |
| N5 | Secrets never written to disk unencrypted; never echoed into logs or session transcripts. |
| N6 | Minimal dependency footprint (Decision Ladder: stdlib first, YAGNI). |

## 8. Architecture (Proposed)

```
src/
  main/          # Electron main process: sessions, scheduler, checkpoint store, keychain
  agent/         # Agent loop, tool dispatcher, approval gate, mode enforcement
  providers/     # One adapter per provider + shared OpenAI-compatible client
  workspace/     # Workspace jail, file tools, git integration
  renderer/      # UI: session tabs, chat, approval prompts, diffs, settings
  shared/        # Types, contracts, zod schemas shared across processes
```

- Session storage: SQLite (local app-data directory).
- Checkpoints: git-backed snapshots per workspace (reuse existing `.git` when present).
- Provider contract: single `Provider` interface + `OpenAICompatibleProvider` base; vendor adapters only override what differs (auth header, base URL, model listing).

## 9. Milestones

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| M1 — Core loop | Agent loop, Plan/Act enforcement, 1 provider (Moderado Gateway), file tools, approval gate | Task completes end-to-end with approvals, offline tests green |
| M2 — Provider matrix | NIM, OpenRouter, Agnes, OrcaRouter, Ollama, LM Studio, custom endpoint; streaming tool calls | Same task runs on each provider; keychain storage |
| M3 — Sessions & checkpoints | Parallel sessions, persistence, checkpoints/rollback | Restart-safe sessions; rollback verified |
| M4 — Scheduling & import | Scheduled tasks, transcript import, settings hardening | Recurring task runs unattended per policy |

## 10. Risks

- **Tool-call streaming variance** across OpenAI-compatible vendors — mitigate with a conformance fixture suite per provider (M2).
- **Unattended scheduled runs** increase blast radius — mitigate by requiring explicit auto-approval presets and checkpoint-before-run.
- **Local runtime drift** (Ollama/LM Studio versions) — mitigate with startup capability probe and clear error surfacing.

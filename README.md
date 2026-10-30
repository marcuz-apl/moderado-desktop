# Moderado Desktop

Cross-platform desktop application for running autonomous AI coding agent sessions outside the IDE. Built with Tauri, Rust, and TypeScript.

Moderado Desktop follows the Cline Desktop interaction model — parallel sessions, Plan/Act dual modes, explicit tool approval, and git-backed checkpoints — while remaining **provider-agnostic**: Moderado Gateway (first-party), NVIDIA NIM, OpenRouter, Ollama (local), LM Studio (local), and any generic OpenAI-compatible endpoint.

## Current build

The app supports persistent Work and Code sessions, schedules, transcript imports, Plan/Act mode, and the OpenAI-compatible provider matrix. Tasks and sessions have per-conversation Auto-Approve settings; Code starts with all five categories enabled; Work starts with read, edit, and web enabled, and you can turn any category off to require approval. File changes retain their diff preview. On Windows, commands run in a Windows AppContainer against a disposable copy of the project; only the resulting workspace changes are copied back. MCP servers configured in `~/.moderado/mcp.json` are available to Code/Act sessions through the Use MCP servers approval category. API keys remain in the OS keychain.

## Capabilities

- **Parallel sessions**: run multiple isolated agent sessions concurrently, each bound to its own workspace folder and provider/model.
- **Plan/Act dual mode**: Plan mode is strictly read-only; Act mode enables mutating tools. Each mode can use a different model.
- **Work and Code modes**: Work tasks own a conversation and a managed Documents folder for questions, attachments, and editable UTF-8 documents. Code projects own a chosen codebase folder with multiple independent sessions. Both use jailed file tools and checkpoints; Code also supports Plan/Act and Windows commands.
- **Appearance**: a sun/moon button beside the Plan/Act selector switches the theme. Until you click it, the theme follows local time — light from 07:00 to 18:59 — and re-checks while the app is open; after you choose, that choice sticks.
- **Project navigation**: New creates a named folder; Open registers an existing codebase. Sessions appear beneath each project. Deleting a session preserves the project; removing a project preserves its files and history for reopening. Mode switching restores its last conversation and unsent draft.
- **Per-session Auto-Approve**: Code sessions default to Read files, Edit files, Fetch web content, Execute command, and Use MCP servers enabled. Turn off read, web, edit, or command access to require a contextual approval; MCP tools are gated the same way.
- **Command sandbox**: Windows commands receive only a disposable AppContainer copy of the project, have bounded output and runtime, and cannot access files outside that copy. The app checks for concurrent workspace changes before copying results back.
- **Human-in-the-loop approval**: unchecked operations wait for approval; file changes include a diff preview. Scheduled Act tasks retain their explicit write-approval choice.
- **Checkpoints**: automatic git-backed snapshots before each mutating agent step; one-click rollback.
- **Local-first**: fully usable offline with Ollama or LM Studio; no accounts required at first launch.
- **No telemetry**: data never leaves your machine except to explicitly configured remote providers.

## Supported Providers

| Provider | Transport | Auth |
| --- | --- | --- |
| Moderado Gateway (default) | OpenAI-compatible HTTPS | Optional — two free stealth models work keyless; a key unlocks the full catalog |
| NVIDIA NIM | OpenAI-compatible HTTPS | API key |
| OpenRouter | OpenAI-compatible HTTPS | API key |
| Ollama (local) | `http://localhost:11434` | none |
| LM Studio (local) | `http://localhost:1234` | none |
| Custom | User-supplied base URL | optional key |

All providers normalize to a single `ChatCompletion` contract. API keys are stored in the OS keychain and never written to plaintext config or logs. Every provider in Settings links to where you get it: a key page for Moderado Gateway, NVIDIA NIM, and OpenRouter, and an installer page for the local Ollama and LM Studio runtimes, which need no key. The Moderado Gateway also serves two pinned stealth models without any key; they lead the model list tagged **free, no key**, while its other free routes still require a key.

## Getting Started

Prerequisites: Node.js ≥ 20, npm, Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/marcuz-apl/moderado-desktop.git
cd moderado-desktop
npm install
```

### Development

```bash
npm run dev     # start in watch mode
npm test        # run Rust and frontend tests (offline)
npm run lint    # ESLint, TypeScript, and Clippy
npm run build   # build the standalone app at src-tauri/target/release/moderado-desktop.exe
```

Create a session to choose its workspace folder, then select a provider in Settings. Moderado Gateway uses Prod Mode by default and can switch to Dev Mode; custom providers accept a base URL. A Moderado key is optional — the two free stealth models work without one. Load available models (the keyless stealth models are preselected and tagged **free, no key**; other free routes show **free, key required**), select Plan and Act models, and send a task. Local Ollama and LM Studio need a running server and no key. The provider choice and models are saved with the session when you send a task. You can switch sessions while a turn runs in another session. Turns sharing one workspace run in sequence to keep checkpoints and conversation context consistent.

Each approved file write or edit creates a checkpoint of the workspace before applying the change. Select a checkpoint to review file differences, then confirm restore. Restore creates a safety checkpoint of the current workspace first. Git is required for checkpoints; the app uses the workspace's Git repository when the workspace is its root, or a separate Git store in app data otherwise. Checkpoint snapshots include nonignored workspace files, so inspect the restore preview before confirming.

To schedule a task, save the session's provider and models by sending a task, then choose **Schedule task**. Set the first run time, optionally enter a repeat interval in minutes, and select Plan or Act mode. **Ask me** is the default write policy; choose **Auto-approve writes** explicitly for unattended Act work. If the app is closed at a due time, it claims the overdue occurrence on the next launch. A repeating schedule skips missed intervals and advances to its next future time. Interrupted runs pause for review and can be retried. A schedule pauses if its provider, models, or web search settings change; recreate it to authorize the new settings. Delete a schedule to stop future runs.

Web search is enabled by default per session, but unavailable until you save a search API endpoint. In **Web search**, enter an HTTPS endpoint (or a loopback HTTP endpoint) and optionally an API key, which stays in the OS keychain. The API must accept `GET endpoint?q=term` and return JSON such as `{"results":[{"title":"Result","url":"https://example.com","snippet":"Summary"}]}`. Disable the checkbox to remove web search from that session's agent tools. Search requests go only to the configured endpoint.

To import an existing conversation, select a session for the workspace, choose **Import transcript**, and select a Codex or Claude Code JSONL file. Moderado creates a new session containing user and assistant text. Tool outputs, thinking blocks, and metadata are excluded. Imported text becomes context for the selected provider when you send the next task.

Changing the provider or its base URL starts a new conversation on the next task, so earlier local context is never sent to a newly selected remote provider. Switching between Plan and Act keeps the current conversation.

The provider profiles use the same OpenAI-compatible streaming transport. Their preset URLs follow the providers' published API documentation: [NVIDIA NIM](https://docs.api.nvidia.com/nim/reference/llm-apis), [OpenRouter](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), and [LM Studio](https://lmstudio.ai/docs/developer/openai-compat). Some models may not support tool calls even if their provider accepts the API format; choose a tool-capable model for agent tasks.

## Architecture

```
src-tauri/src/
  lib.rs       # Tauri commands, session runtimes, approval bridge
  agent.rs     # Tool dispatcher and Plan/Act enforcement
  agent/runner.rs # Agent loop and conversation history
  provider.rs  # Provider catalog and OpenAI-compatible streaming client
  provider/settings.rs # Local provider settings without secrets
  db.rs        # Schema ownership, numbered migrations, and connection setup
  sessions.rs  # SQLite sessions, histories, and checkpoint metadata
  schedules.rs # Persistent schedules and due-run claiming
  search.rs    # Per-session search settings and configured API client
  transcript.rs # Codex and Claude Code JSONL text import
  checkpoints.rs # Git snapshots, diff preview, and restore
  workspace.rs # Workspace jail and file operations
src/renderer/  # TypeScript UI and styles
```

- Session storage: SQLite in the local app-data directory
- Schema: `db.rs` owns every table and applies numbered migrations recorded in `PRAGMA user_version`, so an upgrade carries existing sessions forward instead of recreating the database
- Checkpoints: Git-backed snapshots per workspace, with a separate index to preserve the user's staged changes
- Provider access stays in Rust; the webview cannot call file tools or provider HTTP APIs directly
- `cap-std` keeps file operations relative to the chosen workspace, including when symlinks change during a turn
- Appearance: `theme.ts` resolves the Auto mode from local time, the renderer sets `data-theme` on the root element, and `theme.css` supplies the light palette; the saved choice lives in `localStorage`
- External links open through the Tauri opener plugin, so the webview never navigates away from the app

## Documentation

- [PRD](./docs/PRD.md) — full product specification, functional and non-functional requirements
- [Work and Code modes](./docs/work-code-modes.md) — design for the two session kinds and attachments
- [Milestone plan](./docs/task_plan.md) — implementation scope and verification for each milestone
- [Progress notes](./docs/progress.md) — completed work and review outcomes
- [Findings](./docs/findings.md) — implementation research and decisions
- [AGENTS.md](./AGENTS.md) — coding guidelines and operating manual for AI agents and contributors

## Contributing

See [AGENTS.md](./AGENTS.md) for engineering philosophy, provider-layer rules, and security boundaries. All changes require passing typecheck, lint, and offline tests.

## License

Proprietary — all rights reserved.

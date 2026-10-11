# Moderado Desktop

Cross-platform desktop application for running autonomous AI coding agent sessions outside the IDE. Built with Tauri, Rust, and TypeScript.

Moderado Desktop follows the Cline Desktop interaction model — parallel sessions, Plan/Act dual modes, explicit tool approval, and git-backed checkpoints — while remaining **provider-agnostic**: Moderado Gateway (first-party), NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama (local), LM Studio (local), and any generic OpenAI-compatible endpoint.

## Current build

M3 supports multiple sessions with independent conversations and per-session provider settings. Sessions and histories are saved in SQLite under the app-data directory and reload after restart. Sessions in separate workspaces can run concurrently. Approved writes create Git-backed checkpoints before changing files; the checkpoint list offers a diff preview and confirmed restore. The app also supports Plan/Act mode and the OpenAI-compatible provider matrix: Moderado Gateway, NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama, LM Studio, and a custom endpoint. API keys stay in the OS keychain. Command execution remains planned work.

## Planned features

- **Parallel sessions**: run multiple isolated agent sessions concurrently, each bound to its own workspace folder and provider/model.
- **Plan/Act dual mode**: Plan mode is strictly read-only; Act mode enables mutating tools. Each mode can use a different model.
- **Human-in-the-loop approval**: every file write, edit, or command execution requires explicit approval with a diff preview.
- **Checkpoints**: automatic git-backed snapshots before each mutating agent step; one-click rollback.
- **Local-first**: fully usable offline with Ollama or LM Studio; no accounts required at first launch.
- **No telemetry**: data never leaves your machine except to explicitly configured remote providers.

## Supported Providers

| Provider | Transport | Auth |
| --- | --- | --- |
| Moderado Gateway (default) | OpenAI-compatible HTTPS | API key (org-scoped) |
| NVIDIA NIM | OpenAI-compatible HTTPS | API key |
| OpenRouter | OpenAI-compatible HTTPS | API key |
| Agnes AI | OpenAI-compatible HTTPS | API key |
| OrcaRouter | OpenAI-compatible HTTPS | API key |
| Ollama (local) | `http://localhost:11434` | none |
| LM Studio (local) | `http://localhost:1234` | none |
| Custom | User-supplied base URL | optional key |

All providers normalize to a single `ChatCompletion` contract. API keys are stored in the OS keychain and never written to plaintext config or logs.

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
npm run build   # compile frontend and Rust app
```

Create a session to choose its workspace folder, then select a provider. Moderado Gateway and custom providers require a base URL; the other profiles fill in their documented endpoints. Enter a key if needed, load available models, select Plan and Act models, and send a task. Local Ollama and LM Studio need a running server and no key. The provider choice and models are saved with the session when you send a task. A Gateway URL is required because there is no canonical URL configured in the app. You can switch sessions while a turn runs in another session. Turns sharing one workspace run in sequence to keep checkpoints and conversation context consistent.

Each approved file write or edit creates a checkpoint of the workspace before applying the change. Select a checkpoint to review file differences, then confirm restore. Restore creates a safety checkpoint of the current workspace first. Git is required for checkpoints; the app uses the workspace's Git repository when the workspace is its root, or a separate Git store in app data otherwise. Checkpoint snapshots include nonignored workspace files, so inspect the restore preview before confirming.

Changing the provider or its base URL starts a new conversation on the next task, so earlier local context is never sent to a newly selected remote provider. Switching between Plan and Act keeps the current conversation.

The provider profiles use the same OpenAI-compatible streaming transport. Their preset URLs follow the providers' published API documentation: [NVIDIA NIM](https://docs.api.nvidia.com/nim/reference/llm-apis), [OpenRouter](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [Agnes AI](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/MODEL_CATALOG.md), [OrcaRouter](https://www.orcarouter.ai/switch/openrouter), and [LM Studio](https://lmstudio.ai/docs/developer/openai-compat). Some models may not support tool calls even if their provider accepts the API format; choose a tool-capable model for agent tasks.

## Architecture

```
src-tauri/src/
  lib.rs       # Tauri commands, session runtimes, approval bridge
  agent.rs     # Tool dispatcher and Plan/Act enforcement
  agent/runner.rs # Agent loop and conversation history
  provider.rs  # Provider catalog and OpenAI-compatible streaming client
  provider/settings.rs # Local provider settings without secrets
  sessions.rs  # SQLite sessions, histories, and checkpoint metadata
  checkpoints.rs # Git snapshots, diff preview, and restore
  workspace.rs # Workspace jail and file operations
src/renderer/  # TypeScript UI and styles
```

- Session storage: SQLite in the local app-data directory
- Checkpoints: Git-backed snapshots per workspace, with a separate index to preserve the user's staged changes
- Provider access stays in Rust; the webview cannot call file tools or provider HTTP APIs directly
- `cap-std` keeps file operations relative to the chosen workspace, including when symlinks change during a turn

## Documentation

- [PRD](./docs/PRD.md) — full product specification, functional and non-functional requirements
- [Milestone plan](./docs/task_plan.md) — implementation scope and verification for each milestone
- [Progress notes](./docs/progress.md) — completed work and review outcomes
- [Findings](./docs/findings.md) — implementation research and decisions
- [AGENTS.md](./AGENTS.md) — coding guidelines and operating manual for AI agents and contributors

## Contributing

See [AGENTS.md](./AGENTS.md) for engineering philosophy, provider-layer rules, and security boundaries. All changes require passing typecheck, lint, and offline tests.

## License

Proprietary — all rights reserved.

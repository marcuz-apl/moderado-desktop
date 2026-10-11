# Moderado Desktop

Cross-platform desktop application for running autonomous AI coding agent sessions outside the IDE. Built with Tauri, Rust, and TypeScript.

Moderado Desktop follows the Cline Desktop interaction model — parallel sessions, Plan/Act dual modes, explicit tool approval, and git-backed checkpoints — while remaining **provider-agnostic**: Moderado Gateway (first-party), NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama (local), LM Studio (local), and any generic OpenAI-compatible endpoint.

## Current build

The first runnable slice supports one in-memory workspace session, Plan/Act mode, streaming from an OpenAI-compatible endpoint, workspace file listing and reading, and approval before each file write. The Rust dispatcher enforces Plan mode and checks paths against the selected workspace. API keys are stored in the OS keychain. Persistent sessions, commands, checkpoints, and the full provider matrix remain planned work.

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
npm test        # run Rust tests (offline)
npm run lint    # ESLint, TypeScript, and Clippy
npm run build   # compile frontend and Rust app
```

Choose a workspace, enter an OpenAI-compatible endpoint and model, then send a task. The default endpoint is `http://localhost:11434/v1` for Ollama. For a remote provider, enter its HTTPS `/v1` endpoint and API key. The key is saved in the OS keychain for that endpoint. Checkpoints are not yet implemented.

## Architecture

```
src-tauri/src/
  lib.rs       # Tauri commands, in-memory session, approval bridge
  agent.rs     # Tool dispatcher and Plan/Act enforcement
  provider.rs  # OpenAI-compatible streaming client
  workspace.rs # Workspace jail and file operations
src/renderer/  # TypeScript UI and styles
```

- Planned session storage: SQLite in the local app-data directory
- Planned checkpoints: git-backed snapshots per workspace
- Provider access stays in Rust; the webview cannot call file tools or provider HTTP APIs directly
- `cap-std` keeps file operations relative to the chosen workspace, including when symlinks change during a turn

## Documentation

- [PRD](./PRD.md) — full product specification, functional and non-functional requirements
- [AGENTS.md](./AGENTS.md) — coding guidelines and operating manual for AI agents and contributors

## Contributing

See [AGENTS.md](./AGENTS.md) for engineering philosophy, provider-layer rules, and security boundaries. All changes require passing typecheck, lint, and offline tests.

## License

Proprietary — all rights reserved.

# Moderado Desktop

Cross-platform desktop application for running autonomous AI coding agent sessions outside the IDE.

Moderado Desktop follows the Cline Desktop interaction model — parallel sessions, Plan/Act dual modes, explicit tool approval, and git-backed checkpoints — while remaining **provider-agnostic**: Moderado Gateway (first-party), NVIDIA NIM, OpenRouter, Agnes AI, OrcaRouter, Ollama (local), LM Studio (local), and any generic OpenAI-compatible endpoint.

## Features

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

Prerequisites: Node.js ≥ 20, npm.

```bash
git clone https://github.com/marcuz-apl/moderado-desktop.git
cd moderado-desktop
npm install
```

### Development

```bash
npm run dev     # start in watch mode
npm test        # run test suites (offline)
npm run build   # compile production artifacts
```

For local providers, make sure Ollama or LM Studio is running before starting the app. For remote providers, add your API key in **Settings → Providers** on first launch.

## Architecture

```
src/
  main/        # Electron main process: sessions, scheduler, checkpoints, keychain
  agent/       # Agent loop, tool dispatcher, approval gate, Plan/Act enforcement
  providers/   # Provider adapters + shared OpenAI-compatible client
  workspace/   # Workspace jail, file tools, git integration
  renderer/    # UI: session tabs, chat, approval prompts, diffs, settings
  shared/      # Types, contracts, zod schemas shared across processes
```

- Session storage: SQLite (local app-data directory)
- Checkpoints: git-backed snapshots per workspace
- Provider contract: one `Provider` interface + `OpenAICompatibleProvider` base; vendor adapters override only what differs

## Documentation

- [PRD](./PRD.md) — full product specification, functional and non-functional requirements
- [AGENTS.md](./AGENTS.md) — coding guidelines and operating manual for AI agents and contributors

## Contributing

See [AGENTS.md](./AGENTS.md) for engineering philosophy, provider-layer rules, and security boundaries. All changes require passing typecheck, lint, and offline tests.

## License

Proprietary — all rights reserved.

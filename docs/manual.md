## Getting started

Moderado Desktop runs coding and document sessions against the model provider you choose. Everything stays on this machine except the calls you configure.

### 1. Connect a model

Open **Settings** from the gear icon.

- **Provider** — pick a preset (Moderado Gateway, NVIDIA NIM, OpenRouter) or a local runtime (Ollama, LM Studio).
- **API key** — stored in the OS keychain, never in a config file or the transcript.
- **Models** — choose a Plan model and an Act model. Use **Load models** to read the provider's list.

Ollama and LM Studio need no key and work offline.

### 2. Choose a mode

The Work/Code switch sits in the top bar.

| Mode | What it is for | What it can do |
| --- | --- | --- |
| **Work** | Questions, notes, documents | Reads, writes, and edits files inside a managed task folder. No commands. |
| **Code** | A real project folder | Everything Work does, plus Plan/Act, Git inspection, diagnostics, and sandboxed commands. |

Work tasks and Code projects both appear in the **Library** panel on the left.

### 3. Send a task

Type in the composer and press **Enter**. Use **Shift+Enter** for a new line, and the **↑** / **↓** arrows to walk back through what you already sent.

The agent works in steps. Each step that changes files waits for your approval unless that category is auto-approved.

### 4. Review what it did

- **Checkpoints** lists every snapshot taken before a change; open one to see a diff and roll back.
- **Explorer** shows the files in the current task or project.
- **Git** (Code only) shows the branch, changed files, and recent commits.

### 5. Bring files into the conversation

- **+** attaches a file. In Work the file is copied into the task folder so the agent can edit it; in Code its content is sent without touching your repository.
- **@** references a project file by path. Type `@` and keep typing to filter, or press the **@** button.

### 6. Run something later

**Schedule task** runs a prompt at a set time or on a repeat interval. Choose **Auto-approve writes** only for unattended Act work; the agent then edits without asking. A schedule pauses if the session's provider or models change.

## Reference

### Preview and terminal

Two icons at the top right open a panel beside the conversation:

- **Preview** shows the file you selected in Workspace files, read-only.
- **Terminal** is a real shell in the project folder (Code only).

The terminal is your own shell — the Windows PowerShell, or `$SHELL` elsewhere — running as your user, outside the agent's sandbox. That is the point of it: the agent's commands stay sandboxed and approval-gated, while the terminal is you typing. It keeps running when you switch views or close the panel, and restarts when you open a different project.

### Keyboard

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `↑` / `↓` | Previous / next sent prompt |
| `Esc` | Dismiss the file picker |
| `/btw` | Ask a side question without derailing the task |

### Settings fields

| Field | What it does |
| --- | --- |
| **Provider** | Chooses the preset or local runtime; **Base URL** overrides the endpoint. |
| **Plan model** / **Act model** | The model used to plan, and the one that executes. |
| **Theme** | Auto follows local time (light 07:00–18:59); Light and Dark pin it. |
| **Display size** | Zooms the whole window from 90% to 150%. |
| **MCP servers** | Stdio or Streamable HTTP servers exposed as tools in Code/Act sessions. |
| **Language servers** | LSP entries that power the `diagnostics` tool. |

### Git

Commit and Push live in the **Changes** tab and are available in **Code** sessions only — a Work task folder is a managed directory, not a repository.

- **Commit all changes** stages everything (`git add -A`) and commits with your message. It uses the identity in your git config.
- **Push** pushes the current branch, creating an upstream on the first push.
- The panel tells you before you try: *Push ready* when this machine can reach the remote, or what to fix when it cannot.

There is no GitHub sign-in inside the app. Push uses the credentials your machine already has — an SSH key registered with GitHub, Git Credential Manager, or `gh auth login`. The app never asks for a GitHub password and never stores a GitHub token.

### Where your data lives

- Sessions, checkpoints, and schedules: a SQLite file in the app data directory.
- API keys: the OS keychain.
- Attachments: the app data directory, with editable copies inside Work task folders.

No telemetry is sent anywhere.

### If something looks wrong

- **"Enter an endpoint, choose a model"** — Settings is missing a provider URL or model.
- **A turn stops early** — the agent hit its step limit; send `continue` to keep going from where it stopped.
- **A tool was refused** — check the Auto-approve row above the composer; that category is set to ask first.
- **A page of the manual looks wrong** — this file is `docs/manual.md`; edit it and rebuild.

## License

This repository carries no license file, so all rights are reserved by the author: nothing here grants permission to copy, modify, or redistribute the application or its source.

Moderado Desktop builds on third-party components that keep their own licenses — Tauri and the Rust crates listed in `src-tauri/Cargo.toml`, and MarkdownIt, which renders this page, listed in `package.json`. Each dependency ships with its own license text in its package.

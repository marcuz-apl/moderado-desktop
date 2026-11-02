# Getting started

Moderado Desktop runs coding and document sessions against the model provider you choose. Everything stays on this machine except the calls you configure.

## 1. Connect a model

Open **Settings** from the gear icon.

- **Provider** — pick a preset (Moderado Gateway, NVIDIA NIM, OpenRouter) or a local runtime (Ollama, LM Studio).
- **API key** — stored in the OS keychain, never in a config file or the transcript.
- **Models** — choose a Plan model and an Act model. Use **Load models** to read the provider's list.

Ollama and LM Studio need no key and work offline.

## 2. Choose a mode

The Work/Code switch sits in the top bar.

| Mode | What it is for | What it can do |
| --- | --- | --- |
| **Work** | Questions, notes, documents | Reads, writes, and edits files inside a managed task folder. No commands. |
| **Code** | A real project folder | Everything Work does, plus Plan/Act, Git inspection, diagnostics, and sandboxed commands. |

Work tasks and Code projects both appear in the **Library** panel on the left.

## 3. Send a task

Type in the composer and press **Enter**. Use **Shift+Enter** for a new line, and the **↑** / **↓** arrows to walk back through what you already sent.

The agent works in steps. Each step that changes files waits for your approval unless that category is auto-approved.

## 4. Review what it did

- **Checkpoints** lists every snapshot taken before a change; open one to see a diff and roll back.
- **Explorer** shows the files in the current task or project.
- **Git** (Code only) shows the branch, changed files, and recent commits.

## 5. Bring files into the conversation

- **+** attaches a file. In Work the file is copied into the task folder so the agent can edit it; in Code its content is sent without touching your repository.
- **@** references a project file by path. Type `@` and keep typing to filter, or press the **@** button.

## 6. Run something later

**Schedule task** runs a prompt at a set time or on a repeat interval. Choose **Auto-approve writes** only for unattended Act work; the agent then edits without asking. A schedule pauses if the session's provider or models change.

## Keyboard

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `↑` / `↓` | Previous / next sent prompt |
| `Esc` | Dismiss the file picker |

## Where your data lives

- Sessions, checkpoints, and schedules: a SQLite file in the app data directory.
- API keys: the OS keychain.
- Attachments: the app data directory, with editable copies inside Work task folders.

No telemetry is sent anywhere.

## If something looks wrong

- **"Enter an endpoint, choose a model"** — Settings is missing a provider URL or model.
- **A turn stops early** — the agent hit its step limit; send `continue` to keep going from where it stopped.
- **A tool was refused** — check the Auto-approve row above the composer; that category is set to ask first.

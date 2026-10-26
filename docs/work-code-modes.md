# Work and Code Modes Design

## Intent

Split the product into two top-level modes.

**Work** answers general questions for people who are not working in a codebase. It has no project folder and never browses the disk. It reads the files the user hands it — text and images — the way WorkBuddy Desktop does: attach a file to the message, the assistant reads that file.

**Code** is the current product: an agent bound to a project folder the user must define, with autonomous file tools, approvals, checkpoints, and source control.

Work and Code describe *what a session is allowed to touch*. Plan and Act, already shipped, describe *what the agent may change inside that boundary*. Plan/Act is meaningful only in Code; a Work session has no mutation path at all.

## The two axes

| Axis | Values | Chosen | Meaning | Enforced in |
| --- | --- | --- | --- | --- |
| Session kind | `work`, `code` | Once, when the session is created | Whether the session has a project folder and autonomous file tools | Session record, tool list, dispatch gate |
| Agent mode | `plan`, `act` | Per turn, Code sessions only | Whether mutating tools are offered | `agent::dispatch_tool`, unchanged |

## What differs

| Capability | Work | Code |
| --- | --- | --- |
| Project folder | None | Required, picked by the user |
| Reading the disk on its own | Never | Yes, jailed to the workspace |
| Reading user-attached files | Yes — text and images | Not in the first cut |
| `list_files`, `read_file`, `search_files` tools | Not offered | Offered |
| `write_file`, `edit_file` | Never | Act only, with approval |
| Checkpoints | Never created | Before each mutating step |
| Workspace and Source Control panels | Hidden | Shown |
| Plan/Act selector | Hidden; always read-only | Shown |
| Web search | Offered when configured | Offered when configured |
| Schedules | Allowed; no write policy to choose | Allowed; policy as today |
| Transcript import | Allowed | Allowed |

The difference is **who chooses the file**. In Code the agent decides what to open inside a folder the user already trusted. In Work the user decides, message by message, and nothing else on disk is reachable.

## Attachments in Work

Modelled on WorkBuddy Desktop: a paperclip button, drag and drop, and paste all add files to the current message. Each one appears as a chip with its name, kind, and size, and can be removed before sending. Sending moves the chips into the transcript next to the message they belong to.

- **Text-like files** (`.txt`, `.md`, `.json`, `.csv`, `.log`, source files, and anything that decodes as UTF-8) are read and placed in the message as text, fenced with the file name so the model can cite it. A file over the limit is rejected with a message naming the limit; it is never silently cut.
- **Images** (`.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`) are sent as image parts, not OCR'd, so a vision-capable model can look at them. The model must support images; when it does not, the provider's error is surfaced as-is with a hint to pick a vision model, because model capability cannot be inferred reliably from `/v1/models`.
- **Anything else** is rejected with a clear message rather than sent as garbage bytes.

Limits for the first cut: 256 KiB per text file (the same bound the workspace reader already uses), 5 MB per image, at most 10 attachments per message, 20 MB per message in total. Exceeding any of them is an explicit error.

## Data model

- `SessionRecord` and `SessionSummary` gain `kind: SessionKind` (`work` | `code`), serialized as `kind`.
- SQLite: the table is created with `CREATE TABLE IF NOT EXISTS`, so existing installs need an explicit migration. On open, if `PRAGMA table_info(sessions)` has no `kind` column, run `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'`. Every existing session becomes Code, which is exactly today's behaviour.
- `workspace` stays `NOT NULL`. A Work session gets an app-data scratch root (`<app-data>/work/<session-id>`) that is never shown and never exposed as a tool root. This keeps one invariant — every session has a jailed root — so checkpoints, the project tree, and source control need no nullable-path branch.
- A session's kind never changes after creation. The UI offers "start a Code session" instead of converting one.
- Attachments are copied on pick into `<app-data>/attachments/<session-id>/<sha256>-<name>`. The copy is what gets read at send time, so a moved or deleted original cannot break a stored conversation, and nothing outside that folder is read later.

## Message and provider contract

- `provider.rs` already forwards `messages` as a `Vec<Value>` straight into the OpenAI-compatible request, so image parts need no transport change. The streaming parser reads only `delta.content` and `delta.tool_calls`, which is unaffected.
- History stores an attachment as a lightweight block — `{"type":"attachment","id":"<sha256>","name":"report.png","kind":"image"}` — not as base64. Before each provider call the runner expands those blocks into real parts: text files become text, images become `{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}`.
  Storing base64 in `history_json` was rejected: the column is rewritten on every turn, so one 3 MB image would cost 4 MB per write and grow without bound.
- A message with attachments therefore has array content, while plain messages keep string content. Existing Code-session history and tests are unaffected because they keep the string form.
- If an attachment file has gone missing when the history is replayed, the block is replaced with a short text note naming the missing file instead of failing the turn.

## Tool surface and enforcement

- `agent::tool_definitions` takes the session kind. For `work` it returns only `web_search` when that is configured — no file tools, because attachments are context rather than tools.
- `agent::dispatch_tool` rejects every file tool when the kind is `work`, with an explicit error such as `Work sessions have no file access`. A model that hallucinates `read_file` must fail at dispatch rather than be trusted to respect a prompt; this mirrors the existing Plan-mode gate.
- The runner looks up the kind from the session record when it builds the tool list, so the renderer cannot widen the toolset by sending a mode.

## UI

- The Sessions panel gains a two-item segmented control at its top: **Work** and **Code**. It filters the session list and decides what **New session** creates. Selecting a session of the other kind moves the control to that kind.
- **New session** in Work creates a scratch-backed session immediately. In Code it keeps today's behaviour: pick a folder, or fall back to a Documents session folder on the first message.
- While a Work session is active the activity bar hides Workspace, Checkpoints, and Source Control, and the top bar hides Plan/Act. The theme toggle and the composer stay.
- The composer gains an attachment control in Work sessions only. Chips sit above the text field; paste and drop use the same path as the picker.
- The schedule dialog hides the write-approval choice for Work sessions, since there is nothing to approve.
- Existing labels stay: Work/Code names the session, Plan/Act names the agent's posture. The UI never shows both selectors at once.

## Backend contracts

- `create_session(settings, kind)` and `create_default_session(settings, kind)` create the right root for the kind and record it.
- `list_sessions` and `get_session` include `kind`. No new filter command is needed; the renderer filters the list it already has.
- `add_attachments(session_id, paths)` copies, validates, and returns `{id, name, kind, bytes}` per file, rejecting anything over the limits with a message naming the file. `send_turn` accepts the attachment ids for the message being sent.
- Nothing is read from the renderer's original path after the copy, and no command accepts an arbitrary path to read.

## Rollout

1. Schema migration, `SessionKind`, record and summary fields, scratch root. No behaviour change; all tests still pass.
2. Tool gating and dispatch rejection for Work sessions, with tests. No UI yet.
3. Attachment store: copy, validate, expand on send, replay after restart. Rust tests with a local mock provider, including one that asserts the image part arrives as a data URL.
4. Sessions segmented control, hidden panels and Plan/Act, composer attachment control.
5. Schedule dialog adjustment and docs (README, PRD, progress).

## Verification

- Rust tests: migration adds `kind` and defaults existing rows to `code`; a Work tool list has no file tools; `dispatch_tool` rejects `read_file`, `write_file`, and `edit_file` for Work; attachment copy rejects oversize and unsupported files; a text attachment reaches the provider as text; an image attachment reaches the provider as an `image_url` data part; a replayed history with a deleted attachment degrades to a note.
- Frontend tests: the segmented control filters sessions, creating in each kind calls the right command, and Work hides the three panels and the Plan/Act selector.
- Manual: create a Work session, attach a text file and an image, confirm both are read; create a Code session and confirm today's flow, approvals, and checkpoints.

## Decided

- Switcher placement: a segmented **Work / Code** control at the top of the Sessions panel.
- Model per kind: one provider and model pair per session, as today. A separate Work model can come later as `settings.workModel` without changing the record shape.
- Attachments: Work reads user-supplied text and images; it never browses the disk. Code keeps autonomous workspace tools and gains attachments later if wanted, since the pipeline is session-agnostic.

## Open decisions

1. **Attachment scope in Code.** Turning the same composer control on for Code sessions is nearly free once the store exists; the question is only whether two ways to read a file confuses the model.
2. **Persistence of attachments in the transcript.** Chips are shown per message; keeping the copy forever means app-data grows. A retention policy (for example, drop copies for sessions deleted) is needed before long use.
3. **PDF and office documents.** Out of scope; they need text extraction, which is a separate dependency decision.

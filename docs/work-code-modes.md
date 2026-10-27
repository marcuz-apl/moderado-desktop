# Work tasks and Code projects

Implemented design, approved 2026-10-27. The central conversation canvas is called the workspace; Explorer displays its files.

## Work

A task owns one conversation and a managed folder under Documents/Moderado-Desktop/work-sessionN. Startup restores the last Work task or creates the initial one. New Task immediately creates an independent conversation and folder. Renaming a task changes its conversation label; its physical folder path remains stable and visible in the header.

Work can read, search, create, and edit UTF-8 documents inside its folder. Markdown, plain text, CSV, and HTML are supported by the existing file tools. These tools cannot generate native binary Office/PDF documents. Work cannot execute commands. File operations remain jailed, follow the task's approval policy, and create checkpoints before mutation. Explorer and Checkpoints are available in Work mode.

Text/image attachments keep an immutable copy for conversation replay and an editable copy at attachments/<id>-<name> inside the task folder. Old attachment references are copied when the task next runs, and existing edited copies are preserved. Original source files remain untouched.

## Code

A project is a registered canonical directory, persisted separately from sessions in the projects table. A session is an independent conversation using that directory. Many sessions can share one project's files, and a project can exist with zero sessions.

- New opens a name form, then a native parent-folder picker, and creates a new child directory. Existing directories are never overwritten.
- Open registers an existing directory and restores its most recently viewed session, or displays a fresh session draft.
- Projects expand to show their sessions and New Session, Rename, and Remove controls. The separate Sessions activity-bar panel is removed.
- New Session starts an independent context without a folder picker. Sending in an empty project's draft also creates a session in that project.
- Rename Project changes its display name. Folder paths remain stable.
- Delete Session removes conversation data and retains project registration and files.
- Remove Project archives its navigation entry and retains files and histories. Open restores the project and its sessions. A running project's removal is blocked.
- Explorer can browse a project even when it has no sessions. Git inspection remains Code-only; Code keeps structural Plan/Act restrictions and Windows sandboxed commands.

## Navigation and drafts

The compact Work/Code selector restores that mode's last task or Code project/session. Last-viewed IDs and project selection are stored locally and validated against current records on startup. Work remains the startup mode. Unsent text and attachment selections are retained in memory per conversation/draft while switching views. A background task continues when the user navigates away.

Async selection results are guarded by a revision counter. A delayed request cannot reactivate another mode or overwrite a newer selection. Completion and attachment events are scoped to their originating conversation. Deleting the active session selects another conversation only in the same task mode or Code project; otherwise it displays a new draft.

The job status remains above the single-line Auto-Approve toolbar and input. Work shows read/edit/web approval controls; Code also shows command and the MCP placeholder. Provider/model and usage share a row below the input.

## Persistence and migration

Migration 6 registers each existing Code folder once, preserves session histories, and enables read/edit for Work tasks still using the previous default policy. Customized policies remain intact. Projects are keyed by canonical folder path; relocating a project requires opening its new location. Removing a project does not delete its underlying data.

## Verification

Offline Rust checks cover migration, project lifecycle, document tool gates, workspace escapes, attachment copies, and Work/Code mock-provider write flows. Node checks cover mode restoration and empty project selection. For rendered UI regression checks, run Vite on port 1420 and use:

```powershell
npx --package @playwright/cli playwright-cli open about:blank
npx --package @playwright/cli playwright-cli run-code --filename scripts/check-navigation-ui.js
```

The browser check uses a mocked Tauri bridge and exercises draft restoration, nested sessions, Explorer, background task navigation, last-session deletion, project removal/reopen, and New/Open project flows. Native file dialogs and real model behavior require desktop/manual verification.

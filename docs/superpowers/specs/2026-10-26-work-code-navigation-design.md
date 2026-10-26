# Work and Code Navigation Design

## Status

Approved direction; awaiting review of this written specification before implementation.

## Goal

Make Work and Code feel like separate workflows. Work users manage Tasks. Code users manage Projects and the Sessions that belong to a selected project.

## Terminology

- **Mode** is the persistent Work/Code switch. It is a control, not an activity panel.
- **Task** is a Work conversation/session. The Work panel is titled **Tasks** and creates entries with **New Task**.
- **Project** is a Code workspace folder. The Projects panel creates a project by asking the user to select its folder; the first Code session is created in that folder.
- **Session** is a Code conversation within a project. The Sessions panel lists sessions for the currently selected project and creates another conversation in that same folder with **New Session**.
- The Explorer, Checkpoints, and Git panels operate on the selected Code session's project folder. Work sessions never gain file access.

## Navigation

- Keep one Work/Code switch pinned at the top of the side panel so it remains visible as the user changes activity panels.
- In Work mode, show Tasks, Schedules, Profile, and Settings. Hide Projects, Sessions, Explorer, Checkpoints, and Git.
- In Code mode, show Projects, Sessions, Explorer, Checkpoints, Schedules, Git, Profile, and Settings.
- Selecting a Code project opens its Sessions panel and selects the most recently active session for that folder.
- If a project has no sessions, it cannot appear in the project list in this first iteration; creating a project immediately creates its initial session.
- Switching to Code opens Projects. Switching to Work opens Tasks and selects the most recently active Work task.

## Project and Session Behavior

- Do not add a projects table. Derive the project list by grouping Code session records by their canonical `workspace` path. Show the folder basename as the project name and a count of sessions.
- **New Project** reuses the existing Code workspace picker and creates the first Code session in the selected directory. If the selected folder already has Code sessions, open that existing project and select its most recent session instead of creating a duplicate project or session.
- **New Session** is enabled only after a project is selected. It creates a new Code session using the workspace path from an existing session in that project; the renderer does not supply an arbitrary workspace path to the backend.
- The backend command that creates a session in a project accepts a source Code session ID, loads its workspace path from the session store, verifies its kind is Code, and creates the new Code session in that same path.
- Existing Rename and Delete actions continue to operate on the selected conversation. Selecting a project chooses its most recent session, so existing session actions remain usable from the Sessions workflow.
- Deleting the final Code session for a folder removes that folder from the derived project list. It does not delete the user's project directory.
- Work tasks keep the current `work-sessionN` folder convention in `Documents/Moderado-Desktop`; their public label and action become Task and New Task.

## Startup and State

- Startup remains Work-first. If there are no Work records, create `work-session0` under Documents; otherwise select the most recently active Work record.
- Keep the selected Code project path in renderer state only. On startup into Work, Code state is not implicitly selected. Switching to Code selects the most recently used Code project, if one exists; otherwise show Projects with its empty state.
- Existing session records and transcripts remain unchanged. Projects are inferred from session records, so no migration or data rewrite is needed.

## UI Details

- Keep the Work/Code control accessible as one switch with `role="switch"` and `aria-checked`.
- Put the persistent switch above the activity panel content, not inside Tasks or Projects, so it remains available on every panel.
- The Tasks header action reads **New Task**. The Projects header action reads **New Project**. The Sessions header action reads **New Session**.
- On the Sessions panel, list only Code sessions whose workspace matches the selected project. Keep the main canvas conversation and existing Rename/Delete actions synchronized to the selected session.
- The Projects list shows project name and session count; selecting an item selects its project and opens Sessions.
- Preserve the current Profile, Settings/About, theme behavior, schedules, and approval semantics.

## Safety and Error Handling

- Project folders continue to be selected through the native folder picker for **New Project**.
- Creating a session within an existing project derives the project path in Rust from a stored Code session ID. Reject missing IDs and Work session IDs.
- Keep all Explorer reads, Git inspection, and agent file tools behind existing Rust workspace-jail commands.
- Surface project/session creation errors in the existing status area; do not silently switch projects or create sessions after a canceled folder picker.
- Work sessions continue to receive no filesystem tools, even though their storage folder is under Documents.

## Tests and Acceptance

- Frontend tests cover grouping Code sessions by workspace, excluding Work sessions, session filtering by selected project, project basename labels on Windows and Unix paths, mode destinations, and the three mode-specific create labels.
- Rust tests cover creating a Code session in a project from an existing Code session ID, rejecting a Work source session, and preserving the shared workspace path.
- Manual UI checks confirm the mode switch remains visible across panels, Work exposes Tasks/New Task, Code exposes Projects/New Project and project-scoped Sessions/New Session, and Explorer/Git act on the selected project.
- `npm test`, `npm run lint`, and `npm run build` pass.

## Out of Scope

- A standalone projects database or project metadata editor.
- Deleting or moving project folders from the app.
- Adding version-control providers other than local Git.
- Changing GitHub sign-in, profile identity, API providers, or the Work/Code tool-security boundary.

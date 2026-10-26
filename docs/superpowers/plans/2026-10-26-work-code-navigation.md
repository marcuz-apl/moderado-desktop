# Work and Code Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Work task management from Code project and session management while keeping the Work/Code switch persistent.

**Architecture:** Derive projects from canonical workspace paths already stored on Code sessions; do not add a projects table. Create a Code project through the existing folder picker and its first session, and create later sessions from a source Code session ID so Rust derives the workspace instead of trusting a renderer path.

**Tech Stack:** Rust, Tauri 2, TypeScript, HTML/CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-26-work-code-navigation-design.md`

## Global Constraints

- Work sessions never gain filesystem tools, even though their storage folder is under Documents.
- Project folders continue to be selected through the native folder picker for **New Project**.
- Creating a session within an existing project derives the project path in Rust from a stored Code session ID. Reject missing IDs and Work session IDs.
- Existing session records and transcripts remain unchanged. Projects are inferred from session records, so no migration or data rewrite is needed.
- Keep all Explorer reads, Git inspection, and agent file tools behind existing Rust workspace-jail commands.
- Do not add dependencies or a projects table.

## Review Focus

- Canceled or invalid folder selection must not create a task/session or switch projects; cover existing cancel behavior and path deduplication in Task 2.
- A Work session ID cannot be used to create a Code session in its hidden root; test the Tauri command's source-record validation in Task 1.
- Multiple Code sessions that share one workspace must render as one project with a stable session count; test grouping/filtering in Task 1.
- Windows path casing and separators must not split one canonical project; rely on Rust canonical workspace paths and test basename/path grouping inputs in Task 1.
- Removing a project's final session must remove it from the derived project list without deleting its folder; test project derivation after removal in Task 1.

---

### Task 1: Project and Session Domain Operations

**Files:**
- Modify: `src/renderer/sessions-view.ts`
- Test: `tests/session-kind.test.mjs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/sessions.rs` only if a reusable store query is needed
- Test: Rust tests in `src-tauri/src/lib.rs` or `src-tauri/src/sessions.rs`

**Interfaces:**
- Produce `ProjectSummary = { workspace: string; name: string; sessionCount: number; latestSessionId: string; updatedAt: number }` in `sessions-view.ts`.
- Produce `projectsForSessions(sessions)` which includes Code sessions only, groups by canonical workspace path, uses the workspace basename for `name`, counts sessions, identifies the newest session, and sorts projects by descending latest update.
- Produce `sessionsForProject(sessions, workspace)` which returns only Code sessions whose workspace exactly matches the selected canonical workspace.
- Produce `defaultPanelForKind(kind)`, `panelAvailableForKind(kind, panel)`, and `newActionLabel(panel)` in `sessions-view.ts`. Exact labels are `New Task`, `New Project`, and `New Session`.
- Add `SessionStore::create_session_in_project(source_session_id, name, settings)` and `SessionStore::find_code_project_session(workspace)` as the testable backend operations.
- Add Tauri command `create_session_in_project(source_session_id, settings) -> Result<SessionRecord, String>`. It must load the source record, reject non-Code sessions, and create a new Code session in the same stored workspace.
- Update `create_session` Code flow to detect a folder already used by a Code session and return that project's newest existing session rather than creating a duplicate project/session.

- [ ] **Step 1: Write frontend domain tests**

Add tests for `projectsForSessions` with multiple sessions in one path, distinct paths, Work records, session counts, latest-session selection, sort order, and Windows/Unix basename handling. Add tests for `sessionsForProject`, including empty or unknown workspace.

- [ ] **Step 2: Run frontend tests to verify they fail**

Run: `node --test tests/session-kind.test.mjs`
Expected: FAIL because the project grouping/filter helpers are not exported.

- [ ] **Step 3: Implement project grouping/filter helpers**

Implement the exact interfaces in `src/renderer/sessions-view.ts`, reusing the existing `projectNameFromWorkspace` helper where applicable.

- [ ] **Step 4: Run frontend tests to verify they pass**

Run: `node --test tests/session-kind.test.mjs`
Expected: PASS, with Work excluded and same-folder Code sessions represented by one project.

- [ ] **Step 5: Write Rust project-session tests**

Test creating a session from a Code source session preserves its workspace and kind. Test rejecting a Work source session and returning an existing project session when the folder picker selects an already represented workspace.

- [ ] **Step 6: Run targeted Rust tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml project_session`
Expected: FAIL because the secure project-session operation is not implemented.

- [ ] **Step 7: Implement secure project session creation and folder deduplication**

Add the command, register it in `invoke_handler`, derive workspace paths from stored Code session IDs, and make New Project folder selection reuse the newest existing session when `find_code_project_session` finds the canonical path.

- [ ] **Step 8: Run targeted Rust tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml project_session`
Expected: PASS, including the Work-source rejection and shared-workspace assertions.

### Task 2: Mode-Specific Sidebar and Navigation

**Files:**
- Modify: `index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/theme.css`
- Modify: `tests/session-kind.test.mjs`

**Interfaces:**
- Keep `#kind-toggle` as the persistent Work/Code switch above all panel sections.
- Add `tasks`, `projects`, and `sessions` to the sidebar panel IDs; retain `workspace` as the internal ID for the visible Explorer panel.
- Keep `activeKind`, `activePanel`, selected Code project workspace, and active session distinct in renderer state.
- Work mode shows Tasks and creates Work sessions with **New Task**.
- Code mode shows Projects and Sessions panels; Projects creates/reuses a project, Sessions is scoped to the selected workspace and creates a session through `create_session_in_project`.

- [ ] **Step 1: Write panel and action tests**

Add unit tests for `defaultPanelForKind` (`work -> tasks`, `code -> projects`), `panelAvailableForKind` (Work hides Code-only panels), and `newActionLabel` returning exact labels **New Task**, **New Project**, and **New Session**.

- [ ] **Step 2: Run frontend tests to verify they fail**

Run: `node --test tests/session-kind.test.mjs`
Expected: FAIL because the mode destination and project/session action helpers are not implemented.

- [ ] **Step 3: Add separate Tasks, Projects, and Sessions panels**

Move the persistent Mode switch outside panel sections. Add a Work-only Tasks panel, Code-only Projects and Sessions panels, and retain Explorer, Checkpoints, Schedules, Git, Profile, and Settings with the visibility specified in the design.

- [ ] **Step 4: Wire project selection and session creation**

Render projects from `projectsForSessions`; selecting a project selects its newest Code session and opens Sessions. Render only `sessionsForProject` in Sessions. New Project invokes the existing Code folder picker; New Session invokes `create_session_in_project` with a source Code session ID. Preserve Work-first startup and keep Work task selection independent from Code project selection.

- [ ] **Step 5: Update empty states and selected-session actions**

Make New Session unavailable before project selection, retain topbar Rename/Delete behavior for the active conversation, and make project/session deletion updates refresh the derived project/session lists without deleting workspace directories.

- [ ] **Step 6: Run frontend tests to verify they pass**

Run: `node --test tests/session-kind.test.mjs`
Expected: PASS for panel destinations, copy labels, project selection utilities, and session scoping.

- [ ] **Step 7: Run full checks and build**

Run: `npm test`, `npm run lint`, and `npm run build`.
Expected: all test suites, lint, and the Tauri release build pass.

### Task 3: Manual Navigation Verification and Documentation

**Files:**
- Modify: `docs/sidebar-design.md`
- Modify: `docs/work-code-modes.md`
- Modify: `docs/progress.md`

- [ ] Verify in the running desktop UI that the Mode switch stays visible across panel changes; Work shows Tasks/New Task; Code shows Projects/New Project and project-scoped Sessions/New Session; selecting Projects opens Sessions; Explorer and Git use the selected project.
- [ ] Verify a Code project reselected through New Project does not create a duplicate session, a canceled picker leaves navigation unchanged, and creating a session in a Work-only record fails.
- [ ] Update sidebar and Work/Code documentation to match shipped terminology and state.
- [ ] Run `git diff --check` and inspect `git status --short` before the final commit.

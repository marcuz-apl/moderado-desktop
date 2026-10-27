# Work Tasks and Sessions Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session; the user explicitly requested this behavior.

**Goal:** Give Work Tasks independent managed folders and allow each Task to contain multiple sessions.

**Architecture:** Add a persistent Work Task record keyed by its managed workspace. Link Work sessions to that record while Code sessions keep their existing project relationship. Migrate existing Work sessions into Tasks without changing their history or folder, and mirror the Code navigation pattern: task CRUD in the Tasks panel, nested task/session radios for selection, and session CRUD in the workspace.

**Tech Stack:** Rust, SQLite migrations, Tauri commands, TypeScript renderer, CSS.

**Spec:** User request in this conversation; existing Code project/session pattern in `docs/work-code-modes.md`.

## Global Constraints

- Keep all Work file access jailed to each Task's managed Documents folder.
- Preserve existing session history and workspace files during migration.
- Removing a Task removes its app records and child sessions, but preserves its managed folder.
- Code project/session behavior remains unchanged.

---

### Task 1: Persist Work Tasks and migrate existing Work sessions

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/sessions.rs`

- [ ] Add schema migration for `work_tasks` and `sessions.task_id`.
- [ ] Backfill one Task per distinct existing Work workspace and link its Work sessions.
- [ ] Add task listing, creation, rename, session creation, and removal store operations.
- [ ] Cover migration, shared-folder sessions, rename, removal, and file preservation in Rust tests.

### Task 2: Expose task lifecycle through Tauri

**Files:** `src-tauri/src/lib.rs`

- [ ] Add commands for listing, creating, renaming, and removing Work Tasks.
- [ ] Add a command for creating a Work session under a selected Task.
- [ ] Lock child sessions before removing a Task and clean session runtime/attachment records.
- [ ] Keep the default first-run Work session attached to its generated `work-sessionN` Task folder.

### Task 3: Separate Work task navigation from session controls

**Files:** `index.html`, `src/renderer/main.ts`, `src/renderer/style.css`, `src/renderer/theme.css`

- [ ] Put New/Rename/Delete Task controls under the Tasks heading.
- [ ] Render each Task with its active radio and nested, indented session radios.
- [ ] Keep session New/Rename/Delete in the workspace and make them available in Work mode.
- [ ] Remove row boxes in the Tasks panel; radio state alone indicates selection.
- [ ] Restore the last selected Task and Work session on startup.

### Task 4: Update documentation and verify

**Files:** `docs/work-code-modes.md`, affected tests.

- [ ] Document the Task/session relationship and removal semantics.
- [ ] Run targeted and complete offline tests, lint, and release build.
- [ ] Commit and push under the repository versioning convention.

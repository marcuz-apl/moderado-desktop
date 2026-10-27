# Work/Code navigation implementation plan

**Goal:** Implement the approved task/project/session relationships without losing existing conversations or user files.

**Architecture:** Reuse sessions and jailed tools; persist projects separately by canonical folder path, with archive/removal independent of sessions. Centralize frontend mode/selection decisions and reject stale async results.

**Tech Stack:** Rust/Tauri, SQLite, TypeScript, native dialogs; no new dependencies.

**Spec:** docs/superpowers/specs/2026-10-27-work-code-projects-design.md

1. Add meaningful failing tests for project persistence after last-session deletion, archive/reopen, folder-creation validation, Work document tools/jail, and mode restoration.
2. Add migration 6 and SessionStore project registry methods; preserve all histories and files. Expose separate create/open/list/rename/remove project Tauri commands.
3. Enable jailed Work file operations and checkpoints, keep command execution Code-only, copy attachments into the task folder, and allow Explorer for Work and empty projects.
4. Consolidate Projects/Sessions navigation, separate New/Open project, restore mode context, provide a clear empty draft, and enforce async selection consistency. Keep selection radios and running-state indicators.
5. Update affected tests and product documentation; run tests, lint, production build, and inspect the actual UI with a mocked Tauri bridge for navigation scenarios. Review the final diff. Commit a version-stamped feature and push using the existing authorization.

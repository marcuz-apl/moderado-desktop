# Work tasks, Code projects, and conversations

Status: approved in chat on 2026-10-27.

- Work tasks own one conversation and an automatically managed folder in Documents/Moderado-Desktop. Preserve existing work-sessionN folders and histories. Work may read, create, and edit UTF-8 documents inside that folder through the existing jailed dispatcher, approvals, and checkpoints. Work cannot execute commands. Existing attachment copies are also placed inside the task folder for editing; original source files remain user-owned.
- Code projects are persistent registered canonical folders independent of conversations. New Project creates a named folder under a chosen parent. Open Project registers an existing folder. Projects can contain zero or more independent sessions sharing the codebase. Rename changes the display name. Remove Project hides it from navigation while preserving files and conversation history; reopening restores it.
- Navigation uses Tasks for Work and expandable Projects with nested Sessions for Code. Explorer remains separate and displays the active task or project folder, including an empty Code project. Session deletion never deletes project files or removes its project.
- Switching modes restores the last conversation for that mode, including the selected Code project. It never reuses the other mode's active session. Running work continues when navigation changes. Async selection results must not overwrite a newer selection.
- Current provider/model, token usage row, single-line approval toolbar, and job-status ordering remain. Work shows read/edit/web controls, Code also shows command and the existing MCP placeholder.
- New task and Code session records are created only by explicit New actions or sending in a fresh draft. New project selection starts a fresh draft when no conversation exists. Startup remains Work and restores a Work task, or creates the initial managed task when needed.
- A numbered migration backfills existing Code folders into the project registry and enables default read/edit permissions for Work. Customized policies are retained. No provider changes or new dependencies.
- File editing in this increment uses existing UTF-8 tools; native Word/PDF/spreadsheet generation is outside this change.

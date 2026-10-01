# Bootstrap findings

- CLI baseline: `v0.3.10+260930f` at commit `44251dce6cca0a3385196284c7b993e8ee964e0f` when inspected; this is a reference baseline, not a Desktop dependency lock.
- Core is provider-agnostic and receives providers, tools, approval handlers, policy, history, and host event listeners through `AgentRunOptions` in `packages/core/src/agent.ts`.
- Provider presets and free-model policy live in `packages/providers/src/presets.ts`.
- CLI configuration is `~/.moderado/config.json`; sessions are under `~/.moderado/sessions/<sha256-of-canonical-workspace>/`; skills are under `~/.moderado/skills/`.
- Windows credentials use Credential Manager references shaped `moderado/provider/<provider-id>`; they are not in the profile folder. On other platforms, the CLI currently uses an in-memory credential store plus environment or legacy config sources.
- `saveConfig` currently writes `config.json` directly after an in-process merge, so concurrent Desktop and CLI writes need a shared atomic/coordination design before production use. Session writes are atomic but simultaneous changes to one session can still conflict.
- VSCodium's repository is MIT-licensed build scripts for Microsoft Code OSS. Its `prepare_vscode.sh` changes product names, identifiers, update URLs, and Open VSX gallery settings. Downstream builds must carry license notices and own update/build operations.
- Review found that current core approvals do not validate returned decision IDs, write_file lacks a complete preview, approval timeout is not implemented in the core, and configured MCP executables are not workspace-jailed. Desktop requirements now call these out explicitly.
- Current CLI profile readers may return defaults or skip invalid files; Desktop must distinguish missing data from malformed data before writing.
- The requested destination `D:\projects\moderado-desktop` was created through an approved escalated operation and initialized as an independent Git repository.

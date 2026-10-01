# Moderado Desktop Product Requirements

**Project version:** see [VERSION](VERSION) (planning scaffold, unpublished)  
**Initial platform:** Windows x64  
**Reference agent baseline:** Moderado CLI `v0.3.10`; the exact source commit will be pinned when implementation begins.

## 1. Purpose

Create an independently installed, Moderado-branded coding IDE using the
MIT-licensed Code OSS editor and VSCodium's downstream build approach. A user
must be able to install one Desktop package, open a project, connect a provider,
select a model, review agent actions, and resume a Moderado session without
installing the CLI. The Desktop and CLI editions share the user's Moderado
profile while maintaining separate application releases.

## 2. Users and primary flow

The initial user is a developer on Windows who wants Moderado's provider-neutral
agent in a complete editor. The first complete flow is:

1. Install and launch Moderado Desktop with no CLI installation present.
2. Open a trusted local workspace; inspect code with editor and agent tools.
3. Reuse an existing provider connection from `~/.moderado/config.json` or add
   one through Desktop; resolve its key without exposing it in UI messages.
4. Discover models, select a pinned model or free-first AUTO route, and show
   paid or unknown-cost models only under the same explicit opt-in rules as
   the pinned Moderado engine.
5. Start or resume a workspace session, stream events and usage, inspect a
   proposed diff or command, decide approval, and observe the result.
6. Close and reopen Desktop; the session and selected provider/model remain
   available. The CLI can subsequently read that session on the same OS.

## 3. Product boundaries

- The IDE is a separate repository with its own `VERSION`, Git history, build,
  release assets, and update channel. Desktop work does not write into the CLI
  repository.
- The release bundles Moderado's contracts, core, providers, and tools. It
  cannot shell out to a globally installed CLI or parse terminal output as its
  main agent protocol.
- Editor source/build inputs and Moderado source inputs are pinned by immutable
  upstream revisions and recorded in each build's manifest.
- Moderado agent file and process actions retain the workspace jail, typed
  boundary validation, environment cleansing, bounded output, and core policy.
- UI and editor state do not become part of the shared agent profile contract.

## 4. Functional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| F1 | Produce a Moderado-branded Windows x64 IDE package from pinned Code OSS/VSCodium inputs. | Install and launch on a clean Windows test account; product name, icon, data directory, URL scheme, and installer IDs do not collide with VSCodium or VS Code. |
| F2 | Bundle the pinned Moderado agent packages and provider presets. | With no CLI executable installed, connect to a fake provider and complete a bounded agent turn. |
| F3 | Preserve model inventory, free-first AUTO routing, model pinning, and paid/unknown-cost opt-in. | Shared offline fixtures yield equivalent eligibility and routing outcomes in CLI and Desktop for the pinned engine revision. |
| F4 | Render structured agent events, tool previews, usage, cancellation, and actionable errors. | A real editor-host test observes ordered events and can cancel a running turn. |
| F5 | Require a human decision for every file mutation and command by default; deny on closed UI, approval timeout, cancellation, malformed or mismatched decision, or non-interactive execution. Plan mode blocks mutations. | Tests demonstrate no mutation or command runs without an affirmative matching decision; preview shows every affected path and complete proposed replacement/patch or command and working directory. A missing complete preview denies the action. |
| F6 | Reuse the same local Moderado configuration, skills, and session schema on the same OS. | Desktop reads a CLI-created profile/session and the CLI reads a Desktop-created session after restart. |
| F7 | Resolve Windows provider credentials using the existing `moderado/provider/<id>` Credential Manager references. | A CLI-stored test credential works in Desktop without copying the secret into `config.json` or the UI. |
| F8 | Discover and run explicitly configured MCP tools only after the user trusts that server; require approval for every MCP tool call. | A fake MCP server cannot bypass approval, and provider credentials are removed from its inherited environment. The UI explains that an MCP server is an external process with its own filesystem privileges. |

The Desktop approval default in F5 is a deliberate safety requirement. The
current CLI's interactive approval handler can auto-approve non-MCP actions by
default despite its repository guidelines. Desktop must not inherit that
behavior silently; the discrepancy is documented in [Profile and behavior
compatibility](docs/PROFILE.md).

F5 requires work beyond the current core: `write_file` has no complete diff
preview, multi-file patch approval does not enumerate every target in the
structured payload, and the core currently accepts an `approved` status
without validating the decision request ID. The Desktop integration must
close these gaps through a validated host boundary and, where needed, a
separately reviewed upstream Moderado change. Its approval handler must own
an explicit deadline; the existing policy's timeout field alone does not
enforce one.

## 5. Shared-profile contract

The shared Moderado root is `path.join(os.homedir(), '.moderado')`; on Windows
this normally resides under `%USERPROFILE%`. The Desktop and CLI editions
share `config.json`, `sessions/`, and `skills/` according to their existing
formats. Windows provider keys remain in Credential Manager. Desktop-specific
layout and caches are isolated. Unknown config fields must survive a Desktop
write. Schema changes require explicit versioning and a reversible migration.

Before a public release, simultaneous CLI/Desktop configuration writes must
have a tested coordination strategy accepted by both applications; the current
CLI writer performs a direct read/merge/write and can lose updates. Two live
processes must not edit the same session ID without a conflict policy. The
first release targets sharing within one Windows user profile; sharing between
Windows and a separate WSL home is a later, explicit compatibility decision.
See [the detailed profile contract](docs/PROFILE.md).

## 6. Non-functional requirements

- **Security:** Keep the Moderado tool jail and approval boundary authoritative;
  workspace and model content are untrusted. Never send provider secrets into
  renderer events, logs, crash reports, or child process environments. A local
  MCP server is separately trusted executable code and is not confined by the
  file-tool workspace jail.
- **Reliability:** Fail closed on malformed config, session, provider, or tool
  payloads; show recovery guidance without deleting user data. Preserve a
  known-good application version if an update fails.
- **Maintainability:** Prefer a small, reviewable downstream patch set. Pin
  upstream revisions, retain attribution, and test rebases before changing
  editor versions.
- **Verification:** Core/provider/tool tests run offline with fakes. At least
  one real IDE-host smoke flow runs on Windows; a mocked `vscode` module alone
  is insufficient evidence of editor integration.
- **Accessibility:** Agent controls, approval dialogs, errors, and model choices
  work with keyboard and screen reader interaction.

## 7. Delivery gates

1. **Foundation:** Independent repository, source/license inventory, pinned
   upstream inputs, and a repeatable local Windows build.
2. **Agent integration:** Self-contained editor package, structured event UI,
   provider/model parity, and fail-closed approvals against fake providers.
3. **Shared profile:** Configuration, credentials, sessions, and skills round
   trip with a CLI release; concurrent writes are handled or explicitly
   prevented without data loss.
4. **Release readiness:** Real-editor tests, clean-account install/uninstall,
   provenance, license notices, update channel, and user documentation.

Each gate must pass before the next is declared complete. The scaffold itself
completes none of the application gates.

## 8. Explicit non-goals for the first release

No reimplementation of the Moderado agent loop, no dependency on an installed
CLI, no Microsoft Visual Studio Marketplace endpoint in the derived editor,
no silent installation of proprietary extensions, no cross-OS profile sharing,
and no macOS/Linux release before the Windows workflow is verified.

# Moderado Desktop bootstrap plan

## Objective

Create an independent sibling project at `D:\projects\moderado-desktop` with an actionable PRD, contributor rules, README, connected version, upstream and shared-profile contracts, and a truthful handoff. Leave the Moderado CLI repository unchanged after transfer.

## Phases

1. Source audit — complete: inspect the CLI baseline, shared profile, credentials, VSCodium build model, and licensing.
2. Draft scaffold — complete: root identity, PRD, AGENTS, license, editor rules, upstream/profile/roadmap/handoff documentation.
3. Review — complete: source audit and independent documentation review addressed approval, MCP, and malformed-profile caveats; validation checks remain to rerun after transfer.
4. Transfer — complete: copied the reviewed scaffold to the sibling folder and initialized its own Git repository; copied-project validation passed and the CLI working tree is clean.

## Decisions

- The desktop project is an independent repository and release train.
- The first target is a Windows x64 IDE build; macOS and Linux follow only after the Windows integration is proven.
- The end-user desktop app bundles Moderado's agent packages and does not require an installed CLI.
- The CLI source is a pinned upstream dependency, never edited from this project.
- Moderado data is shared through `~/.moderado`; editor caches and UI state are isolated.
- This scaffold documents the implementation but does not claim a working binary.

## Errors encountered

- `Get-Date -AsUTC` was unavailable in the installed PowerShell; the clock tool established the UTC date as 2026-10-01.
- The first placeholder/secret scan command had a PowerShell quoting error. Re-ran a simpler placeholder scan successfully; content review and link checks continue.
- A sandboxed Git read of the new repository reported dubious ownership because the sibling folder is owned by the user's account. Used a command-local `-c safe.directory=D:/projects/moderado-desktop` override to verify its status without changing global Git configuration.

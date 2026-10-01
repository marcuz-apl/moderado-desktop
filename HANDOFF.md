# Project Handoff

Updated: 2026-10-01 UTC  
Branch: master  
Commit: initial scaffold (resolve with `git log -1`)  
Status: planning scaffold reviewed; initial commit ready for push

## Summary

Moderado Desktop is an independent, self-contained IDE project planned around
Code OSS/VSCodium build inputs and the pinned Moderado agent packages. No app
source, build, installer, or release exists yet.

## Completed

- Defined product requirements, contributor boundaries, upstream policy,
  shared-profile contract, delivery roadmap, and independent version.
- Selected Windows x64 as the first target and a CLI `v0.3.10` behavioral
  reference without altering the CLI repository.

## In progress

- Owner review of the planning scaffold. Upstream source pinning and the editor build have not started.

## Working tree

- Independent Git repository initialized. Initial project files are untracked;
  no commit yet.

## Checks

- `VERSION` format, required files, local document links, placeholder scan,
  and all 14 copied file hashes â€” PASS in the sibling project.
- `git -c safe.directory=D:/projects/moderado-desktop -C D:\projects\moderado-desktop status --short --branch` â€” PASS; no commits yet on `master`.
- `git status --short --branch` in the CLI repository â€” PASS; clean after staging cleanup.
- Build and tests â€” not run; no application source or test runner exists.

## Decisions and context

- End users must not need a separate CLI installation.
- The same user's `~/.moderado` is shared for agent data; editor state is
  isolated. Current CLI config writes have a cross-process lost-update risk.
- Windows provider credentials live in Credential Manager, outside the shared
  folder. Windows/WSL cross-home sharing is outside the initial release.
- Desktop requires human approval by default for mutations and commands. The
  current CLI handler can auto-approve, so this is a deliberate safety
  difference rather than an existing parity claim.
- The current core lacks complete previews for all writes and validation of
  approval decision IDs; Desktop must close those gaps before agent writes.
- Configured MCP servers are external processes with user privileges, not
  confined by the built-in file-tool jail.
- Upstream source revisions and license notices must be pinned before a build.

## Blockers

- None for documentation. The first application milestone requires selecting
  and testing exact upstream revisions and resolving safe cross-process profile
  writes before public release.

## Next action

Review `PRD.md`, then pin VSCodium, Code OSS, and Moderado source revisions for
the first reproducible Windows x64 build.

## Initial push checks (2026-10-01 UTC)

- Installed Desktop-local hooks with `git config --local core.hooksPath .githooks`.
- Git Bash temporary-repository checks: PASS for committed VERSION, matching
  commit prefix, daily counter increment, and clean index after two commits.
- Hook shell syntax checks: PASS using Git Bash `sh -n`.
- Secret-pattern scan: no private-key blocks or matching GitHub/OpenAI tokens.
- `git ls-remote --heads origin`: PASS; remote has no branches before first push.
- No app tests or build ran; this remains a documentation scaffold.
- Hooks automate build counters and subject prefixes. Semantic version changes
  must be set explicitly in VERSION; major increments need owner approval.

# Moderado Desktop roadmap

This is an ordered delivery sequence, not a claim that a build exists. Each
milestone needs a reviewable artifact and its checks before the next begins.

## M0 — Independent project foundation (documentation scaffold)

- Define product, source, profile, security, and versioning contracts.
- Create a separate Git repository and verify the CLI working tree is unchanged.
- Record an initial handoff and the smallest next action.

**Done when:** the root documents agree, the sibling directory exists, its
repository is independent, and no application is represented as shipped.

## M1 — Reproducible Windows editor build

- Pin VSCodium, Code OSS, and Moderado source revisions in a Desktop-owned
  manifest; preserve license notices.
- Produce a Windows x64 editor with distinct Moderado identity and isolated
  editor application data.
- Verify launch, open-folder, terminal, install/uninstall, and clean-account
  behavior. No agent integration is claimed at this gate.

## M2 — Self-contained Moderado agent

- Bundle the pinned contracts/core/providers/tools packages in the editor.
- Add an editor host and UI for provider setup, model discovery/selection,
  streamed events, cancellation, tool previews, and decisions.
- Verify no installed CLI executable is needed. Use a fake provider and real
  editor-host test; preserve free-first and paid/unknown-cost rules.
- Enforce explicit human approval by default for mutations and commands;
  Plan mode blocks writes in core policy.

## M2 status (integrated; agent wiring verified)

`vendor/moderado/` holds the pinned CLI agent packages exported at the
immutable revision in `sources.lock.json` (commit `a293c1d…`, 53 files, tree hash
recorded in `vendor/moderado/VENDORED.json`). The export uses `git archive`, so
the sibling CLI working tree is never modified.

`extensions/moderado-agent/` bundles those packages with Desktop's host into a
single CommonJS bundle for the editor host. Verification is recorded in
[HANDOFF.md](HANDOFF.md).

Provider configuration, session persistence, and the streaming chat UI remain
unbuilt; they are listed under Milestone 2 follow-ups.

## M3 — Shared profile compatibility

- Round-trip config, skills, Windows Credential Manager references, and
  sessions with a pinned CLI release.
- Resolve config write races through a protocol both editions follow;
  coordinate any CLI-side change in its own repository.
- Define and test conflict handling for the same session open in two processes.
- Protect malformed and older profile data with validated, recoverable
  migrations.

## M4 — Release readiness

- Run offline suites and Windows real-editor workflow checks.
- Verify security boundaries, keyboard/screen-reader flows, attribution,
  artifact provenance, checksums, signing status, and update behavior.
- Document installation and supported platform/profile combinations.
- Publish only after explicit owner authorization.

MacOS, Linux, and Windows/WSL cross-home sharing follow separate evidence-backed
milestones after the Windows release gate.

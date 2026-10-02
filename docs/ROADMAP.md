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
single CommonJS bundle for the editor host. It provides the chat view, the
fail-closed approval boundary, model selection, and session persistence against
the shared `~/.moderado` profile. Verification is recorded in
[HANDOFF.md](HANDOFF.md).

Milestone 3 still needs the cross-process round-trip against a pinned CLI
release, Credential Manager references, and a coordinated `config.json` writer.

## M3 — Shared profile compatibility

- Round-trip config, skills, Windows Credential Manager references, and
  sessions with a pinned CLI release.
- Resolve config write races through a protocol both editions follow;
  coordinate any CLI-side change in its own repository.
- Define and test conflict handling for the same session open in two processes.
- Protect malformed and older profile data with validated, recoverable
  migrations.

## M3 status (implemented; verified against the pinned CLI)

Desktop now reads and writes the shared `~/.moderado` profile through a
canonical, coordinated path. Round-trip tests run against the *actual* CLI
`dist` from the pinned revision rather than a hand-written copy of its schema,
so they would fail if the two editions diverged.

Delivered here:

- `src/profile.ts` — canonical workspace root, missing-vs-invalid config
  detection, field-preserving merge, skill discovery.
- `src/credentials.ts` — the CLI's `moderado/provider/<id>` normalization and
  resolution order, plus a Windows Credential Manager store that passes the key
  only on stdin and never on a command line.
- `src/coordination.ts` — a lock file plus an in-lock re-read, so a concurrent
  CLI write is merged rather than lost, and an owned-field conflict refuses to
  overwrite instead of clobbering.
- `src/sessions.ts` — the CLI's session schema and directory hash, atomic writes,
  corrupt-record reporting, and a checked save that refuses to overwrite a
  session another process changed.

**Still open:** the CLI does not take Desktop's lock, so the coordination
protects Desktop's own writes and detects the CLI's, but it cannot prevent a
CLI write that lands between Desktop's read and its write. Making both editions
follow one protocol needs a separate, reviewed change in the CLI repository,
which this project must not make.

## M4 — Release readiness

- Run offline suites and Windows real-editor workflow checks.
- Verify security boundaries, keyboard/screen-reader flows, attribution,
  artifact provenance, checksums, signing status, and update behavior.
- Document installation and supported platform/profile combinations.
- Publish only after explicit owner authorization.

MacOS, Linux, and Windows/WSL cross-home sharing follow separate evidence-backed
milestones after the Windows release gate.

## M4 status (evidence complete; release not authorized)

Release evidence is produced by `scripts/verify-release.ps1`, which checks
artifact checksums, manifest provenance against `sources.lock.json`, packaged
editor identity, license notices, and the bundled agent. It writes
`release-verification.json` and never claims signing or publication.

It also opens the shipped zip and asserts the agent is really inside it. A
packaging-only rebuild skips the non-native extension task and would otherwise
produce an editor with no agent that still passed every other check.

Installation, supported platform combinations, data locations, and known
limitations are documented in [INSTALL.md](docs/INSTALL.md).

**Not done:** code signing, provenance attestation, an update channel, and
artifact publication. A `config.json` protocol that both editions follow is
also still outstanding. Publishing requires explicit owner authorization and
has not been requested or performed.

## M5 — Provenance and license compliance

Everything here is Desktop-owned and verifiable without publishing anything.
Signing and the update channel are explicitly out of scope for M5 because both
require owner authorization to distribute anything.

- Emit a machine-readable provenance attestation beside the artifacts: pinned
  upstream revisions, the commit each artifact was built from, per-artifact
  SHA-256 and size, and the bundled agent's revision. It must be regenerable
  and byte-stable, and `verify-release.ps1` must reject one that disagrees with
  `sources.lock.json` or the manifest.
- Generate a third-party license notice from what actually ships, covering the
  Code OSS/VSCodium inputs and the vendored Moderado agent, and verify that the
  notices referenced exist in the packaged editor. A notice that cannot be
  produced from the real package must fail rather than be hand-written.
- Add the explicit opt-in smoke procedure for live model calls that
  [AGENTS.md](../AGENTS.md) requires. It must refuse to run without an explicit
  opt-in flag, must never run in CI, must not persist the API key, and must be
  separate from the offline suite.

**Done when:** the attestation and notices are generated from the real build,
verification fails on a tampered attestation or a missing notice, and the smoke
procedure has been shown to refuse by default.

# Project Handoff

Updated: 2026-10-02 UTC
Branch: master  
Commit: `992898e` plus the M4 commit recorded below  
Status: M1–M4 implemented and verified; M4 signing/publication not authorized

## Summary

Moderado Desktop is an independent, self-contained IDE project planned around
Code OSS/VSCodium build inputs and the pinned Moderado agent packages. A local
Windows x64 editor package and installers have been built and verified. Nothing
is published or signed, and no Moderado agent integration exists yet.

## Completed

- Defined product requirements, contributor boundaries, upstream policy,
  shared-profile contract, delivery roadmap, and independent version.
- Selected Windows x64 as the first target and a CLI `v0.3.10` behavioral
  reference without altering the CLI repository.

## In progress

- Nothing is in progress. M4 release *evidence* is complete; signing and
  publication are blocked on owner authorization and were not requested.

## Working tree

- Independent Git repository on `master`; M4 evidence, documentation, and the
  release verification script are committed here.

## Checks

- Build artifacts and their SHA-256 values verified against
  `.cache/vscodium/assets/build-manifest.json`.
- Editor-host launch, open-folder, and terminal: PASS.
- Install and uninstall on the build account: PASS.
- Clean-account install/uninstall in Windows Sandbox: PASS.
- Agent extension offline suite: 65/65 passing; typecheck clean.
- `scripts/verify-release.ps1`: 19/19 checks pass against the 2026-10-02
  artifacts, including that the shipped zip actually contains the agent.

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

- No current toolchain blocker is confirmed. The earlier missing Spectre
  libraries have been installed; dependency installation must finish before
  the VSCodium packaging step can start.

## Source pinning milestone (2026-09-30 UTC)

- Added `sources.lock.json` with exact VSCodium `1.135.06055`, its Code OSS
  `1.135.0` source commit, and Moderado CLI `v0.3.10` revisions.
- Confirmed VSCodium's `upstream/stable.json` pins Code OSS commit
  `08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`; confirmed both tags and full
  commit IDs with `git ls-remote` and local source clones.
- Corrected the earlier CLI snapshot: published v0.3.10 is annotated tag object
  `638008f99eb59209d0d2830b95d9b0cd2a09b225`, peeling to
  `a293c1d84d28d1b126fc7054a0f57011edc9d62c`. The previous
  `44251dce6cca0a3385196284c7b993e8ee964e0f` is not an ancestor of that tag.
- VSCodium's Windows build guide requires Git Bash, Node 24.18.0, jq,
  Python 3.11, Rustup, and 7-Zip. Node 24.18.0 and Rust are present; jq and
  7-Zip are absent, Python 3.14.6 is installed, and the available `bash.exe`
  resolves to WSL whose distribution access is denied. No `product.json`
  Desktop overlay exists.
- No editor source build or tests were run. Temporary source clones were kept
  under `.cache` and removed after inspection.

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

## Windows build attempt (2026-10-01 UTC)

- Added Desktop-owned `branding/product.json` with Moderado Desktop identity,
  unique data/protocol IDs, and Open VSX gallery settings. Applied it only to
  the ignored VSCodium build checkout under `.cache`.
- Cloned pinned VSCodium `1.135.06055` and its Code OSS `1.135.0` source into
  `.cache/vscodium`; VSCodium preparation patches completed successfully.
- Environment confirmed: Node 24.18.0, Git Bash, jq 1.8.2, Python 3.11.15,
  7-Zip, Rust, and Visual Studio 2026 Build Tools.
- Command attempted from the Code OSS checkout:
  `npm ci` with `PYTHON`/`npm_config_python` set to Python 3.11.15,
  Electron/Playwright binary downloads skipped, and `vs2022_install` pointing
  to Visual Studio 2026 Build Tools. Result: FAIL at native addon build,
  `MSB8040: Spectre-mitigated libraries are required` for
  `@vscode/deviceid`.
- Located the correct catalog component ID:
  `Component.VC.14.50.18.0.x86.x64.Spectre`. Installer CLI attempts returned
  without adding the component; `vswhere` confirms it remains absent. The
  installer log reports exit code 5007: quiet operations must start elevated.
- The follow-up `setup.exe ... --passive --norestart` RunAs attempt loaded the
  instance manifest but did not install the component. `vswhere` still does
  not list it and `lib\x64\spectre` is absent.
- No application artifact was produced. Do not claim the app builds until the
  component is installed and compile commands complete successfully.

To unblock from an elevated PowerShell prompt, run:
`& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe' modify --installPath 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools' --add Component.VC.14.50.18.0.x86.x64.Spectre --quiet --norestart`
Then verify with:
`& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -products '*' -requires Component.VC.14.50.18.0.x86.x64.Spectre -property installationPath`

## Milestone 1 status (2026-10-01 client date)

- Foundation inputs are present: immutable revisions in `sources.lock.json`,
  preserved upstream license files in the ignored VSCodium build checkout,
  and a Desktop product overlay in `branding/product.json`.
- The pinned VSCodium checkout is prepared under `.cache/vscodium`, with only
  its local `product.json` overlay modified. The source checkout is ignored and
  is not a deliverable artifact.
- At the start of the 2026-10-01 build attempt, the x86/x64 Spectre library
  directories were empty. After installation, they contain libraries under
  `VC\Tools\MSVC\14.51.36231\lib\spectre`; the 14.51 x86/x64 Spectre
  component is the one matching this installed toolset.
- `npm ci` completed successfully from the pinned Code OSS checkout with Node
  24.18.0 and the Visual Studio 2026 MSVC 14.51 Spectre libraries.
- The main Code OSS source compilation and native/non-native extension bundles
  passed. VSCodium packaging attempts exposed environment and invocation
  issues: the tested package tree was built from the inner Code OSS checkout,
  and an early packaging attempt ran with Electron downloads disabled, leaving
  a Node executable in place of the Electron launcher. These outputs are
  diagnostic only and are not M1 artifacts.
- The locally cached Electron 42.8.1 x64 archive matches the pinned
  `build/checksums/electron.txt` SHA-256 (`7a1aff619f94ead8a377d82e1f59bfd9a31a17db5b948f82fc5e60d576fe9304`).
  This verifies the archive only; it does not validate an assembled Desktop
  package.
- M1 is **functionally complete**; the evidence below was produced on
  2026-10-01 from the pinned revisions. No agent integration is claimed at this
  gate, and nothing is published or signed.

### M1 verification evidence (2026-10-01)

Build artifacts, with SHA-256 and sizes recorded in
`.cache/vscodium/assets/build-manifest.json`:

| Artifact | Bytes | SHA-256 (first 16) |
| --- | --- | --- |
| `Moderado Desktop-win32-x64-1.135.06055.zip` | 312528587 | `F61E6FFEEF6E03C2` |
| `Moderado DesktopSetup-x64-1.135.06055.exe` | 212996704 | `1693D0AEA0AA1288` |
| `Moderado DesktopUserSetup-x64-1.135.06055.exe` | 212996967 | `AAABB391CA8FD775` |

The manifest records `desktopVersion v0.1.0+2610013`, VSCodium
`5a73682ca091082675b10c9dc3f348c1d824d94f`, Code OSS
`08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`, and the pinned Moderado
reference `a293c1d84d28d1b126fc7054a0f57011edc9d62c`. `scripts/build-m1.ps1`
re-checks both editor revisions against `sources.lock.json` and rejects stale
artifacts before writing the manifest.

Distinct identity confirmed in the packaged
`VSCode-win32-x64/resources/app/product.json`: `Moderado Desktop`,
`.moderado-desktop` data folder, `moderado-desktop` URL scheme,
`Moderado.Desktop` AUMID, `moderadodesktop` mutex, Desktop-specific AppIDs and
CLSIDs, Open VSX gallery, and empty update/download URLs.

Real editor-host check, `.cache/m1-final-check/`:

- `extension-result.json` — folder opened and a live terminal PID returned.
- `terminal-result.txt` — `terminal-ok`.
- `host-profile/logs/20261001T160305/` — extension host started and
  `moderado.moderado-m1-smoke` activated, confirming a real host rather than a
  mocked `vscode` module.

Install/uninstall on the build account:

- `install.log` — UserSetup installed to a scratch directory and launched
  `Moderado Desktop.exe`.
- `uninstall.log` — "Uninstallation process succeeded… Removed all? Yes".

Clean-account check in a Windows Sandbox VM under `WDAGUtilityAccount`,
`sandbox-shared/result.json`:

```json
{ "account": "25A58DCF-2085-4\\WDAGUtilityAccount", "installExit": 0,
  "installed": true, "productName": "Moderado Desktop",
  "uninstallExit": 0, "executableRemoved": true }
```

### Milestone 2 evidence (agent integration)

**Vendored agent.** `scripts/vendor-moderado.ps1` exports the pinned packages
with `git archive` at commit `a293c1d84d28d1b126fc7054a0f57011edc9d62c`
(53 files, tree hash `5c279cc86652fe179fb585af6edc4a237f4d8f4a1c674f4efe31a3c9f7dded14`,
recorded in `vendor/moderado/VENDORED.json`). The CLI working tree was verified
clean and unmodified before and after. All four packages compile with
`npm run build` in `vendor/moderado`.

**Fail-closed approval boundary.** `extensions/moderado-agent/src/approval.ts`
closes the gaps the PRD records against the current core:

- A decision is honoured only when its `requestId` matches the pending request;
  a mismatch, a malformed shape, a closed view, a host-enforced timeout,
  cancellation, or a non-interactive context all **deny**.
- The host owns an explicit deadline because the core's `timeoutSeconds` field
  is not enforced.
- A write or command without a complete preview is denied rather than approved.

**Offline suite.** `npx vitest run` in `extensions/moderado-agent`:
**38 passed / 38** across 3 files (12 approval, 11 profile, 15 host). Coverage
includes approval deny on denial, timeout, mismatch, closed UI, cancellation and
non-interactive contexts; that no file is written when approval fails;
workspace-jail traversal refusal; a bounded agent turn against the vendored core
using its fake provider, asserting free-first routing selects
`mock/free-tool-model` rather than the paid model; session persistence and resume
against an isolated fixture home; and corrupt-config / corrupt-session handling.

**Typecheck and bundle.** `npx tsc --noEmit` exits 0. `npm run compile`
(esbuild) emits `dist/extension.js` + `dist/agent-core.js`, about 256 KiB total,
with `vscode` external and the vendored agent inlined.

**Real editor-host check.** The bundle was loaded by the M1 Windows editor in a
real extension host (`exthost.log` shows
`ExtensionService#_doActivateExtension moderado.moderado-agent`), and the host
check reported:

```json
{ "ok": true,
  "checks": { "found": true, "isActive": true, "expectedCommandsPresent": true,
    "commands": ["moderado.cancelRun", "moderado.configureProvider",
      "moderado.openChat", "moderado.selectModel", "moderado.togglePlanMode"] } }
```

Three bundling defects were found and fixed by making the build fail loudly
rather than silently shipping an unusable bundle: esbuild emitted ESM exports as
dead code (`0 && (module.exports = …)`), the entry resolved `require` against
esbuild's generated `main.node_modules` directory, and the exported global was
never defined. `scripts/bundle.mjs` now asserts a reachable `module.exports` and
smoke-loads the bundle against a stubbed host before exiting.

### Milestone 3 evidence (shared profile compatibility)

**Round-trip against the pinned CLI.** `test/profile.test.ts` loads the sibling
CLI's compiled `apps/cli/dist/sessions.js` and exchanges real records:

| Case | Result |
| --- | --- |
| Desktop reads a session the CLI wrote | PASS |
| The CLI reads a session Desktop wrote | PASS |
| Both resolve the same session directory for one workspace | PASS |
| Both accept/reject the same session records | PASS |

A CLI-written record is found by Desktop in the CLI's own hash directory, and a
Desktop-written record is listed by the CLI's `listSessions`. The tests skip
themselves if the CLI `dist` is absent rather than silently passing.

**Credential references.** `credentialReference` reproduces the CLI's
normalization exactly (trim, lowercase, each run outside `[a-z0-9_-]` becomes one
hyphen) and `resolveCredential` preserves its precedence: environment, then
credential reference, then legacy plaintext. `WindowsCredentialStore` reaches
Credential Manager through an encoded PowerShell bridge spawned with
`shell: false`; the key travels only over stdin, and failures raise a message
that names neither the secret nor the reference.

**Coordinated config writes.** `updateConfigCoordinated` takes a `wx` lock file,
re-reads `config.json` *inside* the lock, and merges one level deep so a sibling's
connection is not dropped. Where Desktop declares a field it owns, `expected`
detects that another process changed it and refuses to write, leaving the other
process's value intact. The lock is removed afterwards and an abandoned lock
older than the timeout is reclaimed.

**Session conflicts.** `saveSessionChecked` compares the `updatedAt` Desktop last
read against what is on disk. On a mismatch it refuses and reports a
`session_conflict` event, and the test asserts the CLI's message survives. The
comparison is on the recorded timestamp rather than file mtime because mtime
granularity is too coarse to catch a same-millisecond write.

**Skills.** `discoverSkills` reads `skills/<name>/SKILL.md` from the shared
tree, bounds the size, and reports empty or unreadable entries instead of
dropping them silently. Skill bodies remain untrusted content.

**Suite.** `npx vitest run`: **58 passed / 58** across 3 files (12 approval, 31
profile/session including the CLI round-trips, 15 host). `tsc --noEmit` exits 0.
The bundle is about 403 KiB and the extension activates in the real editor host
with all six commands registered.

**Known limit.** The CLI does not participate in Desktop's lock. Desktop's write
is therefore atomic and conflict-aware, and it re-reads under the lock, but a CLI
write landing between Desktop's read and its write can still be lost. Closing
that requires a protocol both editions follow, delivered as a separate reviewed
CLI change.

### Milestone 2 follow-ups

- **Profile and session layer added.** `src/profile.ts` canonicalizes the
  workspace root (resolving symlinks, Windows verbatim prefixes, drive-letter
  case, and trailing separators) and reads the shared `config.json`,
  distinguishing *missing* from *invalid* so a corrupt profile is never
  overwritten with defaults. `mergeConfig` merges Desktop-owned fields onto the
  parsed document, so unknown CLI fields survive. `src/sessions.ts` mirrors the
  CLI's `StoredSessionSchema` and directory hash, writes atomically, and reports
  corrupt session records instead of silently skipping them.
- **Chat surface added.** A dependency-free webview renders the transcript,
  coalesces streamed assistant deltas, and presents approvals as Allow/Deny
  buttons; a modal dialog remains the fallback when no view is open. Closing the
  view denies anything still pending.
- `moderado.configureProvider` now writes the API key to Windows Credential
  Manager through the existing encoded bridge and records only the resulting
  `credentialReference` in `config.json`. A failed key write leaves
  `config.json` untouched. Keys are never typed into an editor setting or sent
  to a renderer.
- **No live provider call is evidenced.** `resolveProvider` builds a real
  `OpenAICompatibleAdapter`/`NvidiaAdapter` when a key resolves, but every
  recorded run and the editor-host check used a profile with no key, so the
  fake provider path is what actually ran. The real-adapter path is covered by
  offline construction tests, not by a verified model call.
- Sessions persist and resume, but only within Desktop. Cross-process
  round-trip against a pinned CLI release, including the workspace-hash
  compatibility question, is the next milestone's work.
- **Test-isolation defect found and fixed.** Two run tests omitted the isolated
  `moderadoHome` fixture and briefly wrote session files into the developer's
  real `~/.moderado`. Both now pass an isolated temporary home, and a test run
  was confirmed to leave the real profile unchanged (447 files before and after).
  Any future run test must pass `moderadoHome`.
- The rebuilt editor package that would carry the final AppIDs and this
  extension has not been produced. The extension is verified against the
  unpacked M1 editor, not a newly installed Desktop package.

### M1 follow-ups before M2

- Windows AppIDs and context-menu CLSIDs in `branding/product.json` were
  hand-authored placeholders. They have been replaced with freshly generated
  GUIDs, but the packages verified above were built with the placeholder values
  and must be rebuilt before those identities are treated as final.
- Artifacts are unsigned and local-only. Signing, provenance, and the update
  channel remain M4 work.

### Milestone 5 evidence (provenance and license compliance)

**Compliance gap found and fixed.** Writing the notice generator surfaced a
real defect: upstream packaging copies Electron's `LICENSES.chromium.html` into
the portable editor but **not** the Code OSS `LICENSE.txt`. The shipped package
was redistributing MIT-licensed code with no copy of that license.
`gen-provenance.ps1` refused to run because the notice was absent, which is
the failure mode it was written to have. `build-m1.ps1` now copies
`LICENSE.txt` and the Desktop license into the portable editor before the
archive is created. Confirmed present in the shipped zip:

```
LICENSE.txt
LICENSES.chromium.html
Moderado Desktop LICENSE
resources/app/extensions/moderado-agent/dist/extension.js
```

**Attestation.** `scripts/gen-provenance.ps1` writes `provenance.json` and
`THIRD-PARTY-NOTICES.md` from the build manifest, `sources.lock.json`, and the
packaged editor. It recomputes every artifact digest rather than copying it, so
a corrupted artifact cannot be blessed by re-reading the file that describes it,
and it throws on a missing pin or notice rather than emitting a plausible file.
It records `signed: false` and `published: false`: it is an **unsigned build
record**, not a signature, and does not prove anything to a third party.

**Verification is adversarial.** `verify-release.ps1` re-hashes the
attestation's artifacts and re-measures the notices it claims, rather than
trusting the attestation to agree with itself. Both tamper classes were
confirmed to fail:

| Tamper | Check that caught it |
| --- | --- |
| Altered a recorded artifact size | `provenance:licenseNoticesShip` |
| Altered a recorded artifact `sha256` | `provenance:artifactDigests` |

Full run after restoring the real attestation: **28/28 checks pass**, exit 0.

**Live provider smoke gate.** `scripts/live-provider-smoke.ps1` is the explicit
opt-in procedure AGENTS.md requires. Confirmed refusals:

| Invocation | Exit | Result |
| --- | --- | --- |
| No flags | 1 | "Refusing to run: a live smoke procedure contacts a real provider and costs money." |
| `-IUnderstandThisCallsALiveModel` with `CI=true` | 1 | "Refusing to run: a CI environment is detected." |

It performs no file mutation, runs no commands, and never writes or logs the
API key.

**Artifacts** (`v0.1.0+261002a`, built from `3e37533`):

| Artifact | Bytes | SHA-256 (first 16) |
| --- | --- | --- |
| `Moderado Desktop-win32-x64-1.135.06055.zip` | 241318263 | `61AC504082CE629A` |
| `Moderado DesktopSetup-x64-1.135.06055.exe` | 167773565 | `33247F4F3BA8C131` |
| `Moderado DesktopUserSetup-x64-1.135.06055.exe` | 167773936 | `47F8C9907F1C4D52` |

**Build note.** `tsgo` still crashed at the default concurrency of 4, this time
with Windows status `0xC000012D`. `MODERADO_TSGO_CONCURRENCY=2` completed
cleanly, so the safe default for this machine is 2.

**Still not done.** No code signing, no update channel, no publication, and no
verified live model call. The vendored agent packages carry no `license` field,
which the generated notice flags as something to confirm upstream before any
public distribution.

### Milestone 4 evidence (release readiness)

**Release verification.** `scripts/verify-release.ps1` checks artifact
checksums, manifest provenance against `sources.lock.json`, packaged editor
identity, license notices, and the bundled agent. It writes
`release-verification.json` with `signed: false` and `published: false`, and
fails loudly rather than reporting a clean run.

All 19 checks pass against the artifacts built on 2026-10-02 for
`v0.1.0+2610026`:

| Artifact | Bytes | SHA-256 (first 16) |
| --- | --- | --- |
| `Moderado Desktop-win32-x64-1.135.06055.zip` | 312763436 | `BBDB3BB046760EFF` |
| `Moderado DesktopSetup-x64-1.135.06055.exe` | 213115206 | `57D66351F425C34A` |
| `Moderado DesktopUserSetup-x64-1.135.06055.exe` | 213115578 | `4D830B853596FAEB` |

**Two defects found and fixed while finishing M4.**

- The extension check resolved the staged directory as
  `assets\..\..\vscode\extensions\...`, i.e. `.cache\vscode\...`, which does not
  exist, so it reported a present bundle as missing.
- The check also read the pinned agent from `manifest.sources.moderado`, but
  `build-m1.ps1` records it as `pinnedAgentRevisionForMilestone2`. The
  comparison silently never matched real evidence.

**A packaging-only rebuild silently dropped the agent.** Rebuilding with
`-PackingOnly` skips `vscode-min-prepack`, which is where
`compile-non-native-extensions-build` packages local extensions. The resulting
editor and zip contained **no** `moderado-agent` at all (281.8 MB zip versus
312.7 MB with the agent), while every pre-existing check still passed because
they only inspected the staging checkout. The full `build-m1.ps1` run was
required.

`verify-release.ps1` now also opens the shipped zip and asserts that
`extensions/moderado-agent/dist/extension.js` is present, so an editor that
lost the agent cannot pass verification again. That check was confirmed to
fail against the agent-less archive before the rebuild.

**Real editor host, packaged bundle.** The freshly built editor was launched
with the extension taken from the packaged output.
`.cache/m4-hostcheck/user-ext/hostcheck.json`:

```json
{ "ok": true,
  "checks": { "found": true, "isActive": true, "expectedCommandsPresent": true,
    "commands": ["moderado.cancelRun", "moderado.configureProvider",
      "moderado.openChat", "moderado.selectModel", "moderado.showSessions",
      "moderado.togglePlanMode"] } }
```

`exthost.log` records `ExtensionService#_doActivateExtension
moderado.moderado-agent`, confirming a real host rather than a stub.

**Root cause of the repeated build failures: heap exhaustion.** Seven rebuilds
failed before one succeeded, each with a *different* error and none reproducible
in isolation — `npm list` failing inside vsce, `tsgo exited with code 2` or `1`
with no diagnostics emitted, and `css-language-features\esbuild.mts` failing
when it builds cleanly on its own. Running every extension `tsconfig.json`
through TS7 sequentially reported `FAILCOUNT=0` each time, which ruled out a
source defect and pointed at resources.

The final failed run printed the actual cause:
`FATAL ERROR: MarkCompactCollector ... JavaScript heap out of memory`. The gulp
process was dying from exhaustion at whichever step happened to be running, so
the visible error was effectively random.

Two fixes:

- `scripts/apply-branding.ps1` patches `build/lib/tsgo.ts` (the overlay already
  owns the reviewed downstream edits) to cap concurrent tsgo processes at 4.
  Upstream merges one typecheck stream per extension and starts them all at
  once. The patch is idempotent and changes no compiler flag; tune with
  `MODERADO_TSGO_CONCURRENCY`.
- `build-m1.ps1` raises `max-old-space-size` from 8192 to 12288, overridable with
  `MODERADO_BUILD_HEAP_MB`.

A full rebuild then completed with no heap exhaustion and no tsgo failure.

**Version/provenance loop closed.** The version hook bumps `VERSION` on every
commit, so the old `manifest:desktopVersion` check could never stay green: any
commit after a build reported a good build as stale. `build-m1.ps1` now records
`builtFromCommit`, and `verify-release.ps1` gates on that commit being an
ancestor of HEAD plus a clean source tree, with the version string reported as
informational only. Both new gates were confirmed to fail correctly — against a
diverged tree and against uncommitted source edits — before the build was
accepted.

**Suites.** `npx vitest run` 65/65 passed; `tsc --noEmit` exits 0.

**Still not done.** No code signing, no provenance attestation, no update
channel, and no publication. Publishing requires the owner's explicit
authorization and has not been requested. A live model call has not been
verified: provider resolution is implemented and unit-tested offline, but
every recorded run used the fake provider because no key was configured.

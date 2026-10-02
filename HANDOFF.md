# Project Handoff

Updated: 2026-10-01 UTC
Branch: master  
Commit: `e007516` (resolve with `git log -1`)  
Status: M1 evidence complete and committed; M2 agent integrated and verified

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

- M1 documentation and version control only; the build and all verification
  steps have completed (see the M1 verification evidence below).

## Working tree

- Independent Git repository; M1 scripts, branding, and documentation are being
  committed on `master`.

## Checks

- Build artifacts and their SHA-256 values verified against
  `.cache/vscodium/assets/build-manifest.json`.
- Editor-host launch, open-folder, and terminal: PASS.
- Install and uninstall on the build account: PASS.
- Clean-account install/uninstall in Windows Sandbox: PASS.
- Build and tests — no Desktop application source or test runner exists yet;
  Milestone 2 introduces the agent packages and their offline suites.

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
- `moderado.configureProvider` records only non-secret connection fields. API
  keys are never typed into an editor setting or sent to a renderer; Credential
  Manager references are not yet written, and no real provider adapter is
  connected — runs use the vendored fake provider.
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

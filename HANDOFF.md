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

- Exact source revisions are recorded in `sources.lock.json`, and the Desktop
  product overlay is prepared. Spectre libraries are installed; `npm ci` is
  running in the pinned Code OSS checkout. No editor packaging command has run.

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
- `npm ci` was restarted from the pinned Code OSS checkout with Node 24.18.0.
  The native dependency build has passed the earlier MSB8040 failure and the
  install is continuing through postinstall work. Final command outcome is
  pending; no editor artifact exists yet.
- Gate 1 is **not complete**. Launch, folder, terminal, install/uninstall, and
  clean-account checks have not run. Once `npm ci` finishes, continue the
  pinned VSCodium Windows packaging steps, inspect the artifact, and run those
  checks before declaring the milestone complete.

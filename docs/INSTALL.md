# Installing Moderado Desktop

> **Status: no release exists.** Everything below describes a local, unsigned
> build produced from pinned source. There is no download, no signature, and no
> update channel. See [HANDOFF.md](HANDOFF.md) for what has actually been
> verified.

## Supported platform

| | |
| --- | --- |
| Platform | Windows x64 only |
| Editor base | Code OSS `1.135.0`, built through VSCodium `1.135.06055` |
| Agent packages | Moderado CLI `v0.3.10` (`a293c1d8…`) |
| Architectures | x64 only; arm64 is not built or tested |

macOS, Linux, and Windows/WSL cross-home profile sharing are explicitly **not**
supported in this milestone. Windows and WSL have different home directories, so
they do not share a `~/.moderado` profile.

## Building locally

Prerequisites: Git Bash, Node 24.18.0, Python 3.11, jq, 7-Zip, Rust, and Visual
Studio Build Tools with the x64 Spectre libraries.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\vendor-moderado.ps1
cd vendor/moderado; npm install; npm run build; cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-m1.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-m1.ps1
```

`prepare-m1.ps1` is only needed once; it clones the pinned VSCodium revision,
fetches the pinned Code OSS revision, and installs its dependencies. Re-running it
fails on purpose rather than re-cloning over a prepared checkout.

## What you get

`build-m1.ps1` writes to `.cache/vscodium/assets/`:

| File | What it is |
| --- | --- |
| `Moderado Desktop-win32-x64-<version>.zip` | Portable editor, no installer |
| `Moderado DesktopSetup-x64-<version>.exe` | Per-machine installer (needs elevation) |
| `Moderado DesktopUserSetup-x64-<version>.exe` | Per-user installer, no elevation |
| `build-manifest.json` | `VERSION`, both upstream revisions, SHA-256 and size per artifact |

The build script verifies both editor revisions against `sources.lock.json`
before packaging and refuses to record a stale artifact.

Do **not** use `-PackingOnly` for a release build. It skips
`vscode-min-prepack`, which is the step that packages local (non-native)
extensions, so the editor is produced with no agent at all while still
looking healthy. `scripts/verify-release.ps1` now checks the shipped zip for
the agent for exactly this reason.

To re-check an existing build without rebuilding:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

## Signing

These artifacts are **unsigned**. Windows SmartScreen will warn, and there is no
Authenticode signature to validate. Signing requires a code-signing certificate
and an owner's release authorization; neither exists yet. Do not distribute
these builds.

## What works, and what does not

Working and verified on a real editor host:

- Launch, open a folder, integrated terminal
- Install and uninstall, including on a clean Windows account
- The Moderado agent extension: activation, chat view, streaming events,
  cancellation, and human approval for mutations and commands
- Session persistence and shared-profile reads/writes against `~/.moderado`

Not working yet:

- **No live provider.** Runs use a fake provider. Connecting a real provider,
  and resolving its key from Windows Credential Manager, is not wired up.
- **No signing, provenance, or update channel.**
- **Chat view only.** There is no diff renderer; previews appear as text.
- **Profile coordination is one-sided.** Desktop writes `config.json` under a
  lock and detects conflicting CLI changes, but the CLI does not take that lock,
  so a simultaneous CLI write can still be lost.

## Where data lives

| What | Where |
| --- | --- |
| Moderado agent config, sessions, skills | `%USERPROFILE%\.moderado\` (shared with the CLI) |
| Editor layout, extensions, caches | `%USERPROFILE%\.moderado-desktop\` |
| Editor shared storage | `%USERPROFILE%\.moderado-desktop-shared\` |

Editor state is deliberately separate from the agent profile, and neither
collides with VS Code or VSCodium.

## Uninstalling

The installer's uninstaller removes the installed editor. Moderado agent data
under `~/.moderado` is **not** removed, because the CLI also uses it; delete that
directory by hand only if you are certain you want to discard shared agent data.

## Third-party notices

The editor is built from MIT-licensed Code OSS through VSCodium's MIT-licensed
build scripts. `LICENSES.chromium.html` ships with the packaged editor and
carries the bundled Chromium/Electron third-party notices. Moderado's own code is
MIT; see [LICENSE](LICENSE).
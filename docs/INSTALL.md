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

## Signing

These artifacts are **unsigned**. Windows SmartScreen will warn, and there is no
Authenticode signature to validate. Signing requires a code-signing certificate
and an owner's release authorization; neither exists yet. Do not distribute
these builds.

## Provenance and notices

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\gen-provenance.ps1
```

Writes `provenance.json` and `THIRD-PARTY-NOTICES.md` next to the artifacts,
generated from the build manifest, `sources.lock.json`, and the packaged editor.
Nothing in them is hand-written; if an artifact's digest, an upstream pin, or a
license file is missing or disagrees, the script throws instead of emitting a
plausible-looking file.

`provenance.json` is an **unsigned build record**, not a signature. It states
what was produced; it does not prove it to a third party. There is still no
Authenticode signature.

The build now also copies `LICENSE.txt` (Code OSS, MIT) and the Desktop license
into the portable editor. Upstream packaging ships Electron's
`LICENSES.chromium.html` but not the MIT text, so the package previously
redistributed MIT-licensed code with no copy of that license.

## Live provider smoke procedure

Live model calls require explicit opt-in and never run in CI:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-provider-smoke.ps1
```

That command **refuses** and explains why. It only proceeds with
`-IUnderstandThisCallsALiveModel`, and it refuses again if `CI`,
`GITHUB_ACTIONS`, `BUILDKITE`, or `TF_BUILD` is set. It performs no file
mutation and runs no commands, and it never writes or logs the API key.

**Not done:** code signing, an update channel, and artifact publication.

## What works, and what does not

Working and verified on a real editor host:

- Launch, open a folder, integrated terminal
- Install and uninstall, including on a clean Windows account
- The Moderado agent extension: activation, chat view, streaming events,
  cancellation, and human approval for mutations and commands
- Session persistence and shared-profile reads/writes against `~/.moderado`

Not working yet:

- **Provider keys.** Runs and model discovery build their adapter from the
  active connection in `config.json`, using the vendored OpenAI-compatible or
  NVIDIA adapter, and resolve the key in the CLI's precedence order. There is
  still **no live model call in the verified evidence**: every recorded run
  used a profile with no resolvable key, so the fake provider path is what the
  tests and host check actually exercised. The real adapter path is covered by
  offline construction tests only.
- **No signing or update channel.** Provenance and third-party notices are
  generated and verified (M5), but nothing is signed or published.
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
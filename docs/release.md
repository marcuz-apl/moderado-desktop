# Release Checklist

## Version and tag

1. `feat:` work moves the patch digit: `npm run version:patch` (for example 0.4.6 → 0.4.7). `fix:`, `docs:`, and `build:` commits keep the semver and only advance the `+YYMMDD<n>` build counter. A minor bump is explicit (`npm run version:minor`) and the patch is capped at 99.
2. Land the change on `master`; the pre-commit hook syncs `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` with `VERSION`.
3. Write the release notes into [release-notes.md](./release-notes.md) — what changed since the previous tag, upgrade notes, install workarounds, and verification counts — and reference them from the README. Commit the docs **before** tagging so the tag carries them.
4. Tag the release: `git tag v0.4.49 && git push origin v0.4.49`. The tag triggers `.github/workflows/release.yml`.
5. Once all three matrix jobs have attached their installers, replace the default release body: `gh release edit v0.4.49 --notes-file docs/release-notes.md`. `tauri-action` creates the release with a one-line placeholder, so this step is manual.

## Pre-flight

- `npm run lint` (ESLint, `tsc --noEmit`, Clippy) and `npm test` (Rust + node) pass locally.
- `npm run test:browser` builds the frontend and drives the ten Chromium checks, 10/10 green.
- CI on `master` is green on Ubuntu, Windows, and macOS (`.github/workflows/ci.yml`).

## Artifacts

`tauri-action` publishes installers for every matrix OS:

| OS | Artifacts |
| --- | --- |
| Windows | MSI and NSIS `.exe` |
| macOS | `.dmg` (and `.app`) |
| Linux | `.AppImage` and `.deb` |

Bundle metadata (publisher, category, descriptions, copyright) lives in `src-tauri/tauri.conf.json`.

## Signing (deferred — releases ship unsigned)

Releases are published unsigned by decision on 2026-11-04: there is no certificate budget yet, and the installers still work with a one-time warning.

| OS | What an unsigned build does |
| --- | --- |
| Windows | SmartScreen says "Windows protected your PC" with an unknown publisher. **More info → Run anyway** installs; AppLocker or Smart App Control policies may refuse outright. |
| macOS | Gatekeeper blocks the first launch ("Apple could not verify…"). Right-click the app → **Open** once, or run `xattr -dr com.apple.quarantine "/Applications/Moderado Desktop.app"`. |
| Linux | Nothing — `.AppImage`, `.deb`, and `.rpm` install without warnings. |

When a certificate budget exists, in priority order:

- **macOS** — required for a clean install: Apple Developer Program, a Developer ID Application certificate, hardened runtime, notarization, and stapling. CI supplies `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus either an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`) or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for `notarytool`.
- **Windows** — strongly recommended: an OV or EV certificate held in a cloud HSM (Azure Trusted Signing, DigiCert KeyLocker, SSL.com eSigner). File-based `.pfx` signing is no longer accepted since June 2023. Configure `bundle.windows.certificateThumbprint` with `timestampUrl`, or a `signCommand` for the signing service, and keep only the provider credentials in repository secrets.
- **Linux** — no artifact signature is needed for GitHub Release downloads; GPG repository signing only matters if an apt or dnf repository is hosted.

The purchase decision and install workarounds are also recorded in project memory, so a future session does not treat the missing signature as a regression.

## Auto-update (not configured)

Tauri's updater needs a keypair and a hosting endpoint:

1. `npx tauri signer generate -w ~/.tauri/moderado.key`, then store the private key as `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
2. Add the public key to `plugins.updater.pubkey` in `tauri.conf.json`, set `bundle.createUpdaterArtifacts: true`, and add `tauri-plugin-updater` to the app.
3. Host `latest.json` at a stable endpoint and set `plugins.updater.endpoints`.

Until then the app does not self-update; users reinstall from the release page.

## GitHub sign-in (blocked on a GitHub App)

The Profile panel's GitHub sign-in needs a GitHub App client ID and secret supplied to the build. Without them the control stays unconfigured.

## Current status

- **Latest published release: v0.4.49** (2026-11-06). It covers the 20 commits since v0.4.43; see [release-notes.md](./release-notes.md).
- Installers: built by the tag workflow for Windows, macOS, and Linux. The standalone `--no-bundle` exe is built locally with `npm run build` and hash-verified before it replaces the daily-use binary.
- Signing: deferred; installers are unsigned and the documented workarounds apply.
- CI: Ubuntu 22.04, Windows, and macOS, including Clippy and the browser checks on each.
- Auto-update and GitHub sign-in: pending external credentials. Reinstall from the Releases page to upgrade.

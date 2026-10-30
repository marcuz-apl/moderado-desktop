# Release Checklist

## Version and tag

1. `feat:` work moves the patch digit: `npm run version:patch` (for example 0.4.6 → 0.4.7). `fix:`, `docs:`, and `build:` commits keep the semver and only advance the `+YYMMDD<n>` build counter. A minor bump is explicit (`npm run version:minor`) and the patch is capped at 99.
2. Land the change on `master`; the pre-commit hook syncs `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` with `VERSION`.
3. Tag the release: `git tag v0.4.6 && git push origin v0.4.6`. The tag triggers `.github/workflows/release.yml`.

## Pre-flight

- `npm run lint` (ESLint, `tsc --noEmit`, Clippy) and `npm test` (Rust + node) pass locally.
- CI on `master` is green on Ubuntu, Windows, and macOS (`.github/workflows/ci.yml`).

## Artifacts

`tauri-action` publishes installers for every matrix OS:

| OS | Artifacts |
| --- | --- |
| Windows | MSI and NSIS `.exe` |
| macOS | `.dmg` (and `.app`) |
| Linux | `.AppImage` and `.deb` |

Bundle metadata (publisher, category, descriptions, copyright) lives in `src-tauri/tauri.conf.json`.

## Signing (blocked on credentials)

Unsigned installers trigger SmartScreen and Gatekeeper warnings. To sign, add these repository secrets and the matching workflow steps:

- Windows: `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` (Authenticode).
- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for notarization.
- Linux: no signing required for AppImage or deb.

## Auto-update (not configured)

Tauri's updater needs a keypair and a hosting endpoint:

1. `npx tauri signer generate -w ~/.tauri/moderado.key`, then store the private key as `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
2. Add the public key to `plugins.updater.pubkey` in `tauri.conf.json`, set `bundle.createUpdaterArtifacts: true`, and add `tauri-plugin-updater` to the app.
3. Host `latest.json` at a stable endpoint and set `plugins.updater.endpoints`.

Until then the app does not self-update; users reinstall from the release page.

## GitHub sign-in (blocked on a GitHub App)

The Profile panel's GitHub sign-in needs a GitHub App client ID and secret supplied to the build. Without them the control stays unconfigured.

## Current status

- Installers: built by the tag workflow.
- CI: Ubuntu, Windows, and macOS, including Clippy on each.
- Signing, auto-update, and GitHub sign-in: pending external credentials.

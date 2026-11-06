# Release notes

## v0.4.49 — 2026-11-06

The second published release. It covers the 20 commits since [v0.4.43](https://github.com/marcuz-apl/moderado-desktop/releases/tag/v0.4.43) (2026-11-04). The semver moved from 0.4.43 to 0.4.49 because `feat:` commits now advance the patch digit; the `+YYMMDD<n>` suffix in `VERSION` is the per-commit build counter, not part of the release name.

### Interface

- **Nine interface languages** in Settings → Language, in a fixed order: English, Français, 简体中文, 繁體中文, 日本語, 한국어, Español, Deutsch, Русский. Switching to any language and back to English restores every label exactly; conversations, file names and user-typed names are never translated.
- **Docs and Settings are pages, not overlays.** The session header stays visible above them, so the title, workspace context, Plan/Act switch and theme toggle remain usable while on a page.
- **The version lives in the native window title only** (`Moderado Desktop · v0.4.49`). It is not repeated in the in-app chrome. Settings → About still shows it.
- **The Git rail button leaves Work mode entirely.** A Work task owns a managed folder, not a repository; the icon returns in Code mode, including when a Code session is selected from the Work Library.
- **Copy and Re-run** on every sent question, and **Copy** on every turn summary. Re-run resubmits the original prompt and attachments, keeps any composer draft, and queues behind a running turn. The Idle/Stop glyph is larger.
- **Shift + mouse wheel** over the conversation changes the context text size in 5% steps from 75% to 175%; **Shift + middle click** resets to 100%. It multiplies the chosen Settings text size, affects messages only (not the composer or sidebar), and persists between launches.
- Sent questions indent six 40px tab stops so the teal question box stays apart from the blue turn summary without eating the message width.

### Providers

- **llama.cpp** joins the provider matrix at `http://127.0.0.1:9931/v1`. Local availability probing is now generic, so llama.cpp, Ollama and LM Studio are all marked available or offline at startup without per-provider branches.
- **Local endpoints are IPv4.** Presets now spell `127.0.0.1` instead of `localhost`. On a dual-stack machine `localhost` resolves to `::1` first, so when two Ollama installs share port 11434 the app read a different server than the CLI and listed only that daemon's models. `completion_url` rewrites a saved `localhost` host to `127.0.0.1`; an explicit `[::1]` stays IPv6 and remote hosts are untouched.
- **API keys are filed by provider, not by endpoint.** Changing a base URL used to orphan the saved key under the old URL. `keychain.rs` keys entries on `ProviderId::slug()`, migrates an old URL-keyed secret on first read, and deletes the stale entry on save.

### Reliability and safety

- **The command sandbox no longer copies the whole workspace.** Windows and Linux share one exclusion list (`.git`, `node_modules`, `target`, `.venv`, `__pycache__`, `.next`), symlinks are skipped rather than rejected, files are streamed and hashed instead of held in memory, and change detection uses a SHA-256 fingerprint. Binary artifacts survive the copy-back, and large repositories no longer hit the 1 GB cap.
- **SQLite runs in WAL mode**, verified on each connection, so the 10-second scheduler writes and the UI no longer serialise into "database is locked" errors.
- A finished turn writes its history once; the error and cancel paths still save. **Checkpoints** are listed newest-first with a bound of 100, while older ones remain restorable by id.
- Translation bookkeeping uses `WeakMap`s, so discarded transcript nodes no longer stay alive for the life of the window.
- Win32 `unsafe` blocks carry `SAFETY` comments, and the AppContainer SID is owned by a guard so a failed launch cannot leak it.
- **The browser checks are part of the repository and of CI.** `npm run test:browser` builds the frontend and drives the ten `check-*.mjs` scripts in real Chromium; CI runs it on Ubuntu, Windows and macOS.
- `[profile.release]` uses one codegen unit, thin LTO, size optimization and stripping — the standalone Windows binary went from 17,325,056 to 11,839,488 bytes.
- `style.css` is no longer minified (3,142 lines, one declaration per line, max 120 characters), with a CI guard against drifting back. `lib.rs` and `main.ts` gained section banners instead of a premature split.
- `npm run commit -- "<type>: <subject>"` is the supported commit path. A `feat:` subject bumps the patch digit; a `commit-msg` hook rejects a raw feat commit that missed the bump. `MODERADO_VERSION_REPLAY=<id>` pins identifiers when replaying history.

### Upgrading

- Existing sessions, schedules, checkpoints and settings carry forward; **no manual migration** is needed. The database migrations are numbered and preserved.
- A previously saved `localhost` endpoint heals at request time — no need to re-edit Settings. If you deliberately run a server on IPv6 only, enter `[::1]` explicitly.
- A key saved under an old base URL is picked up and re-filed the first time that provider is used. Remote provider keys are unaffected.
- **There is no auto-update.** Download the new installer from the [Releases page](https://github.com/marcuz-apl/moderado-desktop/releases) and reinstall over the existing app.

### Artifacts and install

| OS | Artifacts |
| --- | --- |
| Windows | MSI and NSIS `.exe` |
| macOS | `.dmg` (and `.app`) |
| Linux | `.AppImage` and `.deb` |

Builds are **unsigned** by decision on 2026-11-04. Windows SmartScreen asks for **More info → Run anyway**; macOS Gatekeeper blocks the first launch, so right-click → **Open** once (or `xattr -dr com.apple.quarantine "/Applications/Moderado Desktop.app"`); Linux needs no workaround. See [release.md](./release.md#signing-deferred--releases-ship-unsigned) for the rationale and the signing plan.

### Verification

173 node tests, 153 Rust tests (+1 ignored), `tsc --noEmit`, ESLint, `cargo clippy -- -D warnings`, 10/10 browser checks, and a release build under the new profile. CI is green on Ubuntu 22.04, Windows and macOS.

---

## v0.4.43 — 2026-11-04

First published release: real steer injection into a running turn, a tighter Library, and the release workflow fixes that made the three-platform installers build. See [progress.md](./progress.md#first-published-release-v043-2026-11-04).

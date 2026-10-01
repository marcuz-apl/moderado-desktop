# Shared Moderado profile contract

## Scope

Desktop and CLI use the same current user's `~/.moderado/` for Moderado agent
data. The first supported sharing case is one Windows account running the
Windows Desktop app and Windows CLI. On that platform `~` is the account's
home directory, normally `%USERPROFILE%`; it is not the literal `$USER` path.
Windows and WSL normally have different home directories and path identities,
so cross-OS sharing is outside the first release.

| Location | Current CLI meaning | Desktop rule |
| --- | --- | --- |
| `config.json` | Provider connections, model and cost policy, MCP servers, enabled skills | Read existing values; preserve unknown fields; write only after safe cross-process coordination is implemented. |
| `sessions/<workspace-hash>/<id>.json` | Version 1 workspace session records | Use the same canonical workspace path before SHA-256 hashing; validate schema and preserve IDs/history. |
| `skills/<name>/SKILL.md` | User-installed skills | Discover and validate using the pinned Moderado behavior; do not execute instructions as authority. |
| `logs/` | CLI diagnostic output | Use a distinct Desktop log file and redact secrets. |
| `desktop/` | Unused by the CLI | Reserved for Desktop-specific Moderado state that does not belong in shared config. |

The editor's own layout, extension database, caches, and update metadata use
separate application data identified by Moderado Desktop. Their location must
not collide with VS Code, VSCodium, or the shared files above.

## Provider credentials

`config.json` may contain a credential reference, not the credential value.
The current Windows CLI uses Credential Manager targets of the form
`moderado/provider/<normalized-provider-id>`. Desktop must use the same target
when a connection has such a reference. Environment variables take precedence
in the existing CLI resolution path. A Desktop UI must never send the secret
to a renderer, store it in an editor setting, or print it in logs.

On non-Windows platforms the current CLI uses an in-memory credential store
plus environment or legacy config values; sharing a folder does not magically
share an OS keychain. Cross-platform secret persistence needs a separate
review before those Desktop builds are offered.

## Writes and migrations

The CLI currently writes `config.json` with a direct read/merge/write. Two
processes can therefore lose one another's changes, even if Desktop writes
atomically. Until both editions support a coordinated writer, Desktop may
read the shared config but must not claim safe simultaneous edits to it. The
profile-sharing delivery gate requires a tested common solution, delivered
through a separate CLI change if necessary; this Desktop repository may not
patch the CLI sibling in place.

Session saves use a temporary file and rename, but that only protects against
a partial file. Two active processes modifying the same session ID can still
overwrite each other's conversation. The first release will allow sequential
CLI/Desktop resume and distinct concurrent sessions; it must reject or
coordinate simultaneous writes to one session ID before claiming more.

For any schema migration: read and validate first, retain a recoverable copy,
write a new file atomically, and leave the original untouched on failure. Do
not discard unknown config fields, import plaintext keys into a renderer, or
silently replace a malformed profile with defaults.

The current CLI config loader returns an empty configuration on parse errors,
and its session listing skips corrupt records. Desktop must explicitly tell
apart "missing" and "invalid" before a write, and its interoperability tests
must cover these existing CLI behaviors.

## Behavior parity boundary

Provider/model eligibility and agent engine behavior follow the pinned CLI
source. Desktop deliberately requires a human decision for each mutation or
command by default. Current CLI handlers can auto-approve actions despite
the CLI repository's approval-first guideline. That discrepancy is known and
must be covered in Desktop compatibility documentation and tests; do not
represent the stricter Desktop default as current CLI parity.

## Verification fixtures

Tests use isolated home directories and fake credentials. Required cases:
CLI-created profile to Desktop, Desktop-created session to CLI, missing or
corrupt records, unknown config fields, credential references, differing
workspace path spellings, and simultaneous read/write attempts. No automated
test uses the developer's real `~/.moderado`.

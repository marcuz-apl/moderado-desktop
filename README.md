# Moderado Desktop

Moderado Desktop is a planned, independently installed coding IDE built from
the open Code OSS editor through VSCodium's downstream build approach. It will
bundle Moderado's provider-independent agent, model routing, workspace tools,
and approval UI. End users will not need to install Moderado CLI.

**Status:** Project documentation and repository scaffold only. No editor
source, runnable application, installer, or release has been created. The
`VERSION` file identifies this new project; it does not announce a published
Desktop build.

## Relationship to Moderado CLI

This is a separate repository and release train. The CLI remains the upstream
source for `@moderado/contracts`, `@moderado/core`, `@moderado/providers`, and
`@moderado/tools`. Desktop builds will pin a reviewed CLI source revision and
bundle those packages; they will not invoke or require an installed `moderado`
executable. Desktop work must not edit the sibling CLI repository.

Both editions use the current user's `~/.moderado/` for Moderado configuration,
sessions, and skills. On Windows, `~` means `%USERPROFILE%`. Provider secrets
stored by the CLI in Windows Credential Manager remain there and must be
resolved through the same credential references. Editor layout, extensions,
cache, and other IDE-specific state stay separate. See
[Profile compatibility](docs/PROFILE.md).

## Product direction

- Moderado-branded IDE with an editor, terminal, project navigation, and a
  first-class Moderado agent surface.
- The same provider presets, model discovery, free-first routing, and paid/unknown
  cost opt-in rules as the pinned Moderado engine.
- Explicit human approval by default for file mutations and command execution.
- Windows x64 as the first implementation and verification target.
- Small downstream patches so upstream editor security and compatibility updates
  remain feasible.

The [PRD](PRD.md) defines acceptance criteria, [AGENTS.md](AGENTS.md) governs
contributors, [upstream policy](docs/UPSTREAM.md) records source and licensing
boundaries, and the [roadmap](docs/ROADMAP.md) orders delivery. [HANDOFF.md](HANDOFF.md)
records the current state.

## Upstream sources

- [VSCodium](https://github.com/VSCodium/vscodium): MIT-licensed build scripts
  and downstream configuration for Code OSS.
- [Code OSS](https://github.com/microsoft/vscode): MIT-licensed editor source.
- [Moderado CLI](https://github.com/marcuz-apl/moderado): agent packages and
  the `v0.3.10` behavioral reference.

The project will preserve upstream license notices and use its own name, icons,
application identifiers, and update endpoints before any distribution.

## Repository development

After cloning, enable this repository's version hooks:

```sh
git config --local core.hooksPath .githooks
```

Use Conventional Commit subjects. Hooks advance the UTC daily build counter
and add the connected VERSION prefix. Set semantic version changes explicitly
in VERSION; major increments require owner approval. Planning history is in
[docs/planning](docs/planning/).

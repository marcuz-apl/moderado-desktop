# Upstream source and distribution policy

## Source chain

Moderado Desktop plans to use three independent source inputs:

1. [VSCodium](https://github.com/VSCodium/vscodium), an MIT-licensed repository
   of scripts and patches that builds Code OSS into redistributable binaries.
2. [Microsoft Code OSS](https://github.com/microsoft/vscode), the MIT-licensed
   editor source fetched by the downstream build process.
3. [Moderado CLI](https://github.com/marcuz-apl/moderado), the source of the
   agent contracts, core, provider adapters, and workspace tools.

VSCodium is not a vendored editor library and its released executable is not
the Desktop application. The Desktop project will build its own product from
pinned source inputs. It must preserve the required upstream copyright and
license notices and review third-party assets included by the build. The
Microsoft-branded VS Code distribution and its product assets are separate
from the MIT-licensed Code OSS source.

## Pinning and updates

Before implementation, record exact immutable revisions for VSCodium,
Code OSS, and Moderado in a Desktop-owned source lock/manifest. The first
Moderado behavior reference is CLI release `v0.3.10`; do not assume its npm
package exposes the internal workspaces as separate installable packages.
Build Moderado's internal packages from the pinned source revision and bundle
them with Desktop. A build must record source revisions and Desktop `VERSION`.

Update each upstream deliberately: read its release notes, rebase the small
downstream patch set, run offline Moderado tests, build the editor, exercise
the real editor-host flow, and inspect the produced artifact. An automatic
upstream fetch must never silently change a release build's source.

## Branding and services

The distributed editor uses Moderado names, icons, application and data-folder
identifiers, protocol handlers, installer IDs, and update endpoints. These
must be distinct from VS Code and VSCodium. The current VSCodium preparation
script changes these fields through `product.json`; Desktop needs its own
reviewed product overlay. Use Open VSX or another compatible, permitted
extension source rather than assuming Microsoft Visual Studio Marketplace
access in a derivative distribution. Do not bundle a third-party extension
without checking its license and redistribution rights.

## Release ownership

Desktop owns its own signing, checksums, artifact manifest, installer and
update channel. A successful CLI or VSCodium release does not certify a
Desktop release. Public publishing requires explicit owner approval after
the PRD release gate passes.

param(
  [string]$Checkout = (Join-Path $PSScriptRoot '..\.cache\vscodium'),
  [switch]$AssetsOnly,
  [switch]$PackingOnly
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$checkout = (Resolve-Path -LiteralPath $Checkout).Path
if (!$checkout.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Checkout must be inside the Desktop workspace.'
}
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'sources.lock.json') | ConvertFrom-Json
$outerRevision = (& git -C $checkout rev-parse HEAD).Trim()
$innerRevision = (& git -C (Join-Path $checkout 'vscode') rev-parse HEAD).Trim()
if ($outerRevision -ne $lock.sources.vscodium.commit -or $innerRevision -ne $lock.sources.codeOss.commit) {
  throw 'Editor source checkout does not match sources.lock.json.'
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'branding\make-icon.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-branding.ps1') -Checkout $checkout
if ($LASTEXITCODE -ne 0) { throw 'Branding failed.' }

# Build the bundled agent extension and install it into the editor checkout so
# the packaged Desktop ships with it. A failure must not silently produce an
# editor without the agent.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-agent-extension.ps1') -Checkout $checkout
if ($LASTEXITCODE -ne 0) { throw 'Agent extension build or install failed.' }

$env:APP_NAME = 'Moderado Desktop'
$env:BINARY_NAME = 'moderado-desktop'
$env:CI_BUILD = 'no'
$env:DISABLE_UPDATE = 'yes'
$env:MS_COMMIT = $lock.sources.codeOss.commit
$env:OS_NAME = 'windows'
$env:RELEASE_VERSION = $lock.sources.vscodium.version
$env:SHOULD_BUILD_CLI = 'no'
$env:SHOULD_BUILD_MSI = 'no'
$env:SHOULD_BUILD_MSI_NOUP = 'no'
$env:SHOULD_BUILD_REH = 'no'
$env:SHOULD_BUILD_REH_WEB = 'no'
$env:VSCODE_ARCH = 'x64'
$env:VSCODE_QUALITY = 'stable'
# The prepack/packing gulp process holds every extension stream in memory at once.
# At 8192 MiB it intermittently died with "JavaScript heap out of memory", which
# surfaced as several unrelated failures (tsgo exit 1/2 with no diagnostics,
# `npm list` failing inside vsce, esbuild failing). Raise it; override with
# MODERADO_BUILD_HEAP_MB when the machine has less headroom.
$heapMb = if ($env:MODERADO_BUILD_HEAP_MB) { $env:MODERADO_BUILD_HEAP_MB } else { '12288' }
$env:NODE_OPTIONS = "--max-old-space-size=$heapMb"
$env:VSCODE_SKIP_NODE_VERSION_CHECK = 'yes'
$env:Path = 'C:\Program Files\7-Zip;' + $env:Path
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
Remove-Item Env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue

$bash = 'C:\Program Files\Git\bin\bash.exe'
$posixCheckout = (& 'C:\Program Files\Git\usr\bin\cygpath.exe' -u $checkout).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Git Bash path conversion failed.' }
if (!$AssetsOnly) {
  $prepack = if ($PackingOnly) { '' } else { 'npm run gulp vscode-min-prepack && ' }
  & $bash -c "cd '$posixCheckout/vscode' && ${prepack}npm run gulp vscode-win32-x64-min-packing"
  if ($LASTEXITCODE -ne 0) { throw 'Editor packing failed.' }
}
$assetDir = Join-Path $checkout 'assets'
[System.IO.Directory]::CreateDirectory($assetDir) | Out-Null
$expected = @(
  "Moderado Desktop-win32-x64-$($lock.sources.vscodium.version).zip",
  "Moderado DesktopSetup-x64-$($lock.sources.vscodium.version).exe",
  "Moderado DesktopUserSetup-x64-$($lock.sources.vscodium.version).exe"
)
$zip = Join-Path $assetDir $expected[0]
if (Test-Path -LiteralPath $zip) {
  $archive = Join-Path $assetDir 'previous'
  [System.IO.Directory]::CreateDirectory($archive) | Out-Null
  Move-Item -LiteralPath $zip -Destination (Join-Path $archive ((Get-Date -Format 'yyyyMMddHHmmss') + '.zip'))
}
# Ship the MIT license texts in the portable editor.
#
# The upstream packaging copies Electron's `LICENSES.chromium.html` but not the
# Code OSS `LICENSE.txt`, so a Desktop package built straight from it
# redistributes MIT-licensed code with no copy of that license. Add it, plus
# Desktop's own license, before the archive is created. This runs before
# `prepare_assets.sh` so the files land in the zip and both installers.
$portable = Join-Path $checkout 'VSCode-win32-x64'
if (Test-Path -LiteralPath $portable) {
  Copy-Item -LiteralPath (Join-Path $checkout 'vscode\LICENSE.txt') -Destination (Join-Path $portable 'LICENSE.txt') -Force
  Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $portable 'Moderado Desktop LICENSE') -Force
}
$assetStart = [System.DateTime]::UtcNow
& $bash -c "cd '$posixCheckout' && . ./prepare_assets.sh"
if ($LASTEXITCODE -ne 0) { throw 'Windows asset packaging failed.' }

$artifacts = foreach ($name in $expected) {
  $file = Get-Item -LiteralPath (Join-Path $assetDir $name) -ErrorAction Stop
  if ($file.LastWriteTimeUtc -lt $assetStart.AddSeconds(-2)) { throw "Stale build artifact: $name" }
  [ordered]@{ name = $file.Name; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash; bytes = $file.Length }
}
$manifest = [ordered]@{
  # The commit this build was produced from. `desktopVersion` alone is not a
  # sufficient identity: the version hook bumps VERSION on every commit, so a
  # docs-only commit would otherwise invalidate an otherwise good manifest.
  builtFromCommit = (& git -C $root rev-parse HEAD).Trim()
  desktopVersion = (Get-Content -Raw -LiteralPath (Join-Path $root 'VERSION')).Trim()
  target = 'windows-x64'
  sources = [ordered]@{
    vscodium = $outerRevision
    codeOss = $innerRevision
  }
  pinnedAgentRevisionForMilestone2 = $lock.sources.moderado.commit
  artifacts = @($artifacts)
}
[System.IO.File]::WriteAllText((Join-Path $assetDir 'build-manifest.json'), ($manifest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

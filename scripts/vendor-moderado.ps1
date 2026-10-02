param(
  [string]$CliRepository = 'D:\projects\moderado',
  [string]$Output = 'vendor\moderado'
)

# Vendors the pinned Moderado packages from the sibling CLI repository into this
# repository. The CLI working tree is never modified: content is exported with
# `git archive` at the immutable revision recorded in sources.lock.json, so a
# moved CLI HEAD cannot silently change what Desktop bundles.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'sources.lock.json') | ConvertFrom-Json
$revision = $lock.sources.moderado.commit

# CI has no sibling checkout. Clone the pinned upstream into a cache directory
# when the local path is absent, so a runner and a developer produce the same
# vendored tree from the same immutable revision.
if (!(Test-Path -LiteralPath $CliRepository)) {
  $clone = Join-Path $root '.cache\cli-pinned'
  if (Test-Path -LiteralPath $clone) { Remove-Item -LiteralPath $clone -Recurse -Force }
  Write-Output "No local CLI checkout at $CliRepository; cloning pinned upstream."
  & git clone --no-checkout $lock.sources.moderado.repository $clone
  if ($LASTEXITCODE -ne 0) { throw "Clone of $($lock.sources.moderado.repository) failed." }
  $CliRepository = $clone
}

$repo = (Resolve-Path -LiteralPath $CliRepository).Path
$expected = (& git -C $repo cat-file -t $revision).Trim()
if ($LASTEXITCODE -ne 0 -or $expected -ne 'commit') {
  throw "Pinned Moderado revision $revision is not present in $repo."
}

$target = Join-Path $root $Output
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
[System.IO.Directory]::CreateDirectory($target) | Out-Null

$staging = Join-Path $root '.cache\vendor-staging'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
[System.IO.Directory]::CreateDirectory($staging) | Out-Null

# Export the pinned trees into a staging directory. A temporary tar file is used
# because piping `git archive` straight into `tar` is unreliable on Windows.
$archive = Join-Path $root '.cache\moderado-pinned.tar'
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
& git -C $repo archive --format=tar --output=$archive $revision packages package.json tsconfig.base.json
if ($LASTEXITCODE -ne 0) { throw 'Moderado source export failed.' }
& tar -xf $archive -C $staging
if ($LASTEXITCODE -ne 0) { throw 'Moderado source extraction failed.' }
Remove-Item -LiteralPath $archive -Force

$stagedPackages = Join-Path $staging 'packages'
if (!(Test-Path -LiteralPath $stagedPackages)) { throw 'Pinned export did not contain a packages directory.' }

# Test files are excluded: Desktop re-tests the vendored behaviour from its own
# suite and does not ship CLI tests.
Get-ChildItem -LiteralPath $stagedPackages -Recurse -Directory |
  Where-Object { $_.Name -in @('test', 'tests', '__tests__') } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

Copy-Item -LiteralPath $stagedPackages -Destination $target -Recurse -Force
Copy-Item -LiteralPath (Join-Path $staging 'package.json') -Destination (Join-Path $target 'workspace-package.json') -Force
if (Test-Path -LiteralPath (Join-Path $staging 'tsconfig.base.json')) {
  Copy-Item -LiteralPath (Join-Path $staging 'tsconfig.base.json') -Destination (Join-Path $target 'tsconfig.base.json') -Force
}
Remove-Item -LiteralPath $staging -Recurse -Force

$files = Get-ChildItem -LiteralPath $target -Recurse -File
$digest = [System.Security.Cryptography.SHA256]::Create()
$accumulator = [System.Text.StringBuilder]::new()
foreach ($file in ($files | Sort-Object FullName)) {
  $null = $accumulator.Append($file.FullName.Substring($target.Length).Replace('\', '/'))
  $null = $accumulator.Append(' ')
  $null = $accumulator.Append((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)
  $null = $accumulator.Append("`n")
}
$treeHash = ([System.BitConverter]::ToString($digest.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($accumulator.ToString())))).Replace('-', '').ToLowerInvariant()
$digest.Dispose()

$record = [ordered]@{
  pinnedCommit = $revision
  sourceRepository = (& git -C $repo remote get-url origin).Trim()
  fileCount = $files.Count
  treeHash = $treeHash
}
[System.IO.File]::WriteAllText(
  (Join-Path $target 'VENDORED.json'),
  ($record | ConvertTo-Json -Depth 5),
  [System.Text.UTF8Encoding]::new($false))
Write-Output "Vendored $($files.Count) files from Moderado $revision (tree $treeHash)."
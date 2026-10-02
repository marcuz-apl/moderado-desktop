param(
  [string]$Assets = (Join-Path $PSScriptRoot '..\.cache\vscodium\assets'),
  [switch]$SkipExtension
)

# Verifies the release evidence for the current build:
#   - every artifact named in build-manifest.json exists and matches its SHA-256
#   - the manifest records the expected pinned revisions and Desktop VERSION
#   - the packaged editor carries Moderado identity, not VS Code or VSCodium
#   - the agent extension is bundled and exports an activation contract
#   - required third-party license notices are present
#
# It reports facts. It never asserts that a release is publishable, and it cannot
# sign or publish anything.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$assetsPath = (Resolve-Path -LiteralPath $Assets).Path
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'sources.lock.json') | ConvertFrom-Json
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'VERSION')).Trim()

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result($name, $ok, $detail) {
  $results.Add([ordered]@{ check = $name; ok = [bool]$ok; detail = $detail })
}

$manifestPath = Join-Path $assetsPath 'build-manifest.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw "No build manifest at $manifestPath." }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

# 1. Artifact integrity.
foreach ($artifact in $manifest.artifacts) {
  $file = Join-Path $assetsPath $artifact.name
  if (!(Test-Path -LiteralPath $file)) {
    Add-Result "artifact:$($artifact.name)" $false 'missing'
    continue
  }
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  $bytes = (Get-Item -LiteralPath $file).Length
  $ok = ($hash -eq $artifact.sha256) -and ($bytes -eq $artifact.bytes)
  Add-Result "artifact:$($artifact.name)" $ok "sha256=$($hash.Substring(0,16)) bytes=$bytes"
}

# 2. Manifest provenance.
# The build records the commit it was produced from. Comparing that commit
# against the current history is stable: a later docs-only commit does not
# invalidate a good build, but a build from an unmerged or rewritten history
# still fails. `desktopVersion` is reported for information only.
$head = (& git -C $root rev-parse HEAD).Trim()
$built = if ($manifest.builtFromCommit) { [string]$manifest.builtFromCommit } else { '' }
if ($built) {
  & git -C $root merge-base --is-ancestor $built $head 2>$null
  Add-Result 'manifest:builtFromAncestor' ($LASTEXITCODE -eq 0) "built=$($built.Substring(0,8)) head=$($head.Substring(0,8))"
  $dirty = @(git -C $root status --porcelain --untracked-files=no)
  Add-Result 'manifest:noUncommittedSourceChanges' ($dirty.Count -eq 0) "changed files=$($dirty.Count)"
} else {
  # Manifest predates builtFromCommit. Fall back to the strict version check.
  Add-Result 'manifest:builtFromAncestor' ($manifest.desktopVersion -eq $version) "manifest=$($manifest.desktopVersion) VERSION=$version (no builtFromCommit recorded)"
}
Add-Result 'manifest:desktopVersionMatches' ($manifest.desktopVersion -eq $version) "manifest=$($manifest.desktopVersion) VERSION=$version"
Add-Result 'manifest:vscodiumPinned' ($manifest.sources.vscodium -eq $lock.sources.vscodium.commit) $manifest.sources.vscodium
Add-Result 'manifest:codeOssPinned' ($manifest.sources.codeOss -eq $lock.sources.codeOss.commit) $manifest.sources.codeOss
# The build records the pinned agent under its own key (not inside `sources`),
# so read it from where build-m1.ps1 actually writes it.
$manifestAgent = if ($manifest.pinnedAgentRevisionForMilestone2) { $manifest.pinnedAgentRevisionForMilestone2 } else { $manifest.sources.moderado }
Add-Result 'manifest:moderadoPinned' ($manifestAgent -eq $lock.sources.moderado.commit) $manifestAgent

# 3. Packaged editor identity.
$editor = Join-Path $assetsPath '..\VSCode-win32-x64'
$productPath = Join-Path $editor 'resources\app\product.json'
if (Test-Path -LiteralPath $productPath) {
  $product = Get-Content -Raw -LiteralPath $productPath | ConvertFrom-Json
  Add-Result 'identity:name' ($product.nameShort -eq 'Moderado Desktop') $product.nameShort
  Add-Result 'identity:dataFolder' ($product.dataFolderName -eq '.moderado-desktop') $product.dataFolderName
  Add-Result 'identity:urlProtocol' ($product.urlProtocol -eq 'moderado-desktop') $product.urlProtocol
  Add-Result 'identity:mutex' ($product.win32MutexName -eq 'moderadodesktop') $product.win32MutexName
  Add-Result 'identity:noUpdateChannel' ([string]::IsNullOrEmpty($product.updateUrl)) "updateUrl='$($product.updateUrl)'"

  # Distinct from upstream VS Code / VSCodium identifiers.
  $upstream = @('VSCodium', 'VSCodium - Insider', 'Code - OSS', '.vscode', 'vscode-insiders')
  $collisions = $upstream | Where-Object { $product.nameShort -eq $_ -or $product.dataFolderName -eq $_ }
  Add-Result 'identity:noUpstreamCollision' ($collisions.Count -eq 0) "collisions=$($collisions -join ',')"

  $licensePath = Join-Path $editor 'LICENSES.chromium.html'
  Add-Result 'notices:chromiumLicenses' (Test-Path -LiteralPath $licensePath) $licensePath
} else {
  Add-Result 'identity:packagedEditor' $false "no product.json under $editor"
}

# 4. Agent extension.
if (!$SkipExtension) {
  $extensionDir = Join-Path $assetsPath '..\vscode\extensions\moderado-agent'
  if (Test-Path -LiteralPath $extensionDir) {
    $entry = Join-Path $extensionDir 'dist\extension.js'
    $core = Join-Path $extensionDir 'dist\agent-core.js'
    Add-Result 'extension:bundled' ((Test-Path -LiteralPath $entry) -and (Test-Path -LiteralPath $core)) $extensionDir
    if (Test-Path -LiteralPath $entry) {
      $text = Get-Content -Raw -LiteralPath $entry
      Add-Result 'extension:exportsActivate' ($text -match 'activate') $entry
    }
  } else {
    Add-Result 'extension:bundled' $false "not installed in the editor checkout ($extensionDir)"
  }

  # The staged checkout is not evidence. Confirm the shipped archive actually
  # contains the agent, because a packaging-only rebuild can silently ship an
  # editor without it (the non-native extension task is skipped).
  $zipPath = Join-Path $assetsPath "Moderado Desktop-win32-x64-$($lock.sources.vscodium.version).zip"
  if (Test-Path -LiteralPath $zipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $agentEntries = @($archive.Entries | Where-Object { $_.FullName -match 'extensions/moderado-agent/' })
      Add-Result 'extension:inReleaseZip' ($agentEntries.Count -gt 0) "$($agentEntries.Count) agent entries in $([System.IO.Path]::GetFileName($zipPath))"
      $hasEntry = @($agentEntries | Where-Object { $_.FullName -match 'extensions/moderado-agent/dist/extension\.js$' }).Count -gt 0
      Add-Result 'extension:releaseZipHasEntry' $hasEntry 'dist/extension.js present in shipped archive'
    } finally {
      $archive.Dispose()
    }
  } else {
    Add-Result 'extension:inReleaseZip' $false "no release zip at $zipPath"
  }
}

# 5. Signing is never claimed.
$failed = @($results | Where-Object { -not $_.ok })
[ordered]@{
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  desktopVersion = $version
  signed = $false
  published = $false
  passed = ($failed.Count -eq 0)
  results = $results
} | ConvertTo-Json -Depth 6 | ForEach-Object {
  [System.IO.File]::WriteAllText(
    (Join-Path $assetsPath 'release-verification.json'),
    $_,
    [System.Text.UTF8Encoding]::new($false))
}

$results | Format-Table -AutoSize | Out-String | Write-Output
if ($failed.Count -gt 0) {
  throw "$($failed.Count) release verification check(s) failed. See release-verification.json."
}
Write-Output 'All release verification checks passed. Artifacts remain unsigned and unpublished.'
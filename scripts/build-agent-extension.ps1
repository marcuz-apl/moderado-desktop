param(
  [string]$Checkout = (Join-Path $PSScriptRoot '..\.cache\vscodium'),
  [switch]$SkipTests
)

# Builds the bundled agent extension and installs it into the editor checkout.
#
# The build is verified before installation: unit tests, typecheck, and a bundle
# smoke load all run first, so an extension that cannot activate in the host is
# never packaged into the editor.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$extension = Join-Path $root 'extensions\moderado-agent'
$vendor = Join-Path $root 'vendor\moderado'

if (!(Test-Path -LiteralPath $extension)) { throw 'Agent extension source is missing.' }
if (!(Test-Path -LiteralPath (Join-Path $vendor 'packages\core\dist\index.js'))) {
  throw 'Vendored Moderado packages are not built. Run scripts/vendor-moderado.ps1, then npm run build in vendor/moderado.'
}

Push-Location $vendor
try { & npm run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Vendored Moderado packages failed to build.' }

Push-Location $extension
try {
  if (!$SkipTests) {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'Agent extension tests failed; refusing to package.' }
  }
  & npm run compile
  if ($LASTEXITCODE -ne 0) { throw 'Agent extension bundle failed.' }
} finally { Pop-Location }

$checkoutPath = (Resolve-Path -LiteralPath $Checkout).Path
if (!$checkoutPath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Checkout must be inside the Desktop workspace.'
}
$target = Join-Path $checkoutPath 'vscode\extensions\moderado-agent'
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
[System.IO.Directory]::CreateDirectory($target) | Out-Null

# Ship the manifest and the built bundle only. No node_modules and no sources:
# the agent is self-contained and nothing should resolve at runtime.
Copy-Item -LiteralPath (Join-Path $extension 'package.json') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $extension 'dist') -Destination (Join-Path $target 'dist') -Recurse -Force

$bundled = Join-Path $target 'dist\extension.js'
if (!(Test-Path -LiteralPath $bundled)) { throw 'Agent bundle was not installed.' }
Write-Output "Installed agent extension to $target ($((Get-Item $bundled).Length) bytes)."
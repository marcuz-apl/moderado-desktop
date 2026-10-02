param([string]$Checkout = (Join-Path $PSScriptRoot '..\.cache\vscodium'))

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$checkout = (Resolve-Path -LiteralPath $Checkout).Path
if (!$checkout.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Checkout must be inside the Desktop workspace.'
}
$editor = Join-Path $checkout 'vscode'
$overlay = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\branding\product.json') | ConvertFrom-Json
$outerProduct = Join-Path $checkout 'product.json'
$innerProduct = Join-Path $editor 'product.json'
$installer = Join-Path $editor 'build\win32\code.iss'
$electronBuild = Join-Path $editor 'build\lib\electron.ts'
$icon = Join-Path $PSScriptRoot '..\branding\moderado-desktop.ico'
$utf8 = [System.Text.UTF8Encoding]::new($false)

if (!(Test-Path -LiteralPath $innerProduct) -or !(Test-Path -LiteralPath $installer) -or !(Test-Path -LiteralPath $electronBuild) -or !(Test-Path -LiteralPath $icon)) {
  throw 'Prepared editor source or Desktop icon is missing.'
}

[System.IO.File]::WriteAllText($outerProduct, ($overlay | ConvertTo-Json -Depth 30), $utf8)
$product = Get-Content -Raw -LiteralPath $innerProduct | ConvertFrom-Json
foreach ($entry in $overlay.PSObject.Properties) {
  $product | Add-Member -NotePropertyName $entry.Name -NotePropertyValue $entry.Value -Force
}
[System.IO.File]::WriteAllText($innerProduct, ($product | ConvertTo-Json -Depth 100), $utf8)

$installerText = Get-Content -Raw -LiteralPath $installer
$installerText = $installerText.Replace('AppPublisher=VSCodium', 'AppPublisher=Moderado Desktop')
$installerText = $installerText.Replace('https://vscodium.com/', 'https://github.com/marcuz-apl/moderado-desktop')
[System.IO.File]::WriteAllText($installer, $installerText, $utf8)
$electronText = Get-Content -Raw -LiteralPath $electronBuild
$electronText = $electronText.Replace("companyName: 'VSCodium'", "companyName: 'Moderado Desktop'")
[System.IO.File]::WriteAllText($electronBuild, $electronText, $utf8)
Copy-Item -LiteralPath $icon -Destination (Join-Path $editor 'resources\win32\code.ico') -Force
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\branding\generated') -File | ForEach-Object {
  $target = Join-Path $editor ('resources\win32\' + $_.Name)
  Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

# Overlay the workbench logo.
#
# VSCodium replaces src/vs/workbench/browser/media/code-icon.svg with its own
# mark during prepare_vscode.sh, and that is the logo shown in the centre of an
# empty editor area. apply-branding.ps1 runs after that and before the
# workbench is compiled, so overwriting the same path here wins. vscode-icon.svg
# is the Sessions/chat equivalent, referenced directly by openInVSCode.css, and
# needs the same treatment.
$mark = Join-Path $PSScriptRoot '..\branding\code-icon.svg'
if (!(Test-Path -LiteralPath $mark)) { throw "Branded workbench mark missing at $mark" }
$markTargets = @(
  (Join-Path $editor 'src\vs\workbench\browser\media\code-icon.svg'),
  (Join-Path $editor 'src\vs\sessions\browser\media\vscode-icon.svg')
)
foreach ($markTarget in $markTargets) {
  if (!(Test-Path -LiteralPath $markTarget)) { throw "Expected upstream media file missing: $markTarget" }
  Copy-Item -LiteralPath $mark -Destination $markTarget -Force
}

# Limit concurrent extension typechecks.
#
# UNVERIFIED MITIGATION. Upstream's prepack task starts every extension's
# typecheck process at once via `es.merge(...map(typeCheckExtensionStream))`,
# and that reliably crashes here while the same projects run fine alone.
# However, the actual cause was never established:
#
#   * Peak combined RSS at concurrency 4 is ~210-330 MB, so it is not memory.
#   * Running the same 4 projects concurrently succeeds in isolation, with and
#     without --incremental.
#   * The failing run reported exit code 0xC000012D with no diagnostics, and the
#     Node shim in @typescript/native/lib/tsc.js spawns the real 23 MB native
#     tsc.exe with `stdio: 'inherit'`, so its output bypasses the build's
#     captured streams. The real failure is therefore invisible to the log.
#
# Concurrency 2 builds cleanly and 4 does not, so the cap holds the symptom
# down. It is NOT a fix and the underlying cause is still unknown.
$tsgo = Join-Path $editor 'build\lib\tsgo.ts'
if (!(Test-Path -LiteralPath $tsgo)) { throw "Typecheck helper not found at $tsgo" }
$tsgoText = Get-Content -Raw -LiteralPath $tsgo
if (!($tsgoText -match 'MODERADO_TSGO_CONCURRENCY')) {
  $anchor = 'export function createTsgoStream('
  if (!($tsgoText.Contains($anchor))) { throw 'Could not locate createTsgoStream in the pinned checkout.' }
  $limit = @'
/**
 * Desktop patch: cap how many typecheck processes run at once.
 *
 * Upstream merges one `tsgo` stream per extension, which on this machine
 * saturates the compiler and makes `tsgo` exit non-zero with no diagnostics.
 * Running the same projects sequentially reports zero errors, so the failure is
 * resource exhaustion rather than a source defect.
 */
const TSGO_CONCURRENCY = Math.max(1, Number(process.env.MODERADO_TSGO_CONCURRENCY ?? '2'));
let tsgoActive = 0;
const tsgoQueue: (() => void)[] = [];

async function withTsgoSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (tsgoActive >= TSGO_CONCURRENCY) {
		await new Promise<void>((resolve) => tsgoQueue.push(resolve));
	}
	tsgoActive++;
	try {
		return await fn();
	} finally {
		tsgoActive--;
		tsgoQueue.shift()?.();
	}
}

'@
  $tsgoText = $tsgoText.Replace($anchor, ($limit + $anchor))
  $tsgoText = $tsgoText.Replace(
    'spawnTsgo(projectPath, config, onComplete).then(() => {',
    'withTsgoSlot(() => spawnTsgo(projectPath, config, onComplete)).then(() => {')
  [System.IO.File]::WriteAllText($tsgo, $tsgoText, $utf8)
}

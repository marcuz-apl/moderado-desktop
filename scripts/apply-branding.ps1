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

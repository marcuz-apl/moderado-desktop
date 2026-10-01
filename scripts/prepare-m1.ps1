$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'sources.lock.json') | ConvertFrom-Json
$checkout = Join-Path $root '.cache\vscodium'
if (Test-Path -LiteralPath $checkout) { throw 'Prepared checkout already exists. Use scripts/build-m1.ps1.' }

& git clone --branch $lock.sources.vscodium.tag --single-branch $lock.sources.vscodium.repository $checkout
if ($LASTEXITCODE -ne 0) { throw 'VSCodium clone failed.' }
if ((& git -C $checkout rev-parse HEAD).Trim() -ne $lock.sources.vscodium.commit) { throw 'VSCodium revision mismatch.' }

Copy-Item -LiteralPath (Join-Path $root 'branding\product.json') -Destination (Join-Path $checkout 'product.json') -Force
$env:APP_NAME = 'Moderado Desktop'
$env:BINARY_NAME = 'moderado-desktop'
$env:CI_BUILD = 'no'
$env:DISABLE_UPDATE = 'yes'
$env:MS_COMMIT = $lock.sources.codeOss.commit
$env:OS_NAME = 'windows'
$env:RELEASE_VERSION = $lock.sources.vscodium.version
$env:SHOULD_BUILD_CLI = 'no'
$env:VSCODE_ARCH = 'x64'
$env:VSCODE_QUALITY = 'stable'
$env:VSCODE_SKIP_NODE_VERSION_CHECK = 'yes'
$posixCheckout = (& 'C:\Program Files\Git\usr\bin\cygpath.exe' -u $checkout).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Git Bash path conversion failed.' }
$bash = 'C:\Program Files\Git\bin\bash.exe'
& $bash -c "cd '$posixCheckout' && . ./get_repo.sh && . ./prepare_vscode.sh"
if ($LASTEXITCODE -ne 0) { throw 'Pinned Code OSS fetch or VSCodium preparation failed.' }
if ((& git -C (Join-Path $checkout 'vscode') rev-parse HEAD).Trim() -ne $lock.sources.codeOss.commit) { throw 'Code OSS revision mismatch.' }

$python = (& py -3.11 -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 is required.' }
$env:PYTHON = $python
$env:npm_config_python = $python
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs = (& $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'Visual Studio C++ Build Tools are required.' }
$env:npm_config_vs2022_install = $vs
& $bash -c "cd '$posixCheckout/vscode' && npm ci"
if ($LASTEXITCODE -ne 0) { throw 'Pinned Code OSS dependency installation failed.' }
Write-Output 'Prepared pinned source. Run scripts/build-m1.ps1 next.'

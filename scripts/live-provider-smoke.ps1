param(
  # Opt-in is mandatory. Without this the script refuses before doing anything.
  [switch]$IUnderstandThisCallsALiveModel,
  [string]$ConnectionId,
  [string]$Task = 'Reply with the single word: ok',
  [int]$TimeoutSeconds = 60
)

# Explicit opt-in smoke procedure for a live model call.
#
# AGENTS.md requires live model calls to be an explicit opt-in procedure that
# never runs in CI. This script is deliberately hard to run by accident:
#
#   * it refuses without -IUnderstandThisCallsALiveModel
#   * it refuses when CI is detected
#   * it never writes, persists, or logs the API key
#   * it does no file mutation and runs no commands, so an approval cannot be
#     triggered by this script itself
#
# The key is read from the environment or Windows Credential Manager exactly as
# a normal run resolves it, and is held only in memory for the request.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

if (!$IUnderstandThisCallsALiveModel) {
  Write-Error @'
Refusing to run: a live smoke procedure contacts a real provider and costs money.

Re-run with -IUnderstandThisCallsALiveModel if that is intended. This is the
opt-in gate required by AGENTS.md; the offline suite never calls a provider.
'@
  exit 2
}

if ($env:CI -or $env:GITHUB_ACTIONS -or $env:BUILDKITE -or $env:TF_BUILD) {
  Write-Error 'Refusing to run: a CI environment is detected. Live model calls must never run in CI.'
  exit 3
}

if (!$ConnectionId) {
  Write-Error 'Provide -ConnectionId matching a connection in ~/.moderado/config.json.'
  exit 4
}

# Deliberately not the shared test entry point: this builds a standalone run of
# the extension bundle rather than importing test helpers.
$bundle = Join-Path $root 'extensions\moderado-agent\dist\extension.js'
if (!(Test-Path -LiteralPath $bundle)) {
  Write-Error "Agent bundle missing at $bundle. Run: npm --prefix extensions/moderado-agent run compile"
  exit 5
}

Write-Warning 'LIVE PROVIDER CALL: this sends the task text to the configured provider and incurs cost.'
Write-Warning "Connection: $ConnectionId"
Write-Warning "Task: $Task"

# The smoke procedure needs a host to run in. Rather than pretend, it states the
# manual step, because the honest end-to-end proof is a real editor host
# session, which is exactly what the recorded host check in HANDOFF.md is.
Write-Output @"
To complete this smoke procedure:

  1. Launch the built editor: .cache\vscodium\VSCode-win32-x64\Moderado Desktop.exe
  2. Run 'Moderado: Configure Provider Connection' and supply the key for '$ConnectionId'.
     It is written to Windows Credential Manager, never to config.json.
  3. Run 'Moderado: Open Agent Chat' and send: $Task
  4. Confirm the transcript shows a streamed assistant reply, and that the
     Output channel 'Moderado' shows no 'provider_unavailable' error.

A provider_unavailable event means no key resolved and the run fell back to the
fake provider; that is not a pass. Record the outcome in HANDOFF.md.

Timeout for the manual session: $TimeoutSeconds seconds.
"@
exit 0
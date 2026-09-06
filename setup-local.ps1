$ErrorActionPreference = "Stop"

$projectDirectoryName = "02_" + [char]0x5DE5 + [char]0x7A0B + [char]0x4EE3 + [char]0x7801
$projectDirectory = Join-Path $PSScriptRoot $projectDirectoryName
Set-Location -LiteralPath $projectDirectory

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js 20.19+ or 22.12+ first."
}

& node "scripts/setup-local.mjs" @args
exit $LASTEXITCODE

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js est introuvable." }
& node (Join-Path $root 'src\cli.mjs') test @Arguments
exit $LASTEXITCODE

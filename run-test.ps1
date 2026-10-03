param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][Alias('Story')][string]$Case,
    [Parameter(Mandatory = $true)][string]$PromptPath,
    [switch]$AllowUntrackedCase,
    [switch]$Embedded
)
& (Join-Path $PSScriptRoot 'bin\codex-lab.ps1') run-test --id $Id --case $Case --prompt-path $PromptPath
exit $LASTEXITCODE

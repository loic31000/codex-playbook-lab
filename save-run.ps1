param([Parameter(Mandatory = $true)][string]$Name, [switch]$Embedded)
& (Join-Path $PSScriptRoot 'bin\codex-lab.ps1') save-run --name $Name
exit $LASTEXITCODE

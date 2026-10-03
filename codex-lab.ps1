param(
    [ValidateSet('Menu', 'Check', 'Results')][string]$Action = 'Menu',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)
if ($Action -eq 'Menu') {
    & (Join-Path $PSScriptRoot 'bin\codex-lab.ps1') @Arguments
} else {
    & (Join-Path $PSScriptRoot 'bin\codex-lab.ps1') ($Action.ToLowerInvariant()) @Arguments
}
exit $LASTEXITCODE

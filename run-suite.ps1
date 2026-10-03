param(
    [string]$ConfigPath = 'tests-suite.json',
    [Alias('PromptPath')][string]$OnlyPrompt,
    [switch]$ListPrompts
)
$arguments = @('--config', $ConfigPath)
if ($OnlyPrompt) { $arguments += @('--prompt', $OnlyPrompt) }
if ($ListPrompts) {
    & (Join-Path $PSScriptRoot 'bin\codex-lab.ps1') list --config $ConfigPath
} else {
    & (Join-Path $PSScriptRoot 'bin\run-suite.ps1') @arguments
}
exit $LASTEXITCODE

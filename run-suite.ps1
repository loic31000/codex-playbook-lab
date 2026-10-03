param(
    [string]$SuitePath = "tests-suite.json"
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"

$RepoPath = (Get-Location).Path
$RunTestScript = Join-Path $RepoPath "run-test.ps1"
$BackupRoot = Join-Path (Split-Path $RepoPath -Parent) "codex-playbook-test-runs"
$SummaryPath = Join-Path $BackupRoot "suite-summary.md"

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Assert-CleanRepository {
    $status = git status --porcelain | Out-String

    if ($LASTEXITCODE -ne 0) {
        throw "Impossible de lire l'état Git."
    }

    if (-not [string]::IsNullOrWhiteSpace($status)) {
        Write-Host ""
        Write-Host "Le dépôt doit être propre avant de lancer la suite."
        git status
        throw "Commit ou annule les changements avant de relancer run-suite.ps1."
    }
}

function Escape-MarkdownCell {
    param(
        [string]$Value
    )

    if ($null -eq $Value) {
        return ""
    }

    return (($Value -replace '\|', '\|') -replace '[\r\n]+', ' ')
}

if (-not (Test-Path ".git")) {
    throw "Lance ce script depuis la racine de codex-playbook-tests."
}

if (-not (Test-Path -LiteralPath $RunTestScript -PathType Leaf)) {
    throw "run-test.ps1 est introuvable."
}

if (-not (Test-Path -LiteralPath $SuitePath -PathType Leaf)) {
    throw "Fichier de suite introuvable : $SuitePath"
}

Assert-CleanRepository

$suiteGitPath = $SuitePath -replace '\\', '/'
git ls-files --error-unmatch -- $suiteGitPath *> $null

if ($LASTEXITCODE -ne 0) {
    throw "Le fichier de suite doit être commité dans Git avant l'exécution : $SuitePath"
}

try {
    $suite = Get-Content -LiteralPath $SuitePath -Raw | ConvertFrom-Json
}
catch {
    throw "Impossible de lire $SuitePath comme JSON valide : $($_.Exception.Message)"
}

$tests = @($suite)

if ($tests.Count -eq 0) {
    throw "Aucun test déclaré dans $SuitePath."
}

$ids = @{}

foreach ($test in $tests) {
    if ([string]::IsNullOrWhiteSpace([string]$test.id)) {
        throw "Chaque entrée doit contenir un id."
    }

    if ([string]::IsNullOrWhiteSpace([string]$test.case)) {
        throw "Le test '$($test.id)' doit contenir un champ case."
    }

    if ([string]::IsNullOrWhiteSpace([string]$test.prompt)) {
        throw "Le test '$($test.id)' doit contenir un champ prompt."
    }

    if ($ids.ContainsKey([string]$test.id)) {
        throw "ID dupliqué dans la suite : $($test.id)"
    }

    $ids[[string]$test.id] = $true
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

$results = @()
$startedAt = Get-Date

Write-Host ""
Write-Host "============================================================"
Write-Host "SUITE CODEX"
Write-Host "============================================================"
Write-Host ""
Write-Host "Tests déclarés : $($tests.Count)"
Write-Host ""

foreach ($test in $tests) {
    $id = [string]$test.id
    $case = [string]$test.case
    $prompt = [string]$test.prompt
    $enabled = $true

    if ($null -ne $test.enabled) {
        $enabled = [bool]$test.enabled
    }

    if (-not $enabled) {
        Write-Host "[$id] ignoré : enabled=false"

        $results += [pscustomobject]@{
            Id = $id
            Case = $case
            Prompt = $prompt
            Status = "IGNORÉ"
            Detail = "enabled=false"
        }

        continue
    }

    $baselinePath = Join-Path $BackupRoot "$id-baseline"
    $withPromptPath = Join-Path $BackupRoot "$id-with-prompt"
    $comparisonPath = Join-Path $BackupRoot "$id-comparison.diff"

    if (
        (Test-Path -LiteralPath $baselinePath) -and
        (Test-Path -LiteralPath $withPromptPath) -and
        (Test-Path -LiteralPath $comparisonPath)
    ) {
        Write-Host "[$id] déjà terminé, passage au suivant."

        $results += [pscustomobject]@{
            Id = $id
            Case = $case
            Prompt = $prompt
            Status = "DÉJÀ TERMINÉ"
            Detail = "Résultats existants"
        }

        continue
    }

    Write-Host ""
    Write-Host "------------------------------------------------------------"
    Write-Host "TEST $id"
    Write-Host "Cas    : $case"
    Write-Host "Prompt : $prompt"
    Write-Host "------------------------------------------------------------"

    try {
        & $RunTestScript -Id $id -Case $case -PromptPath $prompt

        $results += [pscustomobject]@{
            Id = $id
            Case = $case
            Prompt = $prompt
            Status = "OK"
            Detail = ""
        }
    }
    catch {
        $message = $_.Exception.Message

        Write-Host ""
        Write-Host "[$id] ÉCHEC : $message"

        $results += [pscustomobject]@{
            Id = $id
            Case = $case
            Prompt = $prompt
            Status = "ÉCHEC"
            Detail = $message
        }
    }

    Assert-CleanRepository
}

$finishedAt = Get-Date
$duration = $finishedAt - $startedAt
$okCount = @($results | Where-Object { $_.Status -eq "OK" }).Count
$doneCount = @($results | Where-Object { $_.Status -eq "DÉJÀ TERMINÉ" }).Count
$skippedCount = @($results | Where-Object { $_.Status -eq "IGNORÉ" }).Count
$failedCount = @($results | Where-Object { $_.Status -eq "ÉCHEC" }).Count

$lines = @(
    "# Résultats de la suite",
    "",
    "Date : $($finishedAt.ToString('yyyy-MM-dd HH:mm:ss'))",
    "",
    "Durée : $([math]::Round($duration.TotalMinutes, 1)) minute(s)",
    "",
    "## Résumé",
    "",
    "- OK : $okCount",
    "- Déjà terminés : $doneCount",
    "- Ignorés : $skippedCount",
    "- Échecs : $failedCount",
    "",
    "## Détail",
    "",
    "| Test | Cas | Prompt | Statut | Détail |",
    "|---|---|---|---|---|"
)

foreach ($result in $results) {
    $lines += "| $(Escape-MarkdownCell $result.Id) | $(Escape-MarkdownCell $result.Case) | $(Escape-MarkdownCell $result.Prompt) | $(Escape-MarkdownCell $result.Status) | $(Escape-MarkdownCell $result.Detail) |"
}

$summary = $lines -join [Environment]::NewLine
Write-Utf8NoBom -Path $SummaryPath -Content $summary

Write-Host ""
Write-Host "============================================================"
Write-Host "SUITE TERMINÉE"
Write-Host "============================================================"
Write-Host ""
Write-Host "OK               : $okCount"
Write-Host "Déjà terminés    : $doneCount"
Write-Host "Ignorés          : $skippedCount"
Write-Host "Échecs           : $failedCount"
Write-Host "Résumé            : $SummaryPath"

if ($failedCount -gt 0) {
    Write-Host ""
    Write-Host "Certains tests ont échoué. Consulte suite-summary.md."
}

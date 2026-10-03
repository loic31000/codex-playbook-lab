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

function Test-IsCodexLimitError {
    param(
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }

    $patterns = @(
        '(?i)\b429\b',
        '(?i)rate[ _-]?limit',
        '(?i)too many requests',
        '(?i)usage[ _-]?limit',
        '(?i)usage limit reached',
        '(?i)limit reached',
        '(?i)insufficient_quota',
        '(?i)credit_balance_exhausted',
        '(?i)organization_usage_limit_exceeded',
        '(?i)organization_spend_limit_exceeded',
        '(?i)project_spend_limit_exceeded',
        '(?i)quota exceeded',
        '(?i)quota.*exhausted',
        '(?i)you.?ve hit.*limit',
        '(?i)you have hit.*limit',
        '(?i)slow_down'
    )

    foreach ($pattern in $patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }

    return $false
}

function Get-RunExitCode {
    param(
        [string]$RunPath
    )

    $exitCodePath = Join-Path $RunPath "codex-exit-code.txt"

    if (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
        return $null
    }

    $raw = (Get-Content -LiteralPath $exitCodePath -Raw).Trim()
    $value = 0

    if ([int]::TryParse($raw, [ref]$value)) {
        return $value
    }

    return $null
}

function Remove-LimitInterruptedArtifacts {
    param(
        [string]$BaselinePath,
        [string]$WithPromptPath,
        [string]$ComparisonPath
    )

    $removed = ""

    if (Test-Path -LiteralPath $WithPromptPath) {
        $withPromptExitCode = Get-RunExitCode -RunPath $WithPromptPath

        if (($null -ne $withPromptExitCode) -and ($withPromptExitCode -ne 0)) {
            Remove-Item -LiteralPath $WithPromptPath -Recurse -Force
            $removed = "run avec prompt"
        }
    }

    if ([string]::IsNullOrWhiteSpace($removed) -and (Test-Path -LiteralPath $BaselinePath)) {
        $baselineExitCode = Get-RunExitCode -RunPath $BaselinePath

        if (($null -ne $baselineExitCode) -and ($baselineExitCode -ne 0)) {
            Remove-Item -LiteralPath $BaselinePath -Recurse -Force
            $removed = "baseline"
        }
    }

    if ([string]::IsNullOrWhiteSpace($removed)) {
        if ((Test-Path -LiteralPath $WithPromptPath) -and (-not (Test-Path -LiteralPath $ComparisonPath))) {
            Remove-Item -LiteralPath $WithPromptPath -Recurse -Force
            $removed = "run avec prompt"
        }
        elseif ((Test-Path -LiteralPath $BaselinePath) -and (-not (Test-Path -LiteralPath $WithPromptPath))) {
            Remove-Item -LiteralPath $BaselinePath -Recurse -Force
            $removed = "baseline"
        }
    }

    if ((-not [string]::IsNullOrWhiteSpace($removed)) -and (Test-Path -LiteralPath $ComparisonPath)) {
        Remove-Item -LiteralPath $ComparisonPath -Force
    }

    return $removed
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
$stoppedForLimit = $false
$stopDetail = ""

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
    $runLogPath = Join-Path $BackupRoot "$id-suite.log"

    if ((Test-Path -LiteralPath $baselinePath) -and (Test-Path -LiteralPath $withPromptPath) -and (Test-Path -LiteralPath $comparisonPath)) {
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
        & $RunTestScript -Id $id -Case $case -PromptPath $prompt *>&1 | Tee-Object -FilePath $runLogPath

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
        $logText = ""

        if (Test-Path -LiteralPath $runLogPath -PathType Leaf) {
            $logText = Get-Content -LiteralPath $runLogPath -Raw
        }

        $combinedError = $logText + [Environment]::NewLine + $message

        if (Test-IsCodexLimitError -Text $combinedError) {
            $removed = Remove-LimitInterruptedArtifacts -BaselinePath $baselinePath -WithPromptPath $withPromptPath -ComparisonPath $comparisonPath

            if ([string]::IsNullOrWhiteSpace($removed)) {
                $removed = "aucun artefact incomplet détecté"
            }

            $stopDetail = "Quota ou rate limit Codex détecté. Reprise au prochain lancement. Nettoyage : $removed."

            Write-Host ""
            Write-Host "[$id] LIMITE CODEX DÉTECTÉE"
            Write-Host "La suite s'arrête proprement."
            Write-Host "Relance .\run-suite.ps1 quand la limite est réinitialisée."
            Write-Host "Le test sera repris automatiquement."
            Write-Host "Nettoyage : $removed"

            $results += [pscustomobject]@{
                Id = $id
                Case = $case
                Prompt = $prompt
                Status = "ARRÊT LIMITE"
                Detail = $stopDetail
            }

            $stoppedForLimit = $true
        }
        else {
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
    }

    if ($stoppedForLimit) {
        try {
            Assert-CleanRepository
        }
        catch {
            $stopDetail = $stopDetail + " Attention : vérifie git status avant la reprise."
            Write-Host ""
            Write-Host "Attention : le dépôt n'est pas propre après l'arrêt."
            Write-Host "Vérifie git status avant de relancer la suite."
        }

        break
    }

    Assert-CleanRepository
}

$finishedAt = Get-Date
$duration = $finishedAt - $startedAt
$okCount = @($results | Where-Object { $_.Status -eq "OK" }).Count
$doneCount = @($results | Where-Object { $_.Status -eq "DÉJÀ TERMINÉ" }).Count
$skippedCount = @($results | Where-Object { $_.Status -eq "IGNORÉ" }).Count
$failedCount = @($results | Where-Object { $_.Status -eq "ÉCHEC" }).Count
$limitStopCount = @($results | Where-Object { $_.Status -eq "ARRÊT LIMITE" }).Count

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
    "- Arrêts quota/rate limit : $limitStopCount"
)

if ($stoppedForLimit) {
    $lines += @(
        "",
        "## Suite interrompue",
        "",
        "La suite a été arrêtée proprement après détection d'une limite Codex.",
        "",
        "Relance simplement .\run-suite.ps1 après réinitialisation de la limite. Les tests déjà terminés seront sautés et le test interrompu sera repris."
    )
}

$lines += @(
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

if ($stoppedForLimit) {
    Write-Host "SUITE ARRÊTÉE : LIMITE CODEX"
}
else {
    Write-Host "SUITE TERMINÉE"
}

Write-Host "============================================================"
Write-Host ""
Write-Host "OK                    : $okCount"
Write-Host "Déjà terminés         : $doneCount"
Write-Host "Ignorés               : $skippedCount"
Write-Host "Échecs                : $failedCount"
Write-Host "Arrêts limite Codex   : $limitStopCount"
Write-Host "Résumé                 : $SummaryPath"

if ($stoppedForLimit) {
    Write-Host ""
    Write-Host "Relance simplement .\run-suite.ps1 après le reset de la limite."
}
elseif ($failedCount -gt 0) {
    Write-Host ""
    Write-Host "Certains tests ont échoué. Consulte suite-summary.md."
}

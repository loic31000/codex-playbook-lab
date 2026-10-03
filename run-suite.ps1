param(
    [string]$ConfigPath = "tests-suite.json"
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"

$RepoPath = (Get-Location).Path
$RunTestScript = Join-Path $RepoPath "run-test.ps1"
$BackupRoot = Join-Path (Split-Path $RepoPath -Parent) "codex-playbook-test-runs"
$GeneratedCasesRoot = Join-Path $BackupRoot "generated-cases"
$SummaryPath = Join-Path $BackupRoot "suite-summary.md"
$ManifestPath = Join-Path $BackupRoot "generated-manifest.json"

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Read-Utf8Text {
    param(
        [string]$Path
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($Path, $encoding)
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

function Test-IsFatalInfrastructureError {
    param(
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }

    $patterns = @(
        '(?i)unexpected argument',
        '(?i)command.+codex.+introuvable',
        '(?i)codex.+not recognized',
        '(?i)command not found',
        '(?i)not logged in',
        '(?i)authentication failed',
        '(?i)unauthorized',
        '(?i)invalid api key'
    )

    foreach ($pattern in $patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }

    return $false
}

function Get-PromptBlock {
    param(
        [string]$Path
    )

    $content = Read-Utf8Text -Path $Path
    $pattern = '(?s)##\s+Prompt prêt à copier\s*\x60\x60\x60(?:text)?\s*(.*?)\s*\x60\x60\x60'
    $match = [regex]::Match($content, $pattern)

    if (-not $match.Success) {
        return $null
    }

    return $match.Groups[1].Value.Trim()
}

function Get-FrontmatterValue {
    param(
        [string]$Content,
        [string]$Key
    )

    $pattern = '(?m)^' + [regex]::Escape($Key) + ':\s*["'']?([^\r\n"'']+)["'']?\s*$'
    $match = [regex]::Match($Content, $pattern)

    if ($match.Success) {
        return $match.Groups[1].Value.Trim()
    }

    return $null
}

function Get-StableId {
    param(
        [string]$RelativePromptPath,
        [string]$PromptBlock,
        [int]$CaseIndex
    )

    $source = $RelativePromptPath + [Environment]::NewLine + $PromptBlock + [Environment]::NewLine + [string]$CaseIndex
    $sha = [System.Security.Cryptography.SHA256]::Create()

    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($source)
        $hashBytes = $sha.ComputeHash($bytes)
        $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha.Dispose()
    }

    return "auto-" + $hash.Substring(0, 12)
}

function Get-RunExitCode {
    param(
        [string]$RunPath
    )

    $exitCodePath = Join-Path $RunPath "codex-exit-code.txt"

    if (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
        return $null
    }

    $raw = (Read-Utf8Text -Path $exitCodePath).Trim()
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

function Invoke-CaseGeneration {
    param(
        [string]$Id,
        [string]$PromptRelativePath,
        [string]$PromptBlock,
        [string]$CasePath,
        [string]$GenerationLogPath
    )

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-case-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    $inputFile = Join-Path $tempRoot "generator-input.txt"
    $finalFile = Join-Path $tempRoot "generated-case.md"

    $generatorInput = @"
Tu génères un cas de test fictif pour évaluer un prompt Codex.

Repository de test disponible : le repository courant.
Prompt à évaluer : $PromptRelativePath

PROMPT À ÉVALUER
----------------
$PromptBlock
----------------

Crée UN cas de test réaliste, autonome et suffisamment discriminant pour comparer :
1. Codex sans ce prompt ;
2. Codex avec ce prompt.

Règles :
- n'évalue pas le prompt ;
- ne donne pas la solution du cas ;
- ne mentionne pas qu'il s'agit d'un baseline ou d'un test A/B ;
- n'inclus pas le texte du prompt dans le cas ;
- utilise le repository courant quand le prompt concerne du code ;
- sous Windows PowerShell 5.1, lis les fichiers texte explicitement en UTF-8 afin de préserver les accents ;
- si le prompt porte sur une review, un diagnostic, des logs, une architecture, une spécification ou de la documentation, fournis dans le cas tout le matériau concret nécessaire ;
- introduis une ambiguïté seulement si elle est pertinente pour ce prompt ;
- évite les dépendances externes et les services réseau ;
- le cas doit pouvoir être exécuté sans intervention humaine ;
- reste compact.

Retourne uniquement le Markdown du cas de test.
"@

    Write-Utf8NoBom -Path $inputFile -Content $generatorInput

    $codexArgs = @(
        "exec",
        "--ephemeral",
        "--color",
        "never",
        "--output-last-message",
        $finalFile,
        "-"
    )

    $previousErrorActionPreference = $ErrorActionPreference

    try {
        $ErrorActionPreference = "Continue"
        Read-Utf8Text -Path $inputFile | & codex @codexArgs 2>&1 | Tee-Object -FilePath $GenerationLogPath
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        $logText = ""

        if (Test-Path -LiteralPath $GenerationLogPath -PathType Leaf) {
            $logText = Read-Utf8Text -Path $GenerationLogPath
        }

        Remove-Item -LiteralPath $tempRoot -Recurse -Force
        throw ("CASE_GENERATION_FAILED [$Id] code=$exitCode" + [Environment]::NewLine + $logText)
    }

    if (-not (Test-Path -LiteralPath $finalFile -PathType Leaf)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
        throw "CASE_GENERATION_FAILED [$Id] aucun cas généré."
    }

    $generated = (Read-Utf8Text -Path $finalFile).Trim()

    if ([string]::IsNullOrWhiteSpace($generated)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
        throw "CASE_GENERATION_FAILED [$Id] cas vide."
    }

    Write-Utf8NoBom -Path $CasePath -Content ($generated + [Environment]::NewLine)
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}

function Write-ResultPackage {
    param(
        [string]$Id,
        [string]$PromptRelativePath,
        [string]$CasePath,
        [string]$BaselinePath,
        [string]$WithPromptPath,
        [string]$ComparisonPath
    )

    $packagePath = Join-Path $BackupRoot "$Id-result.md"
    $baselineFinalPath = Join-Path $BaselinePath "codex-final.txt"
    $withPromptFinalPath = Join-Path $WithPromptPath "codex-final.txt"

    $caseText = if (Test-Path -LiteralPath $CasePath) { Read-Utf8Text -Path $CasePath } else { "(cas indisponible)" }
    $baselineText = if (Test-Path -LiteralPath $baselineFinalPath) { Read-Utf8Text -Path $baselineFinalPath } else { "(sortie baseline indisponible)" }
    $withPromptText = if (Test-Path -LiteralPath $withPromptFinalPath) { Read-Utf8Text -Path $withPromptFinalPath } else { "(sortie avec prompt indisponible)" }
    $diffText = if (Test-Path -LiteralPath $ComparisonPath) { Read-Utf8Text -Path $ComparisonPath } else { "(diff indisponible)" }

    $content = @"
# Résultat $Id

Prompt : $PromptRelativePath

## Cas généré

$caseText

## Sortie baseline

$baselineText

## Sortie avec prompt

$withPromptText

## Diff des fichiers produits

```diff
$diffText
```
"@

    Write-Utf8NoBom -Path $packagePath -Content $content
}

if (-not (Test-Path ".git")) {
    throw "Lance ce script depuis la racine de codex-playbook-tests."
}

if (-not (Test-Path -LiteralPath $RunTestScript -PathType Leaf)) {
    throw "run-test.ps1 est introuvable."
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw "La commande 'codex' est introuvable. Vérifie que Codex CLI est installé et connecté."
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Configuration introuvable : $ConfigPath"
}

Assert-CleanRepository

try {
    $config = Read-Utf8Text -Path $ConfigPath | ConvertFrom-Json
}
catch {
    throw "Impossible de lire $ConfigPath comme JSON valide : $($_.Exception.Message)"
}

$playbookSetting = [string]$config.playbook_path

if ([string]::IsNullOrWhiteSpace($playbookSetting)) {
    $playbookSetting = "..\codex-engineering-playbook-fr"
}

$casesPerPrompt = 1

if ($null -ne $config.cases_per_prompt) {
    $casesPerPrompt = [int]$config.cases_per_prompt
}

if ($casesPerPrompt -lt 1) {
    throw "cases_per_prompt doit être supérieur ou égal à 1."
}

$playbookCandidate = Join-Path $RepoPath $playbookSetting

if (-not (Test-Path -LiteralPath $playbookCandidate -PathType Container)) {
    throw "Playbook introuvable : $playbookCandidate"
}

$PlaybookPath = (Resolve-Path -LiteralPath $playbookCandidate).Path

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
New-Item -ItemType Directory -Force -Path $GeneratedCasesRoot | Out-Null

$prompts = @()

foreach ($file in Get-ChildItem -LiteralPath $PlaybookPath -Recurse -File -Filter "*.md") {
    $content = Read-Utf8Text -Path $file.FullName
    $format = Get-FrontmatterValue -Content $content -Key "format"

    if ($format -ne "prompt") {
        continue
    }

    $promptBlock = Get-PromptBlock -Path $file.FullName

    if ([string]::IsNullOrWhiteSpace($promptBlock)) {
        continue
    }

    $relativePath = $file.FullName.Substring($PlaybookPath.Length).TrimStart([char[]]@('\','/'))

    $prompts += [pscustomobject]@{
        FullPath = $file.FullName
        RelativePath = $relativePath
        PromptBlock = $promptBlock
    }
}

$prompts = @($prompts | Sort-Object RelativePath)

if ($prompts.Count -eq 0) {
    throw "Aucun prompt testable détecté dans le playbook."
}

$manifest = @()
$tests = @()

foreach ($prompt in $prompts) {
    for ($caseIndex = 1; $caseIndex -le $casesPerPrompt; $caseIndex++) {
        $id = Get-StableId -RelativePromptPath $prompt.RelativePath -PromptBlock $prompt.PromptBlock -CaseIndex $caseIndex
        $casePath = Join-Path $GeneratedCasesRoot "$id.md"

        $tests += [pscustomobject]@{
            Id = $id
            PromptPath = $prompt.FullPath
            PromptRelativePath = $prompt.RelativePath
            PromptBlock = $prompt.PromptBlock
            CaseIndex = $caseIndex
            CasePath = $casePath
        }

        $manifest += [pscustomobject]@{
            id = $id
            prompt = $prompt.RelativePath
            case = "generated-cases/$id.md"
            case_index = $caseIndex
        }
    }
}

Write-Utf8NoBom -Path $ManifestPath -Content ($manifest | ConvertTo-Json -Depth 4)

$results = @()
$startedAt = Get-Date
$stoppedForLimit = $false
$stoppedForInfrastructure = $false

Write-Host ""
Write-Host "============================================================"
Write-Host "SUITE CODEX AUTOMATIQUE"
Write-Host "============================================================"
Write-Host ""
Write-Host "Prompts détectés : $($prompts.Count)"
Write-Host "Cas par prompt   : $casesPerPrompt"
Write-Host "Tests à traiter  : $($tests.Count)"
Write-Host ""

foreach ($test in $tests) {
    $id = $test.Id
    $casePath = $test.CasePath
    $promptPath = $test.PromptPath
    $promptRelativePath = $test.PromptRelativePath

    $baselinePath = Join-Path $BackupRoot "$id-baseline"
    $withPromptPath = Join-Path $BackupRoot "$id-with-prompt"
    $comparisonPath = Join-Path $BackupRoot "$id-comparison.diff"
    $runLogPath = Join-Path $BackupRoot "$id-suite.log"
    $generationLogPath = Join-Path $GeneratedCasesRoot "$id-generation.log"

    if ((Test-Path -LiteralPath $baselinePath) -and (Test-Path -LiteralPath $withPromptPath) -and (Test-Path -LiteralPath $comparisonPath)) {
        Write-Host "[$id] déjà terminé : $promptRelativePath"
        Write-ResultPackage -Id $id -PromptRelativePath $promptRelativePath -CasePath $casePath -BaselinePath $baselinePath -WithPromptPath $withPromptPath -ComparisonPath $comparisonPath

        $results += [pscustomobject]@{
            Id = $id
            Prompt = $promptRelativePath
            Status = "DÉJÀ TERMINÉ"
            Detail = ""
        }

        continue
    }

    Write-Host ""
    Write-Host "------------------------------------------------------------"
    Write-Host "TEST $id"
    Write-Host "Prompt : $promptRelativePath"
    Write-Host "------------------------------------------------------------"

    if (-not (Test-Path -LiteralPath $casePath -PathType Leaf)) {
        Write-Host "Génération automatique du cas..."

        try {
            Invoke-CaseGeneration -Id $id -PromptRelativePath $promptRelativePath -PromptBlock $test.PromptBlock -CasePath $casePath -GenerationLogPath $generationLogPath
        }
        catch {
            $message = $_.Exception.Message

            if (Test-IsCodexLimitError -Text $message) {
                Write-Host ""
                Write-Host "[$id] LIMITE CODEX DÉTECTÉE pendant la génération du cas."
                Write-Host "La suite s'arrête proprement."
                Write-Host "Relance .\run-suite.ps1 après réinitialisation de la limite."

                $results += [pscustomobject]@{
                    Id = $id
                    Prompt = $promptRelativePath
                    Status = "ARRÊT LIMITE"
                    Detail = "Limite détectée pendant la génération du cas."
                }

                $stoppedForLimit = $true
                break
            }

            if (Test-IsFatalInfrastructureError -Text $message) {
                Write-Host ""
                Write-Host "[$id] ERREUR INFRASTRUCTURE CODEX"
                Write-Host "La suite s'arrête pour éviter de gaspiller des exécutions."
                Write-Host "Corrige Codex CLI puis relance .\run-suite.ps1."

                $results += [pscustomobject]@{
                    Id = $id
                    Prompt = $promptRelativePath
                    Status = "ARRÊT INFRA"
                    Detail = $message
                }

                $stoppedForInfrastructure = $true
                break
            }

            Write-Host ""
            Write-Host "[$id] ÉCHEC GÉNÉRATION : $message"

            $results += [pscustomobject]@{
                Id = $id
                Prompt = $promptRelativePath
                Status = "ÉCHEC GÉNÉRATION"
                Detail = $message
            }

            continue
        }
    }
    else {
        Write-Host "Cas généré déjà présent, réutilisation."
    }

    try {
        & $RunTestScript -Id $id -Case $casePath -PromptPath $promptPath -AllowUntrackedCase *>&1 | Tee-Object -FilePath $runLogPath

        Write-ResultPackage -Id $id -PromptRelativePath $promptRelativePath -CasePath $casePath -BaselinePath $baselinePath -WithPromptPath $withPromptPath -ComparisonPath $comparisonPath

        $results += [pscustomobject]@{
            Id = $id
            Prompt = $promptRelativePath
            Status = "OK"
            Detail = ""
        }
    }
    catch {
        $message = $_.Exception.Message
        $logText = ""

        if (Test-Path -LiteralPath $runLogPath -PathType Leaf) {
            $logText = Read-Utf8Text -Path $runLogPath
        }

        $combinedError = $logText + [Environment]::NewLine + $message

        if (Test-IsCodexLimitError -Text $combinedError) {
            $removed = Remove-LimitInterruptedArtifacts -BaselinePath $baselinePath -WithPromptPath $withPromptPath -ComparisonPath $comparisonPath

            if ([string]::IsNullOrWhiteSpace($removed)) {
                $removed = "aucun artefact incomplet détecté"
            }

            Write-Host ""
            Write-Host "[$id] LIMITE CODEX DÉTECTÉE"
            Write-Host "La suite s'arrête proprement."
            Write-Host "Relance .\run-suite.ps1 après réinitialisation de la limite."
            Write-Host "Nettoyage : $removed"

            $results += [pscustomobject]@{
                Id = $id
                Prompt = $promptRelativePath
                Status = "ARRÊT LIMITE"
                Detail = "Reprise automatique au prochain lancement. Nettoyage : $removed."
            }

            $stoppedForLimit = $true
            break
        }

        if (Test-IsFatalInfrastructureError -Text $combinedError) {
            Write-Host ""
            Write-Host "[$id] ERREUR INFRASTRUCTURE CODEX"
            Write-Host "La suite s'arrête pour éviter de gaspiller des exécutions."
            Write-Host "Corrige Codex CLI puis relance .\run-suite.ps1."

            $results += [pscustomobject]@{
                Id = $id
                Prompt = $promptRelativePath
                Status = "ARRÊT INFRA"
                Detail = $message
            }

            $stoppedForInfrastructure = $true
            break
        }

        Write-Host ""
        Write-Host "[$id] ÉCHEC : $message"

        $results += [pscustomobject]@{
            Id = $id
            Prompt = $promptRelativePath
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
$generationFailedCount = @($results | Where-Object { $_.Status -eq "ÉCHEC GÉNÉRATION" }).Count
$failedCount = @($results | Where-Object { $_.Status -eq "ÉCHEC" }).Count
$limitStopCount = @($results | Where-Object { $_.Status -eq "ARRÊT LIMITE" }).Count
$infraStopCount = @($results | Where-Object { $_.Status -eq "ARRÊT INFRA" }).Count

$lines = @(
    "# Résultats de la suite automatique",
    "",
    "Date : $($finishedAt.ToString('yyyy-MM-dd HH:mm:ss'))",
    "",
    "Durée : $([math]::Round($duration.TotalMinutes, 1)) minute(s)",
    "",
    "Prompts détectés : $($prompts.Count)",
    "",
    "Cas par prompt : $casesPerPrompt",
    "",
    "## Résumé",
    "",
    "- OK : $okCount",
    "- Déjà terminés : $doneCount",
    "- Échecs de génération : $generationFailedCount",
    "- Échecs de test : $failedCount",
    "- Arrêts quota/rate limit : $limitStopCount",
    "- Arrêts infrastructure : $infraStopCount"
)

if ($stoppedForLimit) {
    $lines += @(
        "",
        "## Suite interrompue",
        "",
        "La suite a été arrêtée proprement après détection d'une limite Codex.",
        "",
        "Relance simplement .\run-suite.ps1 après réinitialisation de la limite."
    )
}
elseif ($stoppedForInfrastructure) {
    $lines += @(
        "",
        "## Suite interrompue",
        "",
        "La suite a été arrêtée sur une erreur d'infrastructure Codex pour éviter de gaspiller des exécutions.",
        "",
        "Corrige Codex CLI puis relance simplement .\run-suite.ps1."
    )
}

$lines += @(
    "",
    "## Détail",
    "",
    "| Test | Prompt | Statut | Détail |",
    "|---|---|---|---|"
)

foreach ($result in $results) {
    $lines += "| $(Escape-MarkdownCell $result.Id) | $(Escape-MarkdownCell $result.Prompt) | $(Escape-MarkdownCell $result.Status) | $(Escape-MarkdownCell $result.Detail) |"
}

Write-Utf8NoBom -Path $SummaryPath -Content ($lines -join [Environment]::NewLine)

Write-Host ""
Write-Host "============================================================"

if ($stoppedForLimit) {
    Write-Host "SUITE ARRÊTÉE : LIMITE CODEX"
}
elseif ($stoppedForInfrastructure) {
    Write-Host "SUITE ARRÊTÉE : INFRASTRUCTURE CODEX"
}
else {
    Write-Host "SUITE TERMINÉE"
}

Write-Host "============================================================"
Write-Host ""
Write-Host "Prompts détectés      : $($prompts.Count)"
Write-Host "OK                    : $okCount"
Write-Host "Déjà terminés         : $doneCount"
Write-Host "Échecs génération     : $generationFailedCount"
Write-Host "Échecs test           : $failedCount"
Write-Host "Arrêts limite Codex   : $limitStopCount"
Write-Host "Arrêts infrastructure : $infraStopCount"
Write-Host "Résumé                : $SummaryPath"
Write-Host "Manifest              : $ManifestPath"
Write-Host ""
Write-Host "Pour reprendre : .\run-suite.ps1"

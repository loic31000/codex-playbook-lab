param(
    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [Alias("Story")]
    [string]$Case,

    [Parameter(Mandatory = $true)]
    [string]$PromptPath
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"

$RepoPath = (Get-Location).Path
$SaveRunScript = Join-Path $RepoPath "save-run.ps1"
$BackupRoot = Join-Path (Split-Path $RepoPath -Parent) "codex-playbook-test-runs"

$BaselineName = "$Id-baseline"
$WithPromptName = "$Id-with-prompt"

$BaselineRunPath = Join-Path $BackupRoot $BaselineName
$WithPromptRunPath = Join-Path $BackupRoot $WithPromptName
$ComparisonPath = Join-Path $BackupRoot "$Id-comparison.diff"

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
        Write-Host "Le dépôt doit être propre avant de lancer un test."
        git status
        throw "Commit ou annule les changements avant de relancer run-test.ps1."
    }
}

function Get-PromptBlock {
    param(
        [string]$Path
    )

    $content = Get-Content -LiteralPath $Path -Raw
    $pattern = '(?s)##\s+Prompt prêt à copier\s*\x60\x60\x60(?:text)?\s*(.*?)\s*\x60\x60\x60'
    $match = [regex]::Match($content, $pattern)

    if (-not $match.Success) {
        throw "Impossible de trouver le bloc 'Prompt prêt à copier' dans : $Path"
    }

    return $match.Groups[1].Value.Trim()
}

function Invoke-CodexTestRun {
    param(
        [string]$RunName,
        [string]$InputText
    )

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-playbook-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    $inputFile = Join-Path $tempRoot "input.txt"
    $finalFile = Join-Path $tempRoot "codex-final.txt"
    $exitFile = Join-Path $tempRoot "codex-exit-code.txt"

    Write-Utf8NoBom -Path $inputFile -Content $InputText

    Write-Host ""
    Write-Host "============================================================"
    Write-Host "RUN : $RunName"
    Write-Host "============================================================"
    Write-Host ""

    $codexArgs = @(
        "exec",
        "--full-auto",
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
        Get-Content -LiteralPath $inputFile -Raw | & codex @codexArgs
        $codexExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    Write-Utf8NoBom -Path $exitFile -Content ([string]$codexExitCode)

    & $SaveRunScript -Name $RunName

    $runPath = Join-Path $BackupRoot $RunName

    Copy-Item -LiteralPath $inputFile -Destination (Join-Path $runPath "codex-input.txt") -Force
    Copy-Item -LiteralPath $exitFile -Destination (Join-Path $runPath "codex-exit-code.txt") -Force

    if (Test-Path -LiteralPath $finalFile) {
        Copy-Item -LiteralPath $finalFile -Destination (Join-Path $runPath "codex-final.txt") -Force
    }
    else {
        Write-Utf8NoBom -Path (Join-Path $runPath "codex-final.txt") -Content "(Aucun message final Codex enregistré.)"
    }

    Remove-Item -LiteralPath $tempRoot -Recurse -Force

    if ($codexExitCode -ne 0) {
        throw "Codex a terminé avec le code $codexExitCode pendant '$RunName'. Le run a quand même été sauvegardé."
    }
}

if (-not (Test-Path ".git")) {
    throw "Lance ce script depuis la racine de codex-playbook-tests."
}

if (-not (Test-Path -LiteralPath $SaveRunScript)) {
    throw "save-run.ps1 est introuvable dans le dépôt."
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw "La commande 'codex' est introuvable. Vérifie que Codex CLI est installé et connecté."
}

if (-not (Test-Path -LiteralPath $Case -PathType Leaf)) {
    throw "Cas de test introuvable : $Case"
}

$caseGitPath = $Case -replace '\\', '/'
git ls-files --error-unmatch -- $caseGitPath *> $null

if ($LASTEXITCODE -ne 0) {
    throw "Le cas de test doit être commité dans Git avant le test : $Case"
}

if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) {
    throw "Prompt introuvable : $PromptPath"
}

if (Test-Path -LiteralPath $BaselineRunPath) {
    throw "Le run existe déjà : $BaselineRunPath"
}

if (Test-Path -LiteralPath $WithPromptRunPath) {
    throw "Le run existe déjà : $WithPromptRunPath"
}

Assert-CleanRepository

$promptBlock = Get-PromptBlock -Path $PromptPath
$caseContent = Get-Content -LiteralPath $Case -Raw

$baselineInput = @"
Exécute la demande décrite dans le cas de test ci-dessous.
Utilise le repository comme contexte et modifie le code uniquement si le cas le demande.

$caseContent
"@

$withPromptInput = @"
$promptBlock

Cas de test à traiter :

$caseContent
"@

Invoke-CodexTestRun -RunName $BaselineName -InputText $baselineInput

Assert-CleanRepository

Invoke-CodexTestRun -RunName $WithPromptName -InputText $withPromptInput

Assert-CleanRepository

Write-Host ""
Write-Host "==> Génération du diff de comparaison"

$baselineFiles = Join-Path $BaselineRunPath "files"
$withPromptFiles = Join-Path $WithPromptRunPath "files"

$previousErrorActionPreference = $ErrorActionPreference

try {
    $ErrorActionPreference = "Continue"
    $comparison = git diff --no-index --text $baselineFiles $withPromptFiles 2>&1 | Out-String
    $comparisonExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
}

if (($comparisonExitCode -ne 0) -and ($comparisonExitCode -ne 1)) {
    throw "Impossible de générer le diff de comparaison (code $comparisonExitCode)."
}

Write-Utf8NoBom -Path $ComparisonPath -Content $comparison

Write-Host ""
Write-Host "============================================================"
Write-Host "TEST $Id TERMINÉ"
Write-Host "============================================================"
Write-Host ""
Write-Host "Baseline    : $BaselineRunPath"
Write-Host "Avec prompt : $WithPromptRunPath"
Write-Host "Comparaison : $ComparisonPath"
Write-Host ""
Write-Host "Le dépôt est revenu à son état initial."
Write-Host "Envoie-moi ensuite :"
Write-Host "  - $ComparisonPath"
Write-Host "  - les deux fichiers codex-final.txt"

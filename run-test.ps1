param(
    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [Alias("Story")]
    [string]$Case,

    [Parameter(Mandatory = $true)]
    [string]$PromptPath,

    [switch]$AllowUntrackedCase,

    [switch]$Embedded
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"

$RepoPath = (Get-Location).Path
$RepoName = Split-Path $RepoPath -Leaf
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
        Write-Host "Le dépôt doit être propre avant de lancer un test."
        git status
        throw "Commit ou annule les changements avant de relancer run-test.ps1."
    }
}

function Get-PromptBlock {
    param(
        [string]$Path
    )

    $content = Read-Utf8Text -Path $Path
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
    $logFile = Join-Path $tempRoot "codex-log.txt"

    Write-Utf8NoBom -Path $inputFile -Content $InputText

    $runLabel = if ($RunName -like "*-baseline") { "BASELINE" } else { "AVEC PROMPT" }
    Write-Host ("  [{0}] Exécution Codex..." -f $runLabel)

    $codexCommand = 'codex exec --ephemeral --color never --output-last-message "' + $finalFile + '" - 2>&1'

    $previousErrorActionPreference = $ErrorActionPreference

    try {
        $ErrorActionPreference = "Continue"
        $codexOutput = Read-Utf8Text -Path $inputFile | & $env:ComSpec /d /s /c $codexCommand | Out-String
        $codexExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    Write-Utf8NoBom -Path $logFile -Content $codexOutput
    Write-Utf8NoBom -Path $exitFile -Content ([string]$codexExitCode)

    & $SaveRunScript -Name $RunName

    $runPath = Join-Path $BackupRoot $RunName

    Copy-Item -LiteralPath $inputFile -Destination (Join-Path $runPath "codex-input.txt") -Force
    Copy-Item -LiteralPath $exitFile -Destination (Join-Path $runPath "codex-exit-code.txt") -Force
    Copy-Item -LiteralPath $logFile -Destination (Join-Path $runPath "codex-log.txt") -Force

    if (Test-Path -LiteralPath $finalFile) {
        Copy-Item -LiteralPath $finalFile -Destination (Join-Path $runPath "codex-final.txt") -Force
    }
    else {
        Write-Utf8NoBom -Path (Join-Path $runPath "codex-final.txt") -Content "(Aucun message final Codex enregistré.)"
    }

    Remove-Item -LiteralPath $tempRoot -Recurse -Force

    if ($codexExitCode -ne 0) {
        throw "Codex a terminé avec le code $codexExitCode pendant '$RunName' (voir codex-log.txt)."
    }

    Write-Host ("    [OK] {0}" -f $runLabel)
}

function Get-SavedRunExitCode {
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

function Remove-InvalidSavedRun {
    param(
        [string]$RunPath,
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $RunPath)) {
        return
    }

    $exitCode = Get-SavedRunExitCode -RunPath $RunPath

    if (($null -eq $exitCode) -or ($exitCode -ne 0)) {
        Write-Host ""
        Write-Host "$Label invalide détecté. Suppression avant reprise."
        Remove-Item -LiteralPath $RunPath -Recurse -Force

        if (Test-Path -LiteralPath $ComparisonPath) {
            Remove-Item -LiteralPath $ComparisonPath -Force
        }
    }
}

function New-Comparison {
    Write-Host ""
    Write-Host "  [COMPARAISON] Génération..."

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
    Write-Host "    [OK] Comparaison"
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

if (-not $AllowUntrackedCase) {
    $caseGitPath = $Case -replace '\\', '/'
    git ls-files --error-unmatch -- $caseGitPath *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Le cas de test doit être commité dans Git avant le test : $Case"
    }
}

if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) {
    throw "Prompt introuvable : $PromptPath"
}

Assert-CleanRepository

Remove-InvalidSavedRun -RunPath $BaselineRunPath -Label "Baseline"
Remove-InvalidSavedRun -RunPath $WithPromptRunPath -Label "Run avec prompt"

$baselineExists = Test-Path -LiteralPath $BaselineRunPath
$withPromptExists = Test-Path -LiteralPath $WithPromptRunPath
$comparisonExists = Test-Path -LiteralPath $ComparisonPath

if ($withPromptExists -and -not $baselineExists) {
    throw "État incohérent : le run avec prompt existe sans baseline pour le test $Id."
}

if ($comparisonExists -and (-not $baselineExists -or -not $withPromptExists)) {
    throw "État incohérent : la comparaison existe sans les deux runs pour le test $Id."
}

if ($baselineExists -and $withPromptExists -and $comparisonExists) {
    Write-Host ""
    Write-Host "TEST $Id déjà terminé. Aucun run relancé."
    return
}

$promptBlock = Get-PromptBlock -Path $PromptPath
$caseContent = Read-Utf8Text -Path $Case

$baselineInput = @"
Exécute la demande décrite dans le cas de test ci-dessous.
Utilise le repository comme contexte et modifie le code uniquement si le cas le demande.
Sous Windows PowerShell 5.1, si tu lis un fichier texte, lis-le explicitement en UTF-8 afin de préserver les accents.
N’exécute des tests, builds ou outils de validation que s’ils sont pertinents pour la tâche.
Si une commande échoue uniquement avec EPERM, Access denied ou une restriction du sandbox, traite cela comme une limitation d’environnement et non comme un défaut du repository.

$caseContent
"@

$withPromptInput = @"
$promptBlock

Contrainte d'environnement : sous Windows PowerShell 5.1, si tu lis un fichier texte, lis-le explicitement en UTF-8 afin de préserver les accents.
N’exécute des tests, builds ou outils de validation que s’ils sont pertinents pour la tâche.
Si une commande échoue uniquement avec EPERM, Access denied ou une restriction du sandbox, traite cela comme une limitation d’environnement et non comme un défaut du repository.

Cas de test à traiter :

$caseContent
"@

if (-not $baselineExists) {
    Invoke-CodexTestRun -RunName $BaselineName -InputText $baselineInput
}
else {
    Write-Host ""
    Write-Host "Baseline déjà présent pour $Id. Reprise au run avec prompt."
}

Assert-CleanRepository

if (-not $withPromptExists) {
    Invoke-CodexTestRun -RunName $WithPromptName -InputText $withPromptInput
}
else {
    Write-Host ""
    Write-Host "Run avec prompt déjà présent pour $Id. Reprise à la comparaison."
}

Assert-CleanRepository

if (-not $comparisonExists) {
    New-Comparison
}

Write-Host ("  [OK] Test {0} terminé" -f $Id)

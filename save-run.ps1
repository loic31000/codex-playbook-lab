param(
    [Parameter(Mandatory = $true)]
    [string]$Name
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding


$ErrorActionPreference = "Stop"

# ------------------------------------------------------------
# Configuration
# ------------------------------------------------------------

$RepoPath = (Get-Location).Path
$BackupRoot = Join-Path (Split-Path $RepoPath -Parent) "codex-playbook-test-runs"
$RunPath = Join-Path $BackupRoot $Name
$FilesPath = Join-Path $RunPath "files"

# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Invoke-AndCapture {
    param(
        [string]$Label,
        [scriptblock]$Command,
        [string]$OutputFile
    )

    $previousErrorActionPreference = $ErrorActionPreference

    try {
    $ErrorActionPreference = "Continue"

    $output = & $Command 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    }
    finally {
    $ErrorActionPreference = $previousErrorActionPreference
    }

    Write-Utf8NoBom -Path $OutputFile -Content $output

    if ($exitCode -eq 0) {
        Write-Host ("    [OK] {0}" -f $Label)
    }
    else {
        Write-Host ("    [ÉCHEC] {0} (code {1}, détail : {2})" -f $Label, $exitCode, (Split-Path $OutputFile -Leaf))
    }

    return $exitCode
}

# ------------------------------------------------------------
# Vérifications
# ------------------------------------------------------------

if (-not (Test-Path ".git")) {
    throw "Ce script doit être exécuté depuis la racine du dépôt Git."
}

if (Test-Path $RunPath) {
    throw "Le run '$Name' existe déjà : $RunPath"
}

New-Item -ItemType Directory -Force -Path $FilesPath | Out-Null

Write-Host "  Validation :"

# ------------------------------------------------------------
# Métadonnées du run
# ------------------------------------------------------------

$branch = git branch --show-current
$commit = git rev-parse HEAD
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$metadata = @"
Run: $Name
Date: $timestamp
Branch: $branch
Base commit: $commit
Repository: $RepoPath
"@

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "metadata.txt") `
    -Content $metadata

# ------------------------------------------------------------
# État Git
# ------------------------------------------------------------

$status = git status --short | Out-String

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "git-status.txt") `
    -Content $status

$diffStat = git diff --stat | Out-String

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "diff-stat.txt") `
    -Content $diffStat

$diff = git diff --binary | Out-String

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "diff.patch") `
    -Content $diff

# ------------------------------------------------------------
# Liste des fichiers touchés
# ------------------------------------------------------------

$trackedFiles = @(
    git diff --name-only
)

$untrackedFiles = @(
    git ls-files --others --exclude-standard
)

$allFiles = @(
    $trackedFiles
    $untrackedFiles
) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Sort-Object -Unique

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "files-list.txt") `
    -Content (($allFiles -join [Environment]::NewLine) + [Environment]::NewLine)

# ------------------------------------------------------------
# Copie des fichiers modifiés / créés
# ------------------------------------------------------------

foreach ($file in $allFiles) {

    if (-not (Test-Path $file -PathType Leaf)) {
        # Fichier supprimé : il reste documenté dans le diff/status.
        continue
    }

    $destination = Join-Path $FilesPath $file
    $destinationDirectory = Split-Path $destination -Parent

    if (-not (Test-Path $destinationDirectory)) {
        New-Item `
            -ItemType Directory `
            -Force `
            -Path $destinationDirectory |
            Out-Null
    }

    Copy-Item `
        -Path $file `
        -Destination $destination `
        -Force
}

# ------------------------------------------------------------
# Tests
# ------------------------------------------------------------

$testExitCode = Invoke-AndCapture `
    -Label "Tests" `
    -OutputFile (Join-Path $RunPath "tests.txt") `
    -Command {
        npm test -- --run
    }

# ------------------------------------------------------------
# TypeScript
# ------------------------------------------------------------

$typescriptExitCode = Invoke-AndCapture `
    -Label "TypeScript" `
    -OutputFile (Join-Path $RunPath "typescript.txt") `
    -Command {
        npx tsc --noEmit
    }

# ------------------------------------------------------------
# git diff --check
# ------------------------------------------------------------

$diffCheckExitCode = Invoke-AndCapture `
    -Label "git diff --check" `
    -OutputFile (Join-Path $RunPath "diff-check.txt") `
    -Command {
        git diff --check
    }

# ------------------------------------------------------------
# Résumé
# ------------------------------------------------------------

$summary = @"
Run: $Name

Tests exit code: $testExitCode
TypeScript exit code: $typescriptExitCode
git diff --check exit code: $diffCheckExitCode

0 = succès
autre valeur = échec
"@

Write-Utf8NoBom `
    -Path (Join-Path $RunPath "summary.txt") `
    -Content $summary

# ------------------------------------------------------------
# Réinitialisation
# ------------------------------------------------------------

$previousErrorActionPreference = $ErrorActionPreference

try {
    $ErrorActionPreference = "Continue"
    git reset --hard HEAD *> $null
    $resetExitCode = $LASTEXITCODE

    if ($resetExitCode -ne 0) {
        throw "git reset --hard HEAD a échoué. Le dépôt n'a pas été nettoyé."
    }

    git clean -fd *> $null
    $cleanExitCode = $LASTEXITCODE

    if ($cleanExitCode -ne 0) {
        throw "git clean -fd a échoué."
    }
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
}

$finalStatus = git status --porcelain | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "Impossible de vérifier l'état final du dépôt."
}

if ([string]::IsNullOrWhiteSpace($finalStatus)) {
    Write-Host "    [OK] Dépôt restauré"
}
else {
    throw "Le dépôt n'est pas propre après restauration."
}
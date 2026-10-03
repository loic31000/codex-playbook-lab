param(
    [string]$ConfigPath = "tests-suite.json"
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"

$RepoPath = (Get-Location).Path
$RepoName = Split-Path $RepoPath -Leaf
$RunTestScript = Join-Path $RepoPath "run-test.ps1"
$BackupRoot = Join-Path (Split-Path $RepoPath -Parent) "codex-playbook-test-runs"
$LegacyGeneratedCasesRoot = Join-Path $BackupRoot "generated-cases"
$SummaryPath = Join-Path $BackupRoot "suite-summary.md"
$ManifestPath = Join-Path $BackupRoot "generated-manifest.json"

function Write-AppHeader {
    param(
        [string]$ScriptName,
        [string]$Subtitle
    )

    Write-Host ""
    Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor DarkCyan
    Write-Host ("║  {0,-58}║" -f $RepoName) -ForegroundColor Cyan
    Write-Host ("║  {0,-58}║" -f $ScriptName) -ForegroundColor White
    Write-Host ("║  {0,-58}║" -f $Subtitle) -ForegroundColor DarkGray
    Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor DarkCyan
    Write-Host ""
}

function Write-UiStatus {
    param(
        [string]$Label,
        [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )

    Write-Host ("  [{0}] " -f $Label) -NoNewline -ForegroundColor $Color
    Write-Host $Message
}

function Format-Elapsed {
    param([TimeSpan]$Elapsed)
    return ("{0:00}:{1:00}" -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds)
}

function Invoke-CodexProcess {
    param(
        [string]$InputFile,
        [string]$FinalFile,
        [string]$LogFile,
        [string]$ActivityLabel
    )

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $codexCommand = 'codex exec --ephemeral --color never --output-last-message "' + $FinalFile + '" -'
    $started = Get-Date
    $process = $null

    try {
        $process = Start-Process `
            -FilePath $env:ComSpec `
            -ArgumentList @("/d", "/s", "/c", $codexCommand) `
            -RedirectStandardInput $InputFile `
            -RedirectStandardOutput $stdoutFile `
            -RedirectStandardError $stderrFile `
            -NoNewWindow `
            -PassThru

        $lastHeartbeat = -5

        while (-not $process.HasExited) {
            Start-Sleep -Milliseconds 500
            $elapsed = (Get-Date) - $started

            if ([int]$elapsed.TotalSeconds -ge ($lastHeartbeat + 5)) {
                $lastHeartbeat = [int]$elapsed.TotalSeconds
                Write-Host ("      ⏳ {0} — {1}" -f (Format-Elapsed $elapsed), $ActivityLabel) -ForegroundColor DarkYellow
            }
        }

        $process.WaitForExit()

        $stdout = if (Test-Path -LiteralPath $stdoutFile) { [System.IO.File]::ReadAllText($stdoutFile) } else { "" }
        $stderr = if (Test-Path -LiteralPath $stderrFile) { [System.IO.File]::ReadAllText($stderrFile) } else { "" }
        $combined = $stdout

        if (-not [string]::IsNullOrWhiteSpace($stderr)) {
            if (-not [string]::IsNullOrWhiteSpace($combined)) {
                $combined += [Environment]::NewLine
            }

            $combined += $stderr
        }

        Write-Utf8NoBom -Path $LogFile -Content $combined

        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Elapsed = ((Get-Date) - $started)
        }
    }
    finally {
        if (($null -ne $process) -and (-not $process.HasExited)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }

        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

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
        '(?i)\bHTTP\s*429\b',
        '(?i)\bstatus(?: code)?\s*[:=]?\s*429\b',
        '(?i)\brate_limit_exceeded\b',
        '(?i)\btoo many requests\b',
        '(?i)\binsufficient_quota\b',
        '(?i)\bcredit_balance_exhausted\b',
        '(?i)\borganization_usage_limit_exceeded\b',
        '(?i)\borganization_spend_limit_exceeded\b',
        '(?i)\bproject_spend_limit_exceeded\b',
        '(?i)\bquota exceeded\b',
        '(?i)\bquota exhausted\b',
        '(?i)\byou.?ve hit your usage limit\b',
        '(?i)\byou have hit your usage limit\b',
        '(?i)\bslow_down\b'
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

function Get-PromptFingerprint {
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
        return (-join ($hashBytes | ForEach-Object { $_.ToString("x2") }))
    }
    finally {
        $sha.Dispose()
    }
}

function Convert-ToSlug {
    param(
        [string]$Text,
        [int]$MaxLength = 26
    )

    $normalized = $Text.Normalize([System.Text.NormalizationForm]::FormD)
    $builder = New-Object System.Text.StringBuilder

    foreach ($char in $normalized.ToCharArray()) {
        $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($char)

        if ($category -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$builder.Append($char)
        }
    }

    $slug = $builder.ToString().ToLowerInvariant()
    $slug = $slug -replace '[^a-z0-9]+', '-'
    $slug = $slug.Trim('-')

    if ($slug.Length -gt $MaxLength) {
        $slug = $slug.Substring(0, $MaxLength).TrimEnd('-')
    }

    return $slug
}

function Get-FriendlyId {
    param(
        [string]$RelativePromptPath,
        [int]$CaseIndex
    )

    $parts = $RelativePromptPath -split '[\\/]'
    $section = "00"

    if (($parts.Count -gt 0) -and ($parts[0] -match '^(\d+)')) {
        $section = $Matches[1]
    }

    $stem = [System.IO.Path]::GetFileNameWithoutExtension($RelativePromptPath)
    $item = "00"
    $title = $stem

    if ($stem -match '^(\d+)\s*-\s*(.+)
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

function Get-GeneratedCaseFromLog {
    param(
        [string]$LogPath
    )

    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        return $null
    }

    $logText = Read-Utf8Text -Path $LogPath
    $matches = [regex]::Matches(
        $logText,
        '(?ms)^codex\s*\r?\n(.*?)(?=^tokens used\s*$|\z)'
    )

    if ($matches.Count -eq 0) {
        return $null
    }

    $candidate = $matches[$matches.Count - 1].Groups[1].Value.Trim()

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $null
    }

    if ($candidate.Length -lt 80) {
        return $null
    }

    return $candidate
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
- n’interprète pas une erreur EPERM, Access denied ou une restriction du sandbox comme un défaut du repository ;
- n’exécute des tests, builds ou validations que s’ils sont réellement utiles à la tâche évaluée ;
- si le prompt porte sur une review, un diagnostic, des logs, une architecture, une spécification ou de la documentation, fournis dans le cas tout le matériau concret nécessaire ;
- introduis une ambiguïté seulement si elle est pertinente pour ce prompt ;
- évite les dépendances externes et les services réseau ;
- le cas doit pouvoir être exécuté sans intervention humaine ;
- reste compact.

Retourne uniquement le Markdown du cas de test.
"@

    Write-Utf8NoBom -Path $inputFile -Content $generatorInput

    $generationRun = Invoke-CodexProcess `
        -InputFile $inputFile `
        -FinalFile $finalFile `
        -LogFile $GenerationLogPath `
        -ActivityLabel "Génération du cas — Codex travaille toujours..."

    $exitCode = $generationRun.ExitCode
    $generated = ""

    if (Test-Path -LiteralPath $finalFile -PathType Leaf) {
        $generated = (Read-Utf8Text -Path $finalFile).Trim()
    }

    if (-not [string]::IsNullOrWhiteSpace($generated)) {
        Write-Utf8NoBom -Path $CasePath -Content ($generated + [Environment]::NewLine)

        if ($exitCode -eq 0) {
            Write-Host ("    ✓ Cas généré en {0}" -f (Format-Elapsed $generationRun.Elapsed)) -ForegroundColor Green
        }
        else {
            Write-Host ("    ✓ Cas généré en {0} • warning Codex code {1} ignoré" -f (Format-Elapsed $generationRun.Elapsed), $exitCode) -ForegroundColor Yellow
        }

        Remove-Item -LiteralPath $tempRoot -Recurse -Force
        return
    }

    Remove-Item -LiteralPath $tempRoot -Recurse -Force

    if ($exitCode -ne 0) {
        throw "CASE_GENERATION_FAILED [$Id] code=$exitCode sans fichier final exploitable (voir le log de génération)."
    }

    throw "CASE_GENERATION_FAILED [$Id] aucun cas exploitable généré."
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

    $packagePath = Join-Path (Join-Path $BackupRoot $Id) "result.md"
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
        $legacyId = Get-StableId -RelativePromptPath $prompt.RelativePath -PromptBlock $prompt.PromptBlock -CaseIndex $caseIndex
        $fingerprint = Get-PromptFingerprint -RelativePromptPath $prompt.RelativePath -PromptBlock $prompt.PromptBlock -CaseIndex $caseIndex
        $id = Get-FriendlyId -RelativePromptPath $prompt.RelativePath -CaseIndex $caseIndex

        $tests += [pscustomobject]@{
            Id = $id
            LegacyId = $legacyId
            Fingerprint = $fingerprint
            PromptPath = $prompt.FullPath
            PromptRelativePath = $prompt.RelativePath
            PromptBlock = $prompt.PromptBlock
            CaseIndex = $caseIndex
        }

        $manifest += [pscustomobject]@{
            id = $id
            fingerprint = $fingerprint
            prompt = $prompt.RelativePath
            folder = $id
            case = "$id/case.md"
            case_index = $caseIndex
        }
    }
}

Write-Utf8NoBom -Path $ManifestPath -Content ($manifest | ConvertTo-Json -Depth 4)

$results = @()
$startedAt = Get-Date
$stoppedForLimit = $false
$stoppedForInfrastructure = $false
$position = 0

Write-AppHeader -ScriptName "run-suite.ps1 • Suite automatique" -Subtitle "Tests A/B des prompts Codex"
Write-Host ("  Prompts détectés : {0}" -f $prompts.Count) -ForegroundColor Gray
Write-Host ("  Cas par prompt   : {0}" -f $casesPerPrompt) -ForegroundColor Gray
Write-Host ("  Tests à traiter  : {0}" -f $tests.Count) -ForegroundColor White
Write-Host ""

foreach ($test in $tests) {
    $position++
    $id = $test.Id
    $promptPath = $test.PromptPath
    $promptRelativePath = $test.PromptRelativePath

    $storage = Initialize-TestStorage -Id $id -LegacyId $test.LegacyId -Fingerprint $test.Fingerprint
    $casePath = $storage.CasePath
    $baselinePath = $storage.BaselinePath
    $withPromptPath = $storage.PromptPath
    $comparisonPath = $storage.ComparisonPath
    $runLogPath = $storage.SuiteLogPath
    $generationLogPath = $storage.GenerationLogPath

    if ((Test-Path -LiteralPath $baselinePath) -and (Test-Path -LiteralPath $withPromptPath) -and (Test-Path -LiteralPath $comparisonPath)) {
        Write-Host ("[{0}/{1}] " -f $position, $tests.Count) -NoNewline -ForegroundColor DarkGray
        Write-Host $promptRelativePath -NoNewline -ForegroundColor White
        Write-Host "  ✓ DÉJÀ TERMINÉ" -ForegroundColor DarkGreen
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
    Write-Host ("[{0}/{1}] " -f $position, $tests.Count) -NoNewline -ForegroundColor DarkGray
    Write-Host $promptRelativePath -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $casePath -PathType Leaf)) {
        $recoveredCase = Get-GeneratedCaseFromLog -LogPath $generationLogPath

        if (-not [string]::IsNullOrWhiteSpace($recoveredCase)) {
            Write-Utf8NoBom -Path $casePath -Content ($recoveredCase + [Environment]::NewLine)
            Write-UiStatus -Label "CAS" -Message "Récupéré depuis le log précédent" -Color DarkGreen
        }
        else {
            Write-UiStatus -Label "CAS" -Message "Génération..." -Color Yellow

            try {
                Invoke-CaseGeneration -Id $id -PromptRelativePath $promptRelativePath -PromptBlock $test.PromptBlock -CasePath $casePath -GenerationLogPath $generationLogPath
            }
        catch {
            $message = $_.Exception.Message
            $generationLogText = ""

            if (Test-Path -LiteralPath $generationLogPath -PathType Leaf) {
                $generationLogText = Read-Utf8Text -Path $generationLogPath
            }

            $combinedGenerationError = $generationLogText + [Environment]::NewLine + $message

            if (Test-IsCodexLimitError -Text $combinedGenerationError) {
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

            if (Test-IsFatalInfrastructureError -Text $combinedGenerationError) {
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
            Write-Host ("  ✗ Génération du cas — voir {0}" -f (Split-Path $generationLogPath -Leaf)) -ForegroundColor Red

            $results += [pscustomobject]@{
                Id = $id
                Prompt = $promptRelativePath
                Status = "ÉCHEC GÉNÉRATION"
                Detail = $message
            }

                continue
            }
        }
    }
    else {
        Write-UiStatus -Label "CAS" -Message "Réutilisé" -Color DarkGreen
    }

    Remove-Item -LiteralPath $runLogPath -Force -ErrorAction SilentlyContinue

    try {
        & $RunTestScript -Id $id -Case $casePath -PromptPath $promptPath -AllowUntrackedCase -Embedded

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

        $codexLogText = ""
        foreach ($candidateRunPath in @($baselinePath, $withPromptPath)) {
            $candidateLogPath = Join-Path $candidateRunPath "codex-log.txt"
            if (Test-Path -LiteralPath $candidateLogPath -PathType Leaf) {
                $codexLogText += Read-Utf8Text -Path $candidateLogPath
                $codexLogText += [Environment]::NewLine
            }
        }

        $combinedError = $logText + [Environment]::NewLine + $codexLogText + [Environment]::NewLine + $message

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
        Write-Host ("  ✗ Test {0} : {1}" -f $id, $message) -ForegroundColor Red

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
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkCyan

if ($stoppedForLimit) {
    Write-Host "  SUITE ARRÊTÉE • LIMITE CODEX" -ForegroundColor Yellow
}
elseif ($stoppedForInfrastructure) {
    Write-Host "  SUITE ARRÊTÉE • INFRASTRUCTURE CODEX" -ForegroundColor Red
}
else {
    Write-Host "  ✓ SUITE TERMINÉE" -ForegroundColor Green
}

Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "Prompts détectés      : $($prompts.Count)"
Write-Host "OK                    : $okCount"
Write-Host "Déjà terminés         : $doneCount"
Write-Host "Échecs génération     : $generationFailedCount"
Write-Host "Échecs test           : $failedCount"
Write-Host "Arrêts limite Codex   : $limitStopCount"
Write-Host "Arrêts infrastructure : $infraStopCount"
Write-Host "Résumé                : ..\codex-playbook-test-runs\suite-summary.md"
Write-Host "Manifest              : ..\codex-playbook-test-runs\generated-manifest.json"
Write-Host ""
if (Test-Path -LiteralPath $LegacyGeneratedCasesRoot -PathType Container) {
    $remainingLegacyCases = @(Get-ChildItem -LiteralPath $LegacyGeneratedCasesRoot -Force)

    if ($remainingLegacyCases.Count -eq 0) {
        Remove-Item -LiteralPath $LegacyGeneratedCasesRoot -Force
    }
}

Write-Host "Pour reprendre : .\run-suite.ps1"
) {
        $item = $Matches[1]
        $title = $Matches[2]
    }

    $slug = Convert-ToSlug -Text $title

    if ([string]::IsNullOrWhiteSpace($slug)) {
        $slug = "prompt"
    }

    $id = "$section-$item-$slug"

    if ($CaseIndex -gt 1) {
        $id += "-c$CaseIndex"
    }

    return $id
}

function Move-LegacyArtifact {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        return
    }

    if (Test-Path -LiteralPath $Destination) {
        return
    }

    $parent = Split-Path $Destination -Parent

    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Move-Item -LiteralPath $Source -Destination $Destination
}

function Initialize-TestStorage {
    param(
        [string]$Id,
        [string]$LegacyId,
        [string]$Fingerprint
    )

    $testRoot = Join-Path $BackupRoot $Id
    $fingerprintPath = Join-Path $testRoot "fingerprint.txt"

    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        if (Test-Path -LiteralPath $fingerprintPath -PathType Leaf) {
            $existingFingerprint = (Read-Utf8Text -Path $fingerprintPath).Trim()

            if (($existingFingerprint.Length -gt 0) -and ($existingFingerprint -ne $Fingerprint)) {
                $archiveRoot = Join-Path $BackupRoot "_archive"
                New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null

                $suffix = $existingFingerprint.Substring(0, [Math]::Min(8, $existingFingerprint.Length))
                $archivePath = Join-Path $archiveRoot "$Id-$suffix"
                $counter = 2

                while (Test-Path -LiteralPath $archivePath) {
                    $archivePath = Join-Path $archiveRoot "$Id-$suffix-$counter"
                    $counter++
                }

                Move-Item -LiteralPath $testRoot -Destination $archivePath
            }
        }
    }

    $legacyBaseline = Join-Path $BackupRoot "$LegacyId-baseline"
    $legacyPrompt = Join-Path $BackupRoot "$LegacyId-with-prompt"
    $legacyDiff = Join-Path $BackupRoot "$LegacyId-comparison.diff"
    $legacyResult = Join-Path $BackupRoot "$LegacyId-result.md"
    $legacySuiteLog = Join-Path $BackupRoot "$LegacyId-suite.log"
    $legacyCase = Join-Path $LegacyGeneratedCasesRoot "$LegacyId.md"
    $legacyGenerationLog = Join-Path $LegacyGeneratedCasesRoot "$LegacyId-generation.log"

    $legacyExists = (
        (Test-Path -LiteralPath $legacyBaseline) -or
        (Test-Path -LiteralPath $legacyPrompt) -or
        (Test-Path -LiteralPath $legacyDiff) -or
        (Test-Path -LiteralPath $legacyResult) -or
        (Test-Path -LiteralPath $legacySuiteLog) -or
        (Test-Path -LiteralPath $legacyCase) -or
        (Test-Path -LiteralPath $legacyGenerationLog)
    )

    if ($legacyExists) {
        New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

        Move-LegacyArtifact -Source $legacyBaseline -Destination (Join-Path $testRoot "base")
        Move-LegacyArtifact -Source $legacyPrompt -Destination (Join-Path $testRoot "prompt")
        Move-LegacyArtifact -Source $legacyDiff -Destination (Join-Path $testRoot "diff.patch")
        Move-LegacyArtifact -Source $legacyResult -Destination (Join-Path $testRoot "result.md")
        Move-LegacyArtifact -Source $legacySuiteLog -Destination (Join-Path $testRoot "suite.log")
        Move-LegacyArtifact -Source $legacyCase -Destination (Join-Path $testRoot "case.md")
        Move-LegacyArtifact -Source $legacyGenerationLog -Destination (Join-Path $testRoot "generation.log")
    }

    if (-not (Test-Path -LiteralPath $testRoot -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    }

    Write-Utf8NoBom -Path $fingerprintPath -Content ($Fingerprint + [Environment]::NewLine)

    return [pscustomobject]@{
        TestRoot = $testRoot
        CasePath = Join-Path $testRoot "case.md"
        BaselinePath = Join-Path $testRoot "base"
        PromptPath = Join-Path $testRoot "prompt"
        ComparisonPath = Join-Path $testRoot "diff.patch"
        GenerationLogPath = Join-Path $testRoot "generation.log"
        SuiteLogPath = Join-Path $testRoot "suite.log"
    }
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

function Get-GeneratedCaseFromLog {
    param(
        [string]$LogPath
    )

    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        return $null
    }

    $logText = Read-Utf8Text -Path $LogPath
    $matches = [regex]::Matches(
        $logText,
        '(?ms)^codex\s*\r?\n(.*?)(?=^tokens used\s*$|\z)'
    )

    if ($matches.Count -eq 0) {
        return $null
    }

    $candidate = $matches[$matches.Count - 1].Groups[1].Value.Trim()

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $null
    }

    if ($candidate.Length -lt 80) {
        return $null
    }

    return $candidate
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
- n’interprète pas une erreur EPERM, Access denied ou une restriction du sandbox comme un défaut du repository ;
- n’exécute des tests, builds ou validations que s’ils sont réellement utiles à la tâche évaluée ;
- si le prompt porte sur une review, un diagnostic, des logs, une architecture, une spécification ou de la documentation, fournis dans le cas tout le matériau concret nécessaire ;
- introduis une ambiguïté seulement si elle est pertinente pour ce prompt ;
- évite les dépendances externes et les services réseau ;
- le cas doit pouvoir être exécuté sans intervention humaine ;
- reste compact.

Retourne uniquement le Markdown du cas de test.
"@

    Write-Utf8NoBom -Path $inputFile -Content $generatorInput

    $generationRun = Invoke-CodexProcess `
        -InputFile $inputFile `
        -FinalFile $finalFile `
        -LogFile $GenerationLogPath `
        -ActivityLabel "Génération du cas — Codex travaille toujours..."

    $exitCode = $generationRun.ExitCode
    $generated = ""

    if (Test-Path -LiteralPath $finalFile -PathType Leaf) {
        $generated = (Read-Utf8Text -Path $finalFile).Trim()
    }

    if (-not [string]::IsNullOrWhiteSpace($generated)) {
        Write-Utf8NoBom -Path $CasePath -Content ($generated + [Environment]::NewLine)

        if ($exitCode -eq 0) {
            Write-Host ("    ✓ Cas généré en {0}" -f (Format-Elapsed $generationRun.Elapsed)) -ForegroundColor Green
        }
        else {
            Write-Host ("    ✓ Cas généré en {0} • warning Codex code {1} ignoré" -f (Format-Elapsed $generationRun.Elapsed), $exitCode) -ForegroundColor Yellow
        }

        Remove-Item -LiteralPath $tempRoot -Recurse -Force
        return
    }

    Remove-Item -LiteralPath $tempRoot -Recurse -Force

    if ($exitCode -ne 0) {
        throw "CASE_GENERATION_FAILED [$Id] code=$exitCode sans fichier final exploitable (voir le log de génération)."
    }

    throw "CASE_GENERATION_FAILED [$Id] aucun cas exploitable généré."
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
$position = 0

Write-AppHeader -ScriptName "run-suite.ps1 • Suite automatique" -Subtitle "Tests A/B des prompts Codex"
Write-Host ("  Prompts détectés : {0}" -f $prompts.Count) -ForegroundColor Gray
Write-Host ("  Cas par prompt   : {0}" -f $casesPerPrompt) -ForegroundColor Gray
Write-Host ("  Tests à traiter  : {0}" -f $tests.Count) -ForegroundColor White
Write-Host ""

foreach ($test in $tests) {
    $position++
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
        Write-Host ("[{0}/{1}] " -f $position, $tests.Count) -NoNewline -ForegroundColor DarkGray
        Write-Host $promptRelativePath -NoNewline -ForegroundColor White
        Write-Host "  ✓ DÉJÀ TERMINÉ" -ForegroundColor DarkGreen
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
    Write-Host ("[{0}/{1}] " -f $position, $tests.Count) -NoNewline -ForegroundColor DarkGray
    Write-Host $promptRelativePath -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $casePath -PathType Leaf)) {
        $recoveredCase = Get-GeneratedCaseFromLog -LogPath $generationLogPath

        if (-not [string]::IsNullOrWhiteSpace($recoveredCase)) {
            Write-Utf8NoBom -Path $casePath -Content ($recoveredCase + [Environment]::NewLine)
            Write-UiStatus -Label "CAS" -Message "Récupéré depuis le log précédent" -Color DarkGreen
        }
        else {
            Write-UiStatus -Label "CAS" -Message "Génération..." -Color Yellow

            try {
                Invoke-CaseGeneration -Id $id -PromptRelativePath $promptRelativePath -PromptBlock $test.PromptBlock -CasePath $casePath -GenerationLogPath $generationLogPath
            }
        catch {
            $message = $_.Exception.Message
            $generationLogText = ""

            if (Test-Path -LiteralPath $generationLogPath -PathType Leaf) {
                $generationLogText = Read-Utf8Text -Path $generationLogPath
            }

            $combinedGenerationError = $generationLogText + [Environment]::NewLine + $message

            if (Test-IsCodexLimitError -Text $combinedGenerationError) {
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

            if (Test-IsFatalInfrastructureError -Text $combinedGenerationError) {
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
            Write-Host ("  ✗ Génération du cas — voir {0}" -f (Split-Path $generationLogPath -Leaf)) -ForegroundColor Red

            $results += [pscustomobject]@{
                Id = $id
                Prompt = $promptRelativePath
                Status = "ÉCHEC GÉNÉRATION"
                Detail = $message
            }

                continue
            }
        }
    }
    else {
        Write-UiStatus -Label "CAS" -Message "Réutilisé" -Color DarkGreen
    }

    Remove-Item -LiteralPath $runLogPath -Force -ErrorAction SilentlyContinue

    try {
        & $RunTestScript -Id $id -Case $casePath -PromptPath $promptPath -AllowUntrackedCase -Embedded

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

        $codexLogText = ""
        foreach ($candidateRunPath in @($baselinePath, $withPromptPath)) {
            $candidateLogPath = Join-Path $candidateRunPath "codex-log.txt"
            if (Test-Path -LiteralPath $candidateLogPath -PathType Leaf) {
                $codexLogText += Read-Utf8Text -Path $candidateLogPath
                $codexLogText += [Environment]::NewLine
            }
        }

        $combinedError = $logText + [Environment]::NewLine + $codexLogText + [Environment]::NewLine + $message

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
        Write-Host ("  ✗ Test {0} : {1}" -f $id, $message) -ForegroundColor Red

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
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkCyan

if ($stoppedForLimit) {
    Write-Host "  SUITE ARRÊTÉE • LIMITE CODEX" -ForegroundColor Yellow
}
elseif ($stoppedForInfrastructure) {
    Write-Host "  SUITE ARRÊTÉE • INFRASTRUCTURE CODEX" -ForegroundColor Red
}
else {
    Write-Host "  ✓ SUITE TERMINÉE" -ForegroundColor Green
}

Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "Prompts détectés      : $($prompts.Count)"
Write-Host "OK                    : $okCount"
Write-Host "Déjà terminés         : $doneCount"
Write-Host "Échecs génération     : $generationFailedCount"
Write-Host "Échecs test           : $failedCount"
Write-Host "Arrêts limite Codex   : $limitStopCount"
Write-Host "Arrêts infrastructure : $infraStopCount"
Write-Host "Résumé                : ..\codex-playbook-test-runs\suite-summary.md"
Write-Host "Manifest              : ..\codex-playbook-test-runs\generated-manifest.json"
Write-Host ""
Write-Host "Pour reprendre : .\run-suite.ps1"

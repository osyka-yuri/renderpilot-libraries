#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Creates or updates a GitHub Release and uploads ZIP assets.

.DESCRIPTION
    - Requires GitHub CLI: https://cli.github.com/
    - Requires authentication: gh auth login
    - Requires a GitHub token with access to the target repository.
    - By default, verifies that the Git tag already exists on GitHub.

.EXAMPLE
    ./Publish-Release.ps1

.EXAMPLE
    ./Publish-Release.ps1 -Tag v1.0.1 -ReleaseName "RenderPilot Libraries v1.0.1"

.EXAMPLE
    ./Publish-Release.ps1 -WhatIf
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter()]
    [ValidatePattern('^[^/\s]+/[^/\s]+$')]
    [string] $Repo = "osyka-yuri/renderpilot-libraries",

    [Parameter()]
    [ValidateNotNullOrWhiteSpace()]
    [string] $Tag = "v1.0.0",

    [Parameter()]
    [ValidateNotNullOrWhiteSpace()]
    [string] $ReleaseName = "RenderPilot Libraries v1.0.0",

    [Parameter()]
    [ValidateNotNullOrWhiteSpace()]
    [string] $ReleaseNotes = "RenderPilot library archives",

    [Parameter()]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,

    [Parameter()]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $AssetRoot = $RepoRoot,

    [Parameter()]
    [switch] $SkipAuthCheck,

    [Parameter()]
    [switch] $SkipTagVerification,

    [Parameter()]
    [switch] $AllowDuplicateAssetNames,

    [Parameter()]
    [ValidateRange(0, 5)]
    [int] $UploadRetryCount = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Success {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Write-Fail {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host $Message -ForegroundColor Red
}

function Format-FileSize {
    param([Parameter(Mandatory)][long] $Bytes)

    if ($Bytes -ge 1GB) {
        return "{0:N2} GB" -f ($Bytes / 1GB)
    }

    if ($Bytes -ge 1MB) {
        return "{0:N2} MB" -f ($Bytes / 1MB)
    }

    if ($Bytes -ge 1KB) {
        return "{0:N2} KB" -f ($Bytes / 1KB)
    }

    return "$Bytes B"
}

function Invoke-Gh {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]] $Arguments,

        [Parameter()]
        [switch] $AllowFailure
    )

    $output = & gh @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $command = "gh $($Arguments -join ' ')"
        throw @"
Command failed with exit code $exitCode.

Command:
$command

Output:
$text
"@
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $text
    }
}

function Invoke-WithRetry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock] $Operation,

        [Parameter(Mandatory)]
        [string] $Description,

        [Parameter()]
        [ValidateRange(0, 5)]
        [int] $RetryCount = 0
    )

    $maxAttempts = $RetryCount + 1

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            return & $Operation
        }
        catch {
            if ($attempt -ge $maxAttempts) {
                throw
            }

            $delaySeconds = [Math]::Min(30, [Math]::Pow(2, $attempt))
            Write-Warn "$Description failed. Retrying in $delaySeconds second(s). Attempt $($attempt + 1) of $maxAttempts..."
            Start-Sleep -Seconds $delaySeconds
        }
    }
}

function Test-ReleaseExists {
    param(
        [Parameter(Mandatory)][string] $Repository,
        [Parameter(Mandatory)][string] $ReleaseTag
    )

    $result = Invoke-Gh -Arguments @(
        "release", "view", $ReleaseTag,
        "--repo", $Repository,
        "--json", "tagName",
        "--jq", ".tagName"
    ) -AllowFailure

    return $result.ExitCode -eq 0
}

function Get-ZipAssets {
    param(
        [Parameter(Mandatory)][string] $Root
    )

    Get-ChildItem -LiteralPath $Root -Recurse -Filter "*.zip" -File |
        Sort-Object -Property FullName
}

# -----------------------------
# Preflight checks
# -----------------------------

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI is required. Install it from https://cli.github.com/"
}

Write-Info "Repository : $Repo"
Write-Info "Tag        : $Tag"
Write-Info "Asset root : $AssetRoot"

if (-not $SkipAuthCheck) {
    Write-Info "Checking GitHub authentication..."
    Invoke-Gh -Arguments @("auth", "status") | Out-Null
}

Write-Info "Checking repository access..."
Invoke-Gh -Arguments @(
    "repo", "view", $Repo,
    "--json", "nameWithOwner",
    "--jq", ".nameWithOwner"
) | Out-Null

$zipFiles = @(Get-ZipAssets -Root $AssetRoot)

if ($zipFiles.Count -eq 0) {
    throw "No ZIP files found under: $AssetRoot"
}

$duplicateAssetNames = @(
    $zipFiles |
        Group-Object -Property Name |
        Where-Object { $_.Count -gt 1 }
)

if ($duplicateAssetNames.Count -gt 0 -and -not $AllowDuplicateAssetNames) {
    $message = $duplicateAssetNames |
        ForEach-Object {
            $paths = $_.Group.FullName -join [Environment]::NewLine
            "Duplicate asset name '$($_.Name)' found in:$([Environment]::NewLine)$paths"
        } |
        Out-String

    throw @"
Duplicate ZIP filenames would overwrite each other on the GitHub Release.

$message

Rename the files, or rerun with -AllowDuplicateAssetNames if overwriting by name is intentional.
"@
}

Write-Success "Found $($zipFiles.Count) ZIP asset(s):"
foreach ($zip in $zipFiles) {
    $relativePath = Resolve-Path -LiteralPath $zip.FullName -Relative
    Write-Host "  - $relativePath ($(Format-FileSize -Bytes $zip.Length))"
}

# -----------------------------
# Create release if needed
# -----------------------------

$releaseExists = Test-ReleaseExists -Repository $Repo -ReleaseTag $Tag

if ($releaseExists) {
    Write-Warn "Release '$Tag' already exists. Assets will be uploaded with --clobber."
}
else {
    $createArgs = @(
        "release", "create", $Tag,
        "--repo", $Repo,
        "--title", $ReleaseName,
        "--notes", $ReleaseNotes
    )

    if (-not $SkipTagVerification) {
        $createArgs += "--verify-tag"
    }

    if ($PSCmdlet.ShouldProcess("$Repo release $Tag", "Create GitHub Release")) {
        Write-Info "Creating release '$Tag'..."
        Invoke-Gh -Arguments $createArgs | Out-Null
        Write-Success "Release created."
    }
}

# -----------------------------
# Upload assets
# -----------------------------

$failedUploads = New-Object System.Collections.Generic.List[string]

foreach ($zip in $zipFiles) {
    $assetName = $zip.Name
    Write-Info "Uploading $assetName..."

    if (-not $PSCmdlet.ShouldProcess("$Repo release $Tag", "Upload asset $assetName")) {
        continue
    }

    try {
        Invoke-WithRetry `
            -Description "Upload of '$assetName'" `
            -RetryCount $UploadRetryCount `
            -Operation {
                Invoke-Gh -Arguments @(
                    "release", "upload", $Tag,
                    $zip.FullName,
                    "--repo", $Repo,
                    "--clobber"
                ) | Out-Null
            }

        Write-Success "Uploaded $assetName."
    }
    catch {
        Write-Fail "Failed to upload $assetName."
        Write-Fail $_.Exception.Message
        $failedUploads.Add($zip.FullName)
    }
}

# -----------------------------
# Summary
# -----------------------------

if ($failedUploads.Count -gt 0) {
    $failedList = $failedUploads -join [Environment]::NewLine

    throw @"
Release upload completed with $($failedUploads.Count) failed asset(s):

$failedList
"@
}

$releaseUrl = "https://github.com/$Repo/releases/tag/$Tag"

Write-Success ""
Write-Success "Done."
Write-Success "Release URL: $releaseUrl"
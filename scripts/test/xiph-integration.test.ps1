[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]] $PairKey = @(
        '1.3.7|1.3.6'
        '1.0|1.0'
    ),

    [Parameter()]
    [switch] $KeepArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-SafeIntegrationDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $ParentPath
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($ParentPath)

    $actualParent = [IO.Path]::GetDirectoryName($resolvedPath)
    $directoryName = [IO.Path]::GetFileName($resolvedPath)

    $isDirectChild = [string]::Equals(
        $actualParent,
        $resolvedParent,
        [StringComparison]::OrdinalIgnoreCase
    )

    $hasExpectedName = $directoryName -cmatch '^rpx-[0-9a-f]{8}$'

    if (-not $isDirectChild -or -not $hasExpectedName) {
        throw "Refusing unsafe Xiph integration directory: $resolvedPath"
    }
}

function New-XiphIntegrationDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $ParentPath
    )

    $directoryName = 'rpx-{0}' -f (
        [Guid]::NewGuid().ToString('N').Substring(0, 8)
    )

    $directoryPath = [IO.Path]::GetFullPath(
        (Join-Path $ParentPath $directoryName)
    )

    Assert-SafeIntegrationDirectory `
        -Path $directoryPath `
        -ParentPath $ParentPath

    [void] (New-Item -ItemType Directory -Path $directoryPath)

    return $directoryPath
}

function Get-XiphLockedPair {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Lock,

        [Parameter(Mandatory)]
        [string] $RequestedPair
    )

    if ($RequestedPair -cnotmatch '^[^|\s]+\|[^|\s]+$') {
        throw "Invalid Xiph pair key: $RequestedPair"
    }

    $pairsProperty = $Lock.PSObject.Properties['pairs']

    if ($null -eq $pairsProperty) {
        throw 'The Xiph lock file does not contain a pairs property.'
    }

    $matchingPairs = @(
        $pairsProperty.Value | Where-Object {
            $lockedPairKey = '{0}|{1}' -f `
                $_.vorbis_version,
            $_.ogg_version

            [string]::Equals(
                $lockedPairKey,
                $RequestedPair,
                [StringComparison]::Ordinal
            )
        }
    )

    if ($matchingPairs.Count -ne 1) {
        throw "Xiph integration pair is not uniquely locked: $RequestedPair"
    }

    # Copy the top-level object so integration-specific changes do not mutate
    # the source lock loaded in memory.
    $pair = [ordered]@{}

    foreach ($property in $matchingPairs[0].PSObject.Properties) {
        $pair[$property.Name] = $property.Value
    }

    $pair['build_revision'] = 1
    $pair['builds'] = @()

    return [pscustomobject] $pair
}

function Write-JsonFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Value,

        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter()]
        [ValidateRange(1, 100)]
        [int] $Depth = 40
    )

    $json = ConvertTo-Json `
        -InputObject $Value `
        -Depth $Depth

    Set-Content `
        -LiteralPath $Path `
        -Value $json `
        -Encoding utf8
}

function Assert-CommandSucceeded {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool] $Succeeded,

        [Parameter(Mandatory)]
        [int] $ExitCode,

        [Parameter(Mandatory)]
        [string] $FailureMessage
    )

    if ($Succeeded -and $ExitCode -eq 0) {
        return
    }

    $exitCodeSuffix = if ($ExitCode -ne 0) {
        " (exit code: $ExitCode)"
    }
    else {
        ''
    }

    throw "$FailureMessage$exitCodeSuffix"
}


$repoRoot = [IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '../..')
)

$sourceLockPath = Join-Path `
    $repoRoot `
    'catalogs/libraries/xiph.lock.json'

$buildScriptPath = Join-Path `
    $repoRoot `
    'scripts/build-xiph-source.ps1'

$finalizeScriptPath = Join-Path `
    $repoRoot `
    'scripts/xiph-integration-finalize.mjs'

# MSBuild FileTracker emits MSB8029 for builds under long paths such as
# %TEMP%. Place integration directories at the root of the repository drive.
$sandboxParent = [IO.Path]::GetFullPath(
    [IO.Path]::GetPathRoot($repoRoot)
)

foreach ($requiredFile in @(
        $sourceLockPath
        $buildScriptPath
        $finalizeScriptPath
    )) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required Xiph integration file does not exist: $requiredFile"
    }
}

$nodeExecutable = (
    Get-Command node -CommandType Application -ErrorAction Stop
).Source

$sourceLock = Get-Content `
    -LiteralPath $sourceLockPath `
    -Raw |
ConvertFrom-Json -Depth 40

$emptySourceCatalog = [ordered]@{
    schema_version  = 1

    vendor          = [ordered]@{
        id           = 'xiph'
        display_name = 'Xiph.Org Foundation'
    }

    generated_at    = '1970-01-01T00:00:00.000Z'
    legal_documents = @()
    artifacts       = @()
    packages        = @()
}

foreach ($requestedPair in $PairKey) {
    $lockedPair = Get-XiphLockedPair `
        -Lock $sourceLock `
        -RequestedPair $requestedPair

    $integrationRoot = New-XiphIntegrationDirectory `
        -ParentPath $sandboxParent

    $integrationCompleted = $false

    try {
        $lockFile = Join-Path $integrationRoot 'xiph.lock.json'
        $sourceFile = Join-Path $integrationRoot 'xiph.json'
        $buildRoot = Join-Path $integrationRoot 'build'
        $cdnDirectory = Join-Path $integrationRoot 'cdn'

        $integrationLock = [ordered]@{
            schema_version = 1
            pairs          = @($lockedPair)
        }

        Write-JsonFile `
            -Value $integrationLock `
            -Path $lockFile

        Write-JsonFile `
            -Value $emptySourceCatalog `
            -Path $sourceFile `
            -Depth 10

        $buildParameters = @{
            LockFile        = $lockFile
            OutputDirectory = $buildRoot
            PairKey         = $requestedPair
            KeepArtifacts   = $KeepArtifacts.IsPresent
        }

        & $buildScriptPath @buildParameters

        $buildSucceeded = $?
        $buildExitCode = if ($buildSucceeded) { 0 } else { 1 }

        Assert-CommandSucceeded `
            -Succeeded $buildSucceeded `
            -ExitCode $buildExitCode `
            -FailureMessage "Xiph integration build failed: $requestedPair"

        $finalizeArguments = @(
            $finalizeScriptPath
            "--build-root=$buildRoot"
            "--lock-file=$lockFile"
            "--source-file=$sourceFile"
            "--cdn-directory=$cdnDirectory"
        )

        & $nodeExecutable @finalizeArguments

        $finalizationSucceeded = $?
        $finalizationExitCode = $LASTEXITCODE

        Assert-CommandSucceeded `
            -Succeeded $finalizationSucceeded `
            -ExitCode $finalizationExitCode `
            -FailureMessage "Xiph integration finalization failed: $requestedPair"

        $integrationCompleted = $true
    }
    finally {
        if (Test-Path -LiteralPath $integrationRoot) {
            if ($KeepArtifacts) {
                Write-Warning (
                    "Preserving Xiph integration artifacts: " +
                    $integrationRoot
                )
            }
            else {
                try {
                    Assert-SafeIntegrationDirectory `
                        -Path $integrationRoot `
                        -ParentPath $sandboxParent

                    Remove-Item `
                        -LiteralPath $integrationRoot `
                        -Recurse `
                        -Force
                }
                catch {
                    if ($integrationCompleted) {
                        throw
                    }

                    # Do not replace the original build/finalization exception
                    # with a secondary cleanup error.
                    Write-Warning (
                        "Failed to clean Xiph integration directory " +
                        "'$integrationRoot': $($_.Exception.Message)"
                    )
                }
            }
        }
    }

    Write-Host "Xiph integration pair passed: $requestedPair"
}

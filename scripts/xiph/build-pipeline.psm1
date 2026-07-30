$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:XiphBuildPipelineModulePath = $PSCommandPath

foreach ($dependencyModuleName in @(
        'source-fetch.psm1'
        'source-patch.psm1'
        'build-matrix.psm1'
        'build-results.psm1'
    )) {
    Import-Module `
        -Name (Join-Path $PSScriptRoot $dependencyModuleName) `
        -Force `
        -Scope Local `
        -ErrorAction Stop
}

function Get-AbsolutePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    return (
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
            $Path
        )
    )
}

function Resolve-RequiredFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    $absolutePath = Get-AbsolutePath -Path $Path

    if (-not [IO.File]::Exists($absolutePath)) {
        throw ('{0} does not exist or is not a file: {1}' -f
            $Description,
            $absolutePath
        )
    }

    return $absolutePath
}

function Resolve-RequiredDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    $absolutePath = Get-AbsolutePath -Path $Path

    if (-not [IO.Directory]::Exists($absolutePath)) {
        throw ('{0} does not exist or is not a directory: {1}' -f
            $Description,
            $absolutePath
        )
    }

    return $absolutePath
}

function Read-JsonFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [ValidateRange(1, 100)]
        [int] $Depth = 30
    )

    try {
        $content = Get-Content `
            -LiteralPath $Path `
            -Raw `
            -ErrorAction Stop

        return $content | ConvertFrom-Json `
            -Depth $Depth `
            -ErrorAction Stop
    }
    catch {
        throw ('Failed to read JSON file "{0}": {1}' -f
            $Path,
            $_.Exception.Message
        )
    }
}

function Assert-RequiredProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $PropertyName,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Context
    )

    if ($null -eq $InputObject) {
        throw ('{0} is null' -f $Context)
    }

    $property = $InputObject.PSObject.Properties[$PropertyName]

    if ($null -eq $property -or $null -eq $property.Value) {
        throw ('{0} is missing required property "{1}"' -f
            $Context,
            $PropertyName
        )
    }
}

function Get-XiphPairKey {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Pair
    )

    return '{0}|{1}' -f $Pair.vorbis_version, $Pair.ogg_version
}

function Assert-XiphPair {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Pair
    )

    if ($null -eq $Pair) {
        throw 'Xiph lock contains a null source pair'
    }

    $requiredProperties = @(
        'vorbis_version'
        'ogg_version'
        'build_revision'
        'sources'
        'builds'
    )

    foreach ($propertyName in $requiredProperties) {
        Assert-RequiredProperty `
            -InputObject $Pair `
            -PropertyName $propertyName `
            -Context 'Xiph source pair'
    }

    $pairKey = Get-XiphPairKey -Pair $Pair
    $pairContext = 'Xiph source pair "{0}"' -f $pairKey

    Assert-RequiredProperty `
        -InputObject $Pair.sources `
        -PropertyName 'ogg' `
        -Context ('{0} sources' -f $pairContext)

    Assert-RequiredProperty `
        -InputObject $Pair.sources `
        -PropertyName 'vorbis' `
        -Context ('{0} sources' -f $pairContext)

    foreach ($build in @($Pair.builds)) {
        Assert-RequiredProperty `
            -InputObject $build `
            -PropertyName 'build_revision' `
            -Context ('Materialized build for {0}' -f $pairContext)
    }
}

function Assert-XiphLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Lock
    )

    Assert-RequiredProperty `
        -InputObject $Lock `
        -PropertyName 'schema_version' `
        -Context 'Xiph lock'

    Assert-RequiredProperty `
        -InputObject $Lock `
        -PropertyName 'pairs' `
        -Context 'Xiph lock'

    if ($Lock.schema_version -ne 1) {
        throw ('Unsupported Xiph lock schema version: {0}' -f
            $Lock.schema_version
        )
    }

    $pairs = @($Lock.pairs)

    if ($pairs.Count -eq 0) {
        throw 'Xiph lock must contain at least one append-only source pair'
    }

    $knownPairKeys = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )

    foreach ($pair in $pairs) {
        Assert-XiphPair -Pair $pair

        $pairKey = Get-XiphPairKey -Pair $pair

        if (-not $knownPairKeys.Add($pairKey)) {
            throw ('Xiph lock contains duplicate source pair: {0}' -f
                $pairKey
            )
        }
    }
}

function Test-XiphPairMaterialized {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Pair
    )

    foreach ($build in @($Pair.builds)) {
        if ($build.build_revision -eq $Pair.build_revision) {
            return $true
        }
    }

    return $false
}

function Select-XiphPair {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object[]] $Pairs,

        [AllowNull()]
        [AllowEmptyString()]
        [string] $RequestedPairKey
    )

    if (-not [string]::IsNullOrWhiteSpace($RequestedPairKey)) {
        $normalizedPairKey = $RequestedPairKey.Trim()

        $matchingPairs = @(
            $Pairs | Where-Object {
                (Get-XiphPairKey -Pair $_) -ceq $normalizedPairKey
            }
        )

        if ($matchingPairs.Count -eq 0) {
            throw ('Unknown Xiph source pair: {0}' -f
                $normalizedPairKey
            )
        }

        if ($matchingPairs.Count -gt 1) {
            throw ('Xiph lock contains duplicate source pair: {0}' -f
                $normalizedPairKey
            )
        }

        return $matchingPairs[0]
    }

    foreach ($candidate in $Pairs) {
        if (-not (Test-XiphPairMaterialized -Pair $candidate)) {
            return $candidate
        }
    }

    throw 'Every Xiph source pair is already materialized'
}

function New-XiphPathSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $ScriptRoot,

        [Parameter(Mandatory)]
        [string] $EntryScriptPath,

        [Parameter(Mandatory)]
        [string] $LockFile,

        [Parameter(Mandatory)]
        [string] $OutputDirectory
    )

    $modules = [pscustomobject] @{
        BuildPipeline = Resolve-RequiredFile `
            -Path $script:XiphBuildPipelineModulePath `
            -Description 'Xiph build pipeline module'

        SourceArchive = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/source-archive.psm1') `
            -Description 'Xiph source archive module'

        SourceFetch   = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/source-fetch.psm1') `
            -Description 'Xiph source fetch module'

        SourcePatch   = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/source-patch.psm1') `
            -Description 'Xiph source patch module'

        BuildMatrix   = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/build-matrix.psm1') `
            -Description 'Xiph build matrix module'

        BuildResults  = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/build-results.psm1') `
            -Description 'Xiph build results module'
    }

    $absoluteOutputDirectory = Get-AbsolutePath -Path $OutputDirectory

    return [pscustomobject] @{
        ScriptRoot          = Get-AbsolutePath -Path $ScriptRoot

        EntryScript         = Resolve-RequiredFile `
            -Path $EntryScriptPath `
            -Description 'Xiph build entry script'

        LockFile            = Resolve-RequiredFile `
            -Path $LockFile `
            -Description 'Xiph lock file'

        OutputDirectory     = $absoluteOutputDirectory

        BuildManifest       = Join-Path `
            $absoluteOutputDirectory `
            'build-manifest.json'

        PolicyFile          = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/verification-policy.json') `
            -Description 'Xiph verification policy'

        WarningBaselineFile = Resolve-RequiredFile `
            -Path (
            Join-Path `
                $ScriptRoot `
                '../catalogs/libraries/xiph-warning-baseline.json'
        ) `
            -Description 'Xiph warning baseline'

        PatchDirectory      = Resolve-RequiredDirectory `
            -Path (Join-Path $ScriptRoot 'xiph/patches') `
            -Description 'Xiph patch descriptor directory'

        Recipe              = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/CMakeLists.txt') `
            -Description 'Xiph CMake recipe'

        VersionResource     = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/version.rc.in') `
            -Description 'Xiph version resource template'

        RoundtripSource     = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'xiph/roundtrip_test.c') `
            -Description 'Xiph round-trip test source'

        PeInspector         = Resolve-RequiredFile `
            -Path (Join-Path $ScriptRoot 'lib/pe-inspector.psm1') `
            -Description 'PE inspector module'

        Modules             = $modules
    }
}

function Get-XiphPatchDescriptorFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Directory
    )

    return @(
        Get-ChildItem `
            -LiteralPath $Directory `
            -Filter '*.json' `
            -File `
            -ErrorAction Stop |
        Sort-Object -Property FullName |
        Select-Object -ExpandProperty FullName
    )
}

function Copy-XiphLicenseFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $OggRoot,

        [Parameter(Mandatory)]
        [string] $VorbisRoot,

        [Parameter(Mandatory)]
        [string] $DestinationDirectory
    )

    $licenseFiles = [ordered] @{
        (Join-Path $OggRoot 'COPYING')    = (
            Join-Path $DestinationDirectory 'COPYING.ogg.txt'
        )
        (Join-Path $VorbisRoot 'COPYING') = (
            Join-Path $DestinationDirectory 'COPYING.vorbis.txt'
        )
    }

    foreach ($entry in $licenseFiles.GetEnumerator()) {
        if (-not [IO.File]::Exists($entry.Key)) {
            throw ('Xiph source license file does not exist: {0}' -f
                $entry.Key
            )
        }

        Copy-Item `
            -LiteralPath $entry.Key `
            -Destination $entry.Value `
            -Force
    }
}

function Invoke-XiphBuildPipeline {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Paths,

        [Parameter(Mandatory)]
        [object] $Pair,

        [Parameter(Mandatory)]
        [bool] $PreserveWorkDirectory
    )

    [void] [IO.Directory]::CreateDirectory($Paths.OutputDirectory)

    # A failed build must never leave an older manifest looking current.
    if ([IO.File]::Exists($Paths.BuildManifest)) {
        [IO.File]::Delete($Paths.BuildManifest)
    }

    $workDirectory = Join-Path $Paths.OutputDirectory (
        '.work-{0}' -f [Guid]::NewGuid().ToString('N')
    )
    $downloadsDirectory = Join-Path $workDirectory 'downloads'
    $sourcesDirectory = Join-Path $workDirectory 'sources'

    try {
        [void] [IO.Directory]::CreateDirectory($downloadsDirectory)
        [void] [IO.Directory]::CreateDirectory($sourcesDirectory)

        $policy = Read-JsonFile -Path $Paths.PolicyFile

        $oggSourceParameters = @{
            Name               = 'ogg'
            Source             = $Pair.sources.ogg
            DownloadsDirectory = $downloadsDirectory
            SourcesDirectory   = $sourcesDirectory
        }
        $oggRoot = Get-XiphSource @oggSourceParameters

        $vorbisSourceParameters = @{
            Name               = 'vorbis'
            Source             = $Pair.sources.vorbis
            DownloadsDirectory = $downloadsDirectory
            SourcesDirectory   = $sourcesDirectory
        }
        $vorbisRoot = Get-XiphSource @vorbisSourceParameters

        $patchDescriptorFiles = @(
            Get-XiphPatchDescriptorFiles `
                -Directory $Paths.PatchDirectory
        )

        $sourcePatchParameters = @{
            OggRoot         = $oggRoot
            VorbisRoot      = $vorbisRoot
            SourcePins      = $Pair.sources
            DescriptorFiles = $patchDescriptorFiles
        }
        $appliedPatches = Invoke-XiphSourcePatches `
            @sourcePatchParameters

        $licenseParameters = @{
            OggRoot              = $oggRoot
            VorbisRoot           = $vorbisRoot
            DestinationDirectory = $Paths.OutputDirectory
        }
        Copy-XiphLicenseFiles @licenseParameters

        $matrixParameters = @{
            ScriptRoot = $Paths.ScriptRoot
            Policy     = $policy
            Pair       = $Pair
            OggRoot    = $oggRoot
            VorbisRoot = $vorbisRoot
            WorkRoot   = $workDirectory
        }
        $matrixResult = Invoke-XiphBuildMatrix @matrixParameters

        $resultParameters = @{
            MatrixResult        = $matrixResult
            Policy              = $policy
            OutputDirectory     = $Paths.OutputDirectory
            WarningBaselineFile = $Paths.WarningBaselineFile
        }
        $buildResults = Complete-XiphBuildResults @resultParameters

        $recipeInputs = @(
            $Paths.EntryScript
            $Paths.Recipe
            $Paths.VersionResource
            $Paths.RoundtripSource
            $Paths.PolicyFile
            $Paths.Modules.BuildPipeline
            $Paths.Modules.SourceArchive
            $Paths.Modules.SourceFetch
            $Paths.Modules.SourcePatch
            $Paths.Modules.BuildMatrix
            $patchDescriptorFiles
        )

        $verificationInputs = @(
            $Paths.EntryScript
            $Paths.PolicyFile
            $Paths.WarningBaselineFile
            $Paths.PeInspector
            $Paths.Modules.BuildResults
        )

        $manifestParameters = @{
            OutputFile         = $Paths.BuildManifest
            HashBasePath       = $Paths.ScriptRoot
            Pair               = $Pair
            RecipeInputs       = $recipeInputs
            VerificationInputs = $verificationInputs
            Toolchain          = $buildResults.toolchain
            Patches            = $appliedPatches
            Artifacts          = @($buildResults.records)
        }
        Write-XiphBuildManifest @manifestParameters
    }
    finally {
        $workDirectoryExists = [IO.Directory]::Exists($workDirectory)

        if ($workDirectoryExists -and $PreserveWorkDirectory) {
            Write-Warning (
                'Preserving Xiph diagnostic artifacts: {0}' -f
                $workDirectory
            )
        }

        if ($workDirectoryExists -and -not $PreserveWorkDirectory) {
            Remove-Item `
                -LiteralPath $workDirectory `
                -Recurse `
                -Force
        }
    }
}

function Invoke-XiphBuildFromLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $ScriptRoot,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $EntryScriptPath,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $LockFile,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $OutputDirectory,

        [AllowNull()]
        [AllowEmptyString()]
        [string] $PairKey,

        [switch] $KeepArtifacts
    )

    $paths = New-XiphPathSet `
        -ScriptRoot $ScriptRoot `
        -EntryScriptPath $EntryScriptPath `
        -LockFile $LockFile `
        -OutputDirectory $OutputDirectory

    $lock = Read-JsonFile -Path $paths.LockFile
    Assert-XiphLock -Lock $lock

    $pair = Select-XiphPair `
        -Pairs @($lock.pairs) `
        -RequestedPairKey $PairKey

    $pipelineParameters = @{
        Paths                 = $paths
        Pair                  = $pair
        PreserveWorkDirectory = $KeepArtifacts.IsPresent
    }
    Invoke-XiphBuildPipeline @pipelineParameters
}

Export-ModuleMember -Function Invoke-XiphBuildFromLock

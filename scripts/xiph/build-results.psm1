Set-StrictMode -Version Latest

$peInspectorModule = Join-Path -Path $PSScriptRoot -ChildPath '../lib/pe-inspector.psm1'
Import-Module -Name $peInspectorModule -Force -ErrorAction Stop

function Get-XiphSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    $hash = Get-FileHash `
        -LiteralPath $Path `
        -Algorithm SHA256 `
        -ErrorAction Stop

    return $hash.Hash.ToLowerInvariant()
}

function Get-XiphCompositeSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $Paths,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $BasePath
    )

    $basePathFull = [System.IO.Path]::GetFullPath($BasePath)
    $separator = [byte[]]::new(1)

    $hasher = [System.Security.Cryptography.IncrementalHash]::CreateHash(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )

    try {
        foreach ($path in $Paths) {
            $resolvedPath = (
                Resolve-Path -LiteralPath $path -ErrorAction Stop
            ).ProviderPath

            $relativePath = [System.IO.Path]::GetRelativePath(
                $basePathFull,
                $resolvedPath
            )

            $normalizedRelativePath = $relativePath.Replace('\', '/')
            $label = [System.Text.Encoding]::UTF8.GetBytes(
                $normalizedRelativePath
            )

            $hasher.AppendData($label)
            $hasher.AppendData($separator)
            $hasher.AppendData(
                [System.IO.File]::ReadAllBytes($resolvedPath)
            )
            $hasher.AppendData($separator)
        }

        $hash = [System.Convert]::ToHexString(
            $hasher.GetHashAndReset()
        )

        return $hash.ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-XiphReleaseBinaryPath {
    param(
        [Parameter(Mandatory)]
        [string] $BuildDirectory,

        [Parameter(Mandatory)]
        [string] $FileName
    )

    $releaseDirectory = Join-Path `
        -Path $BuildDirectory `
        -ChildPath 'Release'

    return Join-Path `
        -Path $releaseDirectory `
        -ChildPath $FileName
}

function Get-XiphKnownImports {
    param(
        [Parameter(Mandatory)]
        [object] $Policy
    )

    return @(
        foreach ($aliasProfile in $Policy.aliases.PSObject.Properties) {
            foreach ($alias in $aliasProfile.Value.PSObject.Properties) {
                $abiMajor = $Policy.abi_majors.PSObject.Properties[
                $alias.Name
                ]

                if ($null -eq $abiMajor) {
                    throw "Xiph policy has no ABI major for '$($alias.Name)'"
                }

                ([string] $alias.Value).Replace(
                    '{abi_major}',
                    [string] $abiMajor.Value
                )
            }
        }
    )
}

function Assert-XiphSecurityPolicy {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary] $Security,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $Requirements
    )

    if ($Requirements.Count -eq 0) {
        throw "required PE security flags are absent: $Path"
    }

    foreach ($requirement in $Requirements) {
        if (-not $Security.Contains($requirement)) {
            throw "unsupported PE security policy requirement: $requirement"
        }

        $value = $Security[$requirement]
        if ($value -isnot [bool]) {
            throw "unsupported PE security policy requirement: $requirement"
        }

        if (-not $value) {
            throw "required PE security flag '$requirement' is absent: $Path"
        }
    }
}

function Assert-XiphImportPolicy {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $RegularImports,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $DelayImports,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $ExpectedRegularXiphImports,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $ExpectedDelayXiphImports,

        [Parameter(Mandatory)]
        [object] $Policy
    )

    $knownXiphImports = Get-XiphKnownImports -Policy $Policy
    $allowedSystemImports = @(
        $Policy.allowed_system_imports
    )
    $allowedSystemPrefixes = @(
        $Policy.allowed_system_import_prefixes
    )

    $importProfiles = @(
        [pscustomobject] @{
            kind     = 'regular'
            actual   = @($RegularImports)
            expected = @($ExpectedRegularXiphImports)
        }
        [pscustomobject] @{
            kind     = 'delay'
            actual   = @($DelayImports)
            expected = @($ExpectedDelayXiphImports)
        }
    )

    foreach ($importProfile in $importProfiles) {
        $actualXiphImports = @(
            $importProfile.actual |
            Where-Object {
                $knownXiphImports -ccontains $_
            } |
            Sort-Object -CaseSensitive -Unique
        )
        $expectedImports = @(
            $importProfile.expected |
            Sort-Object -CaseSensitive -Unique
        )

        if (($actualXiphImports -join "`0") -cne
            ($expectedImports -join "`0")) {
            throw (
                "Xiph $($importProfile.kind) imports differ from the selected topology: " +
                "$Path; expected=[$($expectedImports -join ', ')] " +
                "actual=[$($actualXiphImports -join ', ')]"
            )
        }

        foreach ($import in $importProfile.actual) {
            foreach ($pattern in @($Policy.forbidden_imports)) {
                if ($import -clike [string] $pattern) {
                    throw (
                        "forbidden $($importProfile.kind) PE dependency " +
                        "'$import': $Path"
                    )
                }
            }

            if ($expectedImports -ccontains $import -or
                $allowedSystemImports -ccontains $import) {
                continue
            }

            $prefixAllowed = $false
            foreach ($prefix in $allowedSystemPrefixes) {
                if ($import.StartsWith(
                        [string] $prefix,
                        [StringComparison]::Ordinal
                    )) {
                    $prefixAllowed = $true
                    break
                }
            }

            if (-not $prefixAllowed) {
                throw (
                    "unexpected $($importProfile.kind) PE dependency " +
                    "'$import': $Path"
                )
            }
        }
    }
}

function Assert-XiphBinaryPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Architecture,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $ExpectedRegularXiphImports,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $ExpectedDelayXiphImports,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $ExpectedExports,

        [Parameter(Mandatory)]
        [object] $Policy
    )

    $metadata = Get-PeMetadata -Path $Path

    if ($metadata.architecture -ne $Architecture) {
        throw (
            "PE architecture mismatch for $Path; " +
            "expected=$Architecture " +
            "actual=$($metadata.architecture)"
        )
    }

    $architectureSecurity = $Policy.required_security.PSObject.Properties[
    $Architecture
    ]
    if ($null -eq $architectureSecurity) {
        throw "verification policy has no PE security profile for $Architecture"
    }

    $securityParameters = @{
        Path         = $Path
        Security     = $metadata.pe_security
        Requirements = @(
            @($Policy.required_security.all) +
            @($architectureSecurity.Value)
        )
    }

    Assert-XiphSecurityPolicy @securityParameters

    $importParameters = @{
        Path                       = $Path
        RegularImports             = @($metadata.pe_imports.regular)
        DelayImports               = @($metadata.pe_imports.delay)
        ExpectedRegularXiphImports = $ExpectedRegularXiphImports
        ExpectedDelayXiphImports   = $ExpectedDelayXiphImports
        Policy                     = $Policy
    }

    Assert-XiphImportPolicy @importParameters

    $exportComparisonParameters = @{
        ReferenceObject  = $ExpectedExports
        DifferenceObject = @($metadata.pe_named_exports)
        CaseSensitive    = $true
    }

    $exportDifference = @(
        Compare-Object @exportComparisonParameters
    )

    if ($exportDifference.Count -ne 0) {
        throw (
            "PE export surface differs from the pinned upstream DEF: $Path"
        )
    }

    return $metadata
}

function Assert-XiphWarningBaseline {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable] $ObservedWarnings,

        [Parameter(Mandatory)]
        [string] $WarningBaselineFile
    )

    $baseline = Get-Content `
        -LiteralPath $WarningBaselineFile `
        -Raw `
        -ErrorAction Stop |
    ConvertFrom-Json -Depth 10

    $expectedWarnings = @{}

    foreach ($warning in @($baseline.warnings)) {
        $key = (
            "$($warning.file)|" +
            "$($warning.code)|" +
            "$($warning.message)"
        )

        $expectedWarnings[$key] = [int] $warning.count
    }

    $warningBaselineMatches = (
        $ObservedWarnings.Count -eq $expectedWarnings.Count
    )

    if ($warningBaselineMatches) {
        foreach ($key in $ObservedWarnings.Keys) {
            $missingExpectedWarning = -not $expectedWarnings.ContainsKey($key)

            $differentCount = (
                -not $missingExpectedWarning -and
                $ObservedWarnings[$key] -ne $expectedWarnings[$key]
            )

            if ($missingExpectedWarning -or $differentCount) {
                $warningBaselineMatches = $false
                break
            }
        }
    }

    if ($warningBaselineMatches) {
        return
    }

    $expectedJson = $expectedWarnings |
    ConvertTo-Json -Compress -Depth 10

    $observedJson = $ObservedWarnings |
    ConvertTo-Json -Compress -Depth 10

    throw (
        'Xiph warning baseline changed. ' +
        "Expected: $expectedJson; " +
        "observed: $observedJson"
    )
}

function Get-XiphRunnerIdentity {
    $label = if (
        [string]::IsNullOrWhiteSpace($env:RUNNER_IMAGE_LABEL)
    ) {
        'local-windows'
    }
    else {
        $env:RUNNER_IMAGE_LABEL
    }

    $version = if (
        [string]::IsNullOrWhiteSpace($env:ImageVersion)
    ) {
        [System.Environment]::OSVersion.Version.ToString()
    }
    else {
        $env:ImageVersion
    }

    return "$label@$version"
}

function Get-XiphVerifiedBinary {
    param(
        [Parameter(Mandatory)]
        [object] $Variant,

        [Parameter(Mandatory)]
        [string] $FileName
    )

    $builds = @($Variant.builds)

    if ($builds.Count -eq 0) {
        $variantName = @(
            $Variant.architecture
            $Variant.topology
            $Variant.profile
            $FileName
        ) -join '/'

        throw "build variant has no build directories: $variantName"
    }

    $referencePathParameters = @{
        BuildDirectory = $builds[0]
        FileName       = $FileName
    }

    $referencePath = Get-XiphReleaseBinaryPath `
        @referencePathParameters

    $referenceSha256 = Get-XiphSha256 -Path $referencePath

    foreach ($buildDirectory in (
            $builds | Select-Object -Skip 1
        )) {
        $comparisonPathParameters = @{
            BuildDirectory = $buildDirectory
            FileName       = $FileName
        }

        $comparisonPath = Get-XiphReleaseBinaryPath `
            @comparisonPathParameters

        $comparisonSha256 = Get-XiphSha256 `
            -Path $comparisonPath

        if ($referenceSha256 -cne $comparisonSha256) {
            $variantName = @(
                $Variant.architecture
                $Variant.topology
                $Variant.profile
                $FileName
            ) -join '/'

            throw "non-reproducible raw DLL: $variantName"
        }
    }

    return [pscustomobject] @{
        path   = $referencePath
        sha256 = $referenceSha256
    }
}

function Copy-XiphBuildArtifact {
    param(
        [Parameter(Mandatory)]
        [object] $Variant,

        [Parameter(Mandatory)]
        [object] $Member,

        [Parameter(Mandatory)]
        [object] $Policy,

        [Parameter(Mandatory)]
        [string] $OutputDirectory
    )

    $binary = Get-XiphVerifiedBinary `
        -Variant $Variant `
        -FileName $Member.name

    $policyParameters = @{
        Path                       = $binary.path
        Architecture               = $Variant.architecture
        ExpectedRegularXiphImports = @($Member.pe_imports.regular)
        ExpectedDelayXiphImports   = @($Member.pe_imports.delay)
        ExpectedExports            = @($Member.exports)
        Policy                     = $Policy
    }

    $metadata = Assert-XiphBinaryPolicy @policyParameters

    if ($metadata.pe_version -ne $Member.expected_pe_version) {
        throw (
            'PE FileVersion does not match ' +
            "$($Member.expected_pe_version): " +
            $binary.path
        )
    }

    $destination = $OutputDirectory

    foreach ($segment in @(
            $Variant.architecture
            $Variant.topology
            $Variant.profile
            $Member.name
        )) {
        $destination = Join-Path `
            -Path $destination `
            -ChildPath ([string] $segment)
    }

    $destinationDirectory = [System.IO.Path]::GetDirectoryName(
        $destination
    )

    $directoryParameters = @{
        ItemType    = 'Directory'
        Path        = $destinationDirectory
        Force       = $true
        ErrorAction = 'Stop'
    }

    New-Item @directoryParameters | Out-Null

    $copyParameters = @{
        LiteralPath = $binary.path
        Destination = $destination
        Force       = $true
        ErrorAction = 'Stop'
    }

    Copy-Item @copyParameters

    $destinationSha256 = Get-XiphSha256 -Path $destination
    if ($destinationSha256 -cne $binary.sha256) {
        [IO.File]::Delete($destination)
        throw "copied Xiph DLL failed SHA-256 verification: $destination"
    }

    $destinationItem = Get-Item `
        -LiteralPath $destination `
        -ErrorAction Stop

    return [ordered] @{
        architecture     = $Variant.architecture
        topology         = $Variant.topology
        profile          = $Variant.profile
        component        = $Member.component
        file_name        = $Member.name
        path             = $destination
        sha256           = $destinationSha256
        size_bytes       = $destinationItem.Length
        pe_version       = $metadata.pe_version
        pe_named_exports = @($metadata.pe_named_exports)
        pe_imports       = $metadata.pe_imports
    }
}

function Get-XiphCommandVersion {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [string[]] $ArgumentList = @()
    )

    $output = @(
        & $Path @ArgumentList 2>&1
    )
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        throw "tool version query failed with exit code $exitCode`: $Path"
    }

    $version = (
        $output |
        Select-Object -First 1
    ) -join ''

    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "tool version query returned no output: $Path"
    }

    return $version.Trim()
}

function Get-XiphWindowsFileVersion {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $item = Get-Item `
        -LiteralPath $Path `
        -ErrorAction Stop

    $versionText = $item.VersionInfo.FileVersion
    [version] $version = $null

    if ([string]::IsNullOrWhiteSpace($versionText) -or
        -not [version]::TryParse($versionText, [ref] $version)) {
        throw "tool has no valid Windows file version: $Path"
    }

    return $version.ToString()
}

function Get-XiphToolchain {
    param(
        [Parameter(Mandatory)]
        [object] $MatrixResult
    )

    $selectedWindowsSdks = @(
        $MatrixResult.selected_windows_sdks
    )

    if ($selectedWindowsSdks.Count -ne 1) {
        throw (
            'CMake selected inconsistent Windows SDKs: ' +
            ($selectedWindowsSdks -join ', ')
        )
    }

    $cmakeParameters = @{
        Path         = $MatrixResult.tools.cmake
        ArgumentList = '--version'
    }

    $cmakeVersion = Get-XiphCommandVersion @cmakeParameters
    $compilerVersion = Get-XiphWindowsFileVersion `
        -Path $MatrixResult.tools.compiler
    $linkerVersion = Get-XiphWindowsFileVersion `
        -Path $MatrixResult.tools.linker

    return [ordered] @{
        runner_image = Get-XiphRunnerIdentity
        compiler     = "MSVC $compilerVersion"
        linker       = "LINK $linkerVersion"
        windows_sdk  = $selectedWindowsSdks[0]
        cmake        = $cmakeVersion
    }
}

function Complete-XiphBuildResults {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $MatrixResult,

        [Parameter(Mandatory)]
        [object] $Policy,

        [Parameter(Mandatory)]
        [string] $OutputDirectory,

        [Parameter(Mandatory)]
        [string] $WarningBaselineFile
    )

    $records = [System.Collections.Generic.List[object]]::new()

    foreach ($variant in $MatrixResult.variants) {
        foreach ($member in $variant.members) {
            $artifactParameters = @{
                Variant         = $variant
                Member          = $member
                Policy          = $Policy
                OutputDirectory = $OutputDirectory
            }

            $record = Copy-XiphBuildArtifact `
                @artifactParameters

            $records.Add($record)
        }
    }

    $warningParameters = @{
        ObservedWarnings    = $MatrixResult.observed_warnings
        WarningBaselineFile = $WarningBaselineFile
    }

    Assert-XiphWarningBaseline @warningParameters

    return [pscustomobject] @{
        records   = $records.ToArray()
        toolchain = Get-XiphToolchain `
            -MatrixResult $MatrixResult
    }
}

function Write-XiphBuildManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $OutputFile,

        [Parameter(Mandatory)]
        [string] $HashBasePath,

        [Parameter(Mandatory)]
        [object] $Pair,

        [Parameter(Mandatory)]
        [string[]] $RecipeInputs,

        [Parameter(Mandatory)]
        [string[]] $VerificationInputs,

        [Parameter(Mandatory)]
        [object] $Toolchain,

        [Parameter(Mandatory)]
        [object] $Patches,

        [Parameter(Mandatory)]
        [object[]] $Artifacts
    )

    $recipeHashParameters = @{
        Paths    = $RecipeInputs
        BasePath = $HashBasePath
    }

    $recipeSha256 = Get-XiphCompositeSha256 `
        @recipeHashParameters

    $verificationHashParameters = @{
        Paths    = $VerificationInputs
        BasePath = $HashBasePath
    }

    $verificationPolicySha256 = Get-XiphCompositeSha256 `
        @verificationHashParameters

    $manifest = [ordered] @{
        schema_version             = 1
        pair                       = $Pair
        recipe_sha256              = $recipeSha256
        verification_policy_sha256 = $verificationPolicySha256
        toolchain                  = $Toolchain
        patches                    = $Patches
        artifacts                  = $Artifacts
    }

    $resolvedOutputFile = [IO.Path]::GetFullPath($OutputFile)
    $outputParent = [IO.Path]::GetDirectoryName($resolvedOutputFile)

    if ([string]::IsNullOrWhiteSpace($outputParent) -or
        -not [IO.Directory]::Exists($outputParent)) {
        throw "build manifest parent directory does not exist: $resolvedOutputFile"
    }

    $temporaryFile = Join-Path $outputParent (
        '.{0}.tmp-{1}' -f
        [IO.Path]::GetFileName($resolvedOutputFile),
        [Guid]::NewGuid().ToString('N')
    )

    $json = $manifest | ConvertTo-Json -Depth 30
    $utf8NoBom = [Text.UTF8Encoding]::new($false)

    try {
        [IO.File]::WriteAllText(
            $temporaryFile,
            $json + "`n",
            $utf8NoBom
        )
        [IO.File]::Move(
            $temporaryFile,
            $resolvedOutputFile,
            $true
        )
    }
    finally {
        if ([IO.File]::Exists($temporaryFile)) {
            [IO.File]::Delete($temporaryFile)
        }
    }
}

Export-ModuleMember -Function @(
    'Complete-XiphBuildResults'
    'Write-XiphBuildManifest'
)

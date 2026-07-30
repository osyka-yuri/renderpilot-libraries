Set-StrictMode -Version Latest

$script:XiphVisualStudioGenerator = 'Visual Studio 18 2026'
$script:XiphWarningPattern = [regex]::new(
    '^(.*?)(?:\(\d+(?:,\d+)?\))?\s*:\s*warning\s+([A-Z]+\d+)\s*:\s*(.*?)\s*(?:\[[^\]]+\])?$',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
)

function Get-XiphApplicationPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name
    )

    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1

    if ($null -eq $command) {
        return $null
    }

    if (-not [string]::IsNullOrWhiteSpace($command.Path)) {
        return $command.Path
    }

    return $command.Source
}

function Get-XiphVisualStudioInstallation {
    [CmdletBinding()]
    param(
        [string[]] $RequiredComponents = @()
    )

    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
        throw 'ProgramFiles(x86) is unavailable; cannot locate Visual Studio'
    }

    $vswherePath = Join-Path $programFilesX86 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
        throw "Visual Studio locator is unavailable: $vswherePath"
    }

    $arguments = @(
        '-latest'
        '-products'
        '*'
        '-version'
        '[18.0,19.0)'
    )
    if ($RequiredComponents.Count -gt 0) {
        $arguments += '-requires'
        $arguments += $RequiredComponents
    }
    $arguments += @('-property', 'installationPath')

    $output = @(& $vswherePath @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { [string] $_ }) -join [Environment]::NewLine
        throw "vswhere failed with exit code ${exitCode}:`n$details"
    }

    $installationPath = $output |
    ForEach-Object { ([string] $_).Trim() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($installationPath) -or
        -not (Test-Path -LiteralPath $installationPath -PathType Container)) {
        throw 'No suitable Visual Studio installation was found'
    }

    return $installationPath
}

function Resolve-XiphBuildTools {
    [CmdletBinding()]
    param()

    $installationPath = Get-XiphVisualStudioInstallation -RequiredComponents @(
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
    )
    $toolsRoot = Join-Path $installationPath 'VC/Tools/MSVC'
    if (-not (Test-Path -LiteralPath $toolsRoot -PathType Container)) {
        throw "MSVC tools directory is unavailable: $toolsRoot"
    }

    $toolset = Get-ChildItem -LiteralPath $toolsRoot -Directory |
    Sort-Object -Property @{ Expression = { [version] $_.Name }; Descending = $true } |
    Select-Object -First 1
    if ($null -eq $toolset) {
        throw "No MSVC toolset was found below: $toolsRoot"
    }

    $visualStudioNames = [ordered]@{
        compiler = 'cl'
        linker   = 'link'
    }
    $resolved = [ordered]@{}

    foreach ($entry in $visualStudioNames.GetEnumerator()) {
        $executableName = '{0}.exe' -f $entry.Value
        $path = Join-Path $toolset.FullName "bin/Hostx64/x64/$executableName"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "MSVC tool is unavailable: $path"
        }
        $resolved[$entry.Key] = $path
    }

    $pathCmake = Get-XiphApplicationPath -Name 'cmake'
    $pathCtest = Get-XiphApplicationPath -Name 'ctest'
    $pathToolsAreComplete = (
        -not [string]::IsNullOrWhiteSpace($pathCmake) -and
        -not [string]::IsNullOrWhiteSpace($pathCtest)
    )
    $pathToolsShareDirectory = (
        $pathToolsAreComplete -and
        [StringComparer]::OrdinalIgnoreCase.Equals(
            [IO.Path]::GetDirectoryName($pathCmake),
            [IO.Path]::GetDirectoryName($pathCtest)
        )
    )

    if ($pathToolsShareDirectory) {
        $resolved['cmake'] = $pathCmake
        $resolved['ctest'] = $pathCtest
    }
    else {
        $cmakeBin = Join-Path $installationPath `
            'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin'

        foreach ($entry in ([ordered] @{
                    cmake = 'cmake.exe'
                    ctest = 'ctest.exe'
                }).GetEnumerator()) {
            $executableName = [string] $entry.Value
            $path = Join-Path $cmakeBin $executableName
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "Visual Studio CMake tool is unavailable: $path"
            }
            $resolved[$entry.Key] = $path
        }
    }

    return [pscustomobject]@{
        compiler = $resolved['compiler']
        linker   = $resolved['linker']
        cmake    = $resolved['cmake']
        ctest    = $resolved['ctest']
    }
}

function Invoke-XiphNativeCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $Arguments,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $FailureMessage
    )

    $output = @(& $Path @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $output | Write-Host

    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit code $exitCode)"
    }

    return $output
}

function ConvertTo-XiphVersionTriple {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Version
    )

    $parts = @($Version.Split('.'))
    $invalidPart = $parts |
    Where-Object { $_ -notmatch '^(?:0|[1-9]\d*)$' } |
    Select-Object -First 1

    if ($parts.Count -lt 2 -or $parts.Count -gt 3 -or $null -ne $invalidPart) {
        throw "invalid stable Xiph version $Version"
    }

    if ($parts.Count -eq 2) {
        $parts += '0'
    }

    return $parts -join '.'
}

function Get-XiphCMakeRecordedWindowsSdk {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $BuildDirectory
    )

    $recordPath = Join-Path $BuildDirectory 'renderpilot-windows-sdk.txt'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        throw "CMake did not record its selected Windows SDK: $recordPath"
    }

    $version = (Get-Content -LiteralPath $recordPath -Raw).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw "CMake recorded an invalid Windows SDK version: $version"
    }

    return $version
}

function Get-XiphDefExports {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    $insideExports = $false
    $exports = [Collections.Generic.List[string]]::new()

    foreach ($line in Get-Content -LiteralPath $Path) {
        $text = (($line -split ';', 2)[0]).Trim()
        if (-not $insideExports) {
            if ($text -match '^EXPORTS(?:\s|$)') {
                $insideExports = $true
            }
            continue
        }

        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        $name = ($text -split '\s+', 2)[0]
        $name = ($name -split '=', 2)[0]
        $exports.Add($name)
    }

    if ($exports.Count -eq 0) {
        throw "DEF file contains no exports: $Path"
    }

    return @($exports | Sort-Object -CaseSensitive -Unique)
}

function Get-XiphLibtoolAbiMajor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Root,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $CurrentVariable,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $AgeVariable
    )

    $configurationPath = @(
        (Join-Path $Root 'configure.ac')
        (Join-Path $Root 'configure.in')
    ) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($configurationPath)) {
        throw "source tree has no configure.ac/configure.in for ABI derivation: $Root"
    }

    $text = Get-Content -LiteralPath $configurationPath -Raw
    $currentPattern = '(?m)^\s*{0}\s*=\s*(\d+)\s*$' -f [regex]::Escape($CurrentVariable)
    $agePattern = '(?m)^\s*{0}\s*=\s*(\d+)\s*$' -f [regex]::Escape($AgeVariable)
    $currentMatch = [regex]::Match($text, $currentPattern)
    $ageMatch = [regex]::Match($text, $agePattern)

    if (-not $currentMatch.Success) {
        throw "missing libtool variable $CurrentVariable in $configurationPath"
    }
    if (-not $ageMatch.Success) {
        throw "missing libtool variable $AgeVariable in $configurationPath"
    }

    $current = [int] $currentMatch.Groups[1].Value
    $age = [int] $ageMatch.Groups[1].Value
    if ($age -gt $current) {
        throw "invalid libtool ABI tuple $CurrentVariable=$current $AgeVariable=$age"
    }

    return $current - $age
}

function Get-XiphMatrixConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Policy
    )

    $configuration = [pscustomobject]@{
        architectures = @($Policy.matrix.architectures)
        profiles      = @($Policy.matrix.profiles)
        topologies    = @($Policy.matrix.topologies.PSObject.Properties.Name)
        build_count   = [int] $Policy.reproducibility.build_count
        comparison    = [string] $Policy.reproducibility.comparison
    }

    if ($configuration.architectures.Count -eq 0 -or
        $configuration.profiles.Count -eq 0 -or
        $configuration.topologies.Count -eq 0 -or
        $configuration.build_count -lt 2 -or
        $configuration.comparison -cne 'raw_sha256') {
        throw 'verification-policy contains an unsupported or empty build matrix'
    }

    return $configuration
}

function Resolve-XiphProfileNames {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Policy,

        [Parameter(Mandatory)]
        [string] $BuildProfile,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary] $AbiMajors
    )

    $profileProperty = $Policy.aliases.PSObject.Properties[$BuildProfile]
    if ($null -eq $profileProperty) {
        throw "verification-policy has no aliases for profile: $BuildProfile"
    }

    $names = [ordered]@{}
    foreach ($alias in $profileProperty.Value.PSObject.Properties) {
        $name = [string] $alias.Value
        if ($name.Contains('{abi_major}')) {
            if (-not $AbiMajors.Contains($alias.Name)) {
                throw "alias $($alias.Name) references an unknown ABI major"
            }
            $name = $name.Replace('{abi_major}', [string] $AbiMajors[$alias.Name])
        }
        $names[$alias.Name] = $name
    }

    foreach ($component in @('ogg', 'vorbis', 'vorbisfile', 'vorbisenc')) {
        if (-not $names.Contains($component) -or
            [string]::IsNullOrWhiteSpace([string] $names[$component])) {
            throw "profile $BuildProfile has no usable alias for component: $component"
        }
    }

    return $names
}

function Add-XiphObservedWarnings {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object[]] $BuildOutput,

        [Parameter(Mandatory)]
        [object] $Context
    )

    foreach ($line in $BuildOutput) {
        $match = $script:XiphWarningPattern.Match([string] $line)
        if (-not $match.Success) {
            continue
        }

        $path = $match.Groups[1].Value.Trim()
        $path = $path -ireplace [regex]::Escape($Context.ogg_root), '<ogg>'
        $path = $path -ireplace [regex]::Escape($Context.vorbis_root), '<vorbis>'
        $path = $path -ireplace [regex]::Escape($Context.work_root), '<build>'
        $path = $path.Replace('\', '/')

        $code = $match.Groups[2].Value
        $message = ($match.Groups[3].Value -replace '\s+', ' ').Trim()
        $key = "$path|$code|$message"

        if ($Context.observed_warnings.ContainsKey($key)) {
            $Context.observed_warnings[$key] = [int] $Context.observed_warnings[$key] + 1
        }
        else {
            $Context.observed_warnings[$key] = 1
        }
    }
}

function New-XiphVariantMembers {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Context,

        [Parameter(Mandatory)]
        [string] $Topology,

        [Parameter(Mandatory)]
        [string[]] $Components,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary] $Names
    )

    $topologyImports = $Context.policy.imports.PSObject.Properties[$Topology]
    if ($null -eq $topologyImports) {
        throw "verification-policy has no import policy for topology: $Topology"
    }

    return @(
        foreach ($component in $Components) {
            if (-not $Names.Contains($component) -or
                -not $Context.exports.Contains($component)) {
                throw "topology $Topology references an unknown component: $component"
            }

            $componentImports = $topologyImports.Value.PSObject.Properties[$component]
            if ($null -eq $componentImports) {
                throw "verification-policy has no import policy for $Topology/$component"
            }

            $importKinds = @($componentImports.Value.PSObject.Properties.Name)
            $expectedImportKinds = @('delay', 'regular')
            $unexpectedImportKinds = @(
                Compare-Object `
                    -ReferenceObject $expectedImportKinds `
                    -DifferenceObject $importKinds `
                    -CaseSensitive
            )
            if ($unexpectedImportKinds.Count -ne 0) {
                throw (
                    "verification-policy import profile for $Topology/$component " +
                    'must contain exactly regular and delay'
                )
            }

            $resolvedImports = [ordered] @{}
            foreach ($importKind in @('regular', 'delay')) {
                $resolvedImports[$importKind] = @(
                    foreach ($dependency in @($componentImports.Value.$importKind)) {
                        if (-not $Names.Contains([string] $dependency)) {
                            throw (
                                "component $component has an unknown $importKind " +
                                "import alias: $dependency"
                            )
                        }
                        $Names[[string] $dependency]
                    }
                )
            }

            $sourceVersion = if ($component -eq 'ogg') {
                $Context.ogg_version
            }
            else {
                $Context.vorbis_version
            }

            [pscustomobject]@{
                component           = $component
                name                = $Names[$component]
                pe_imports          = [pscustomobject] $resolvedImports
                exports             = $Context.exports[$component]
                expected_pe_version = "$sourceVersion.0"
            }
        }
    )
}

function Invoke-XiphBuildVariant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Context,

        [Parameter(Mandatory)]
        [string] $Architecture,

        [Parameter(Mandatory)]
        [string] $Topology,

        [Parameter(Mandatory)]
        [string] $BuildProfile
    )

    $generatorArchitecture = switch ($Architecture) {
        'X86' { 'Win32' }
        'X64' { 'x64' }
        default { throw "unsupported Xiph build architecture: $Architecture" }
    }

    $topologyProperty = $Context.policy.matrix.topologies.PSObject.Properties[$Topology]
    if ($null -eq $topologyProperty) {
        throw "verification-policy has no topology: $Topology"
    }

    $components = @($topologyProperty.Value)
    if ($components.Count -eq 0) {
        throw "Xiph topology has no components: $Topology"
    }

    $names = Resolve-XiphProfileNames `
        -Policy $Context.policy `
        -BuildProfile $BuildProfile `
        -AbiMajors $Context.abi_majors
    $buildDirectories = @(
        foreach ($buildIndex in 1..$Context.build_count) {
            Join-Path $Context.work_root "build-$buildIndex-$Architecture-$Topology-$BuildProfile"
        }
    )
    $embedOgg = if ($components -contains 'ogg') { 'OFF' } else { 'ON' }
    $outputNames = [ordered]@{}
    foreach ($component in @('ogg', 'vorbis', 'vorbisfile', 'vorbisenc')) {
        $outputNames[$component] = [IO.Path]::GetFileNameWithoutExtension(
            [string] $names[$component]
        )
    }

    for (
        $reproductionIndex = 0;
        $reproductionIndex -lt $buildDirectories.Count;
        $reproductionIndex++
    ) {
        $buildDirectory = $buildDirectories[$reproductionIndex]
        $progressMessage = 'Xiph configuration {0}/{1}/{2}, reproducibility build {3}/{4}' -f @(
            $Architecture
            $Topology
            $BuildProfile
            ($reproductionIndex + 1)
            $buildDirectories.Count
        )
        Write-Host $progressMessage
        $configureArguments = @(
            '-S', (Join-Path $Context.script_root 'xiph')
            '-B', $buildDirectory
            '-G', $script:XiphVisualStudioGenerator
            '-A', $generatorArchitecture
            "-DOGG_ROOT=$($Context.ogg_root)"
            "-DVORBIS_ROOT=$($Context.vorbis_root)"
            "-DOGG_VERSION=$($Context.ogg_version)"
            "-DVORBIS_VERSION=$($Context.vorbis_version)"
            "-DOGG_OUTPUT=$($outputNames['ogg'])"
            "-DVORBIS_OUTPUT=$($outputNames['vorbis'])"
            "-DVORBISFILE_OUTPUT=$($outputNames['vorbisfile'])"
            "-DVORBISENC_OUTPUT=$($outputNames['vorbisenc'])"
            "-DXIPH_EMBED_OGG=$embedOgg"
            '-DBUILD_TESTING=ON'
        )

        $null = Invoke-XiphNativeCommand `
            -Path $Context.tools.cmake `
            -Arguments $configureArguments `
            -FailureMessage 'CMake configure failed'

        $selectedSdk = Get-XiphCMakeRecordedWindowsSdk -BuildDirectory $buildDirectory
        $null = $Context.selected_windows_sdks.Add($selectedSdk)

        $buildOutput = @(
            Invoke-XiphNativeCommand `
                -Path $Context.tools.cmake `
                -Arguments @(
                '--build', $buildDirectory,
                '--config', 'Release',
                '--parallel'
            ) `
                -FailureMessage 'CMake build failed'
        )
        Add-XiphObservedWarnings -BuildOutput $buildOutput -Context $Context

        if ($reproductionIndex -eq 0) {
            # The second build exists only to prove that the deliverable DLLs
            # are byte-identical in another absolute directory. Running the
            # functional suite on the reference build is sufficient because
            # Complete-XiphBuildResults rejects every differing DLL SHA-256.
            $null = Invoke-XiphNativeCommand `
                -Path $Context.tools.ctest `
                -Arguments @(
                '--test-dir', $buildDirectory,
                '-C', 'Release',
                '--output-on-failure'
            ) `
                -FailureMessage 'Xiph encode/decode roundtrip failed'
        }
    }

    $members = @(New-XiphVariantMembers `
            -Context $Context `
            -Topology $Topology `
            -Components $components `
            -Names $names)

    return [pscustomobject]@{
        architecture = $Architecture
        topology     = $Topology
        profile      = $BuildProfile
        builds       = $buildDirectories
        members      = $members
    }
}

function Invoke-XiphBuildMatrix {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $ScriptRoot,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Policy,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Pair,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $OggRoot,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $VorbisRoot,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $WorkRoot
    )

    $matrix = Get-XiphMatrixConfiguration -Policy $Policy
    $exports = [ordered]@{
        ogg        = Get-XiphDefExports (Join-Path $OggRoot 'win32/ogg.def')
        vorbis     = Get-XiphDefExports (Join-Path $VorbisRoot 'win32/vorbis.def')
        vorbisfile = Get-XiphDefExports (Join-Path $VorbisRoot 'win32/vorbisfile.def')
        vorbisenc  = Get-XiphDefExports (Join-Path $VorbisRoot 'win32/vorbisenc.def')
    }
    $abiMajors = [ordered]@{
        ogg        = Get-XiphLibtoolAbiMajor $OggRoot 'LIB_CURRENT' 'LIB_AGE'
        vorbis     = Get-XiphLibtoolAbiMajor $VorbisRoot 'V_LIB_CURRENT' 'V_LIB_AGE'
        vorbisfile = Get-XiphLibtoolAbiMajor $VorbisRoot 'VF_LIB_CURRENT' 'VF_LIB_AGE'
        vorbisenc  = Get-XiphLibtoolAbiMajor $VorbisRoot 'VE_LIB_CURRENT' 'VE_LIB_AGE'
    }

    foreach ($entry in $abiMajors.GetEnumerator()) {
        $reviewedProperty = $Policy.abi_majors.PSObject.Properties[[string] $entry.Key]
        if ($null -eq $reviewedProperty) {
            throw "verification-policy has no reviewed ABI major for $($entry.Key)"
        }
        if ([int] $reviewedProperty.Value -ne [int] $entry.Value) {
            throw "reviewed $($entry.Key) ABI major differs from upstream: $($entry.Value)"
        }
    }

    $context = [pscustomobject]@{
        script_root           = $ScriptRoot
        policy                = $Policy
        tools                 = Resolve-XiphBuildTools
        exports               = $exports
        abi_majors            = $abiMajors
        ogg_root              = $OggRoot
        vorbis_root           = $VorbisRoot
        work_root             = $WorkRoot
        ogg_version           = ConvertTo-XiphVersionTriple ([string] $Pair.ogg_version)
        vorbis_version        = ConvertTo-XiphVersionTriple ([string] $Pair.vorbis_version)
        build_count           = $matrix.build_count
        observed_warnings     = @{}
        selected_windows_sdks = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
    }
    $variants = [Collections.Generic.List[object]]::new()

    foreach ($architecture in $matrix.architectures) {
        foreach ($topology in $matrix.topologies) {
            foreach ($buildProfile in $matrix.profiles) {
                $variant = Invoke-XiphBuildVariant `
                    -Context $context `
                    -Architecture ([string] $architecture) `
                    -Topology ([string] $topology) `
                    -BuildProfile ([string] $buildProfile)
                $variants.Add($variant)
            }
        }
    }

    return [pscustomobject]@{
        variants              = @($variants)
        observed_warnings     = $context.observed_warnings
        selected_windows_sdks = @(
            $context.selected_windows_sdks | Sort-Object -CaseSensitive
        )
        tools                 = [pscustomobject]@{
            compiler = $context.tools.compiler
            linker   = $context.tools.linker
            cmake    = $context.tools.cmake
        }
    }
}

Export-ModuleMember -Function Invoke-XiphBuildMatrix

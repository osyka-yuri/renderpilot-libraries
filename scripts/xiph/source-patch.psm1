Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:XiphUtf8NoBom = [Text.UTF8Encoding]::new($false)
$script:XiphStrictUtf8 = [Text.UTF8Encoding]::new($false, $true)

$script:XiphRepositoryPattern = '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
$script:XiphCommitShaPattern = '^[0-9a-f]{40}$'
$script:XiphSha256Pattern = '^[0-9a-f]{64}$'
$script:XiphPatchIdPattern = '^[a-z0-9][a-z0-9._-]*$'


function Get-XiphObjectProperty {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Context,

        [switch] $Required
    )

    if ($null -eq $InputObject) {
        throw "invalid object in ${Context}"
    }

    $property = $InputObject.PSObject.Properties[$Name]

    if ($null -eq $property) {
        if ($Required) {
            throw "missing '$Name' in ${Context}"
        }

        return $null
    }

    # PSObject property lookup is case-insensitive. Require the descriptor
    # to use the canonical field spelling.
    if ($property.Name -cne $Name) {
        throw "invalid property name '$($property.Name)' in ${Context}; expected '$Name'"
    }

    return $property
}


function Get-XiphStringPropertyValue {
    param(
        [Parameter(Mandatory)]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Context,

        [switch] $AllowEmpty
    )

    $property = Get-XiphObjectProperty `
        -InputObject $InputObject `
        -Name $Name `
        -Context $Context `
        -Required

    if ($property.Value -isnot [string]) {
        throw "'$Name' must be a string in ${Context}"
    }

    $value = [string] $property.Value

    if (-not $AllowEmpty -and $value.Length -eq 0) {
        throw "'$Name' must not be empty in ${Context}"
    }

    return $value
}


function Test-XiphExactPropertySet {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [string[]] $ExpectedNames
    )

    if ($null -eq $InputObject) {
        return $false
    }

    $actualNames = @($InputObject.PSObject.Properties.Name)

    if ($actualNames.Count -ne $ExpectedNames.Count) {
        return $false
    }

    foreach ($expectedName in $ExpectedNames) {
        if (-not ($actualNames -ccontains $expectedName)) {
            return $false
        }
    }

    return $true
}

function Assert-XiphKnownPropertySet {
    param(
        [Parameter(Mandatory)]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [string[]] $AllowedNames,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Context
    )

    foreach ($actualName in @($InputObject.PSObject.Properties.Name)) {
        if (-not ($AllowedNames -ccontains $actualName)) {
            throw "unknown property '$actualName' in ${Context}"
        }
    }
}


function Get-XiphBytesSha256 {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [byte[]] $Bytes
    )

    return [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($Bytes)
    ).ToLowerInvariant()
}


function Get-XiphFileSha256 {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}


function Get-XiphTextSha256 {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content
    )

    return Get-XiphBytesSha256 -Bytes $script:XiphUtf8NoBom.GetBytes($Content)
}


function Read-XiphPatchTarget {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    # Read the file only once so the decoded content and original hash
    # necessarily describe the same byte sequence.
    $bytes = [IO.File]::ReadAllBytes($Path)
    $stream = [IO.MemoryStream]::new($bytes, $false)
    $reader = [IO.StreamReader]::new(
        $stream,
        $script:XiphStrictUtf8,
        $false
    )

    try {
        $content = $reader.ReadToEnd()
    }
    catch [Text.DecoderFallbackException] {
        throw [IO.InvalidDataException]::new(
            "Xiph source patch target is not valid UTF-8: $Path",
            $_.Exception
        )
    }
    finally {
        $reader.Dispose()
    }

    return [pscustomobject]@{
        Content = $content
        Sha256  = Get-XiphBytesSha256 -Bytes $bytes
    }
}


function ConvertTo-XiphMarkerArray {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Value,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $PropertyName,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Context
    )

    if ($null -eq $Value) {
        throw "'$PropertyName' must be an array of non-empty strings in ${Context}"
    }

    if ($Value -isnot [Collections.IList] -or $Value -is [string]) {
        throw "'$PropertyName' must be an array of non-empty strings in ${Context}"
    }

    $seenMarkers = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )

    foreach ($item in @($Value)) {
        if ($item -isnot [string] -or [string]::IsNullOrEmpty([string] $item)) {
            throw "'$PropertyName' must contain only non-empty strings in ${Context}"
        }

        if (-not $seenMarkers.Add([string] $item)) {
            throw "'$PropertyName' must not contain duplicate strings in ${Context}"
        }

        [string] $item
    }
}


function ConvertTo-XiphPatchTarget {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Target,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DescriptorFile
    )

    if ([string]::IsNullOrWhiteSpace($Target)) {
        throw "empty Xiph source patch target: $DescriptorFile"
    }

    $normalizedTarget = $Target.Replace('\', '/')

    if ($normalizedTarget.StartsWith('/', [StringComparison]::Ordinal) -or
        $normalizedTarget.Contains(':')) {
        throw "unsafe Xiph source patch target: $normalizedTarget"
    }

    foreach ($segment in $normalizedTarget.Split('/')) {
        if ([string]::IsNullOrEmpty($segment) -or
            $segment -ceq '.' -or
            $segment -ceq '..') {
            throw "unsafe Xiph source patch target: $normalizedTarget"
        }
    }

    return $normalizedTarget
}


function Resolve-XiphPatchTargetPath {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Root,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $RelativeTarget
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root)
    $resolvedTarget = [IO.Path]::GetFullPath(
        (Join-Path $resolvedRoot $RelativeTarget)
    )

    $pathComparison = if ([OperatingSystem]::IsWindows()) {
        [StringComparison]::OrdinalIgnoreCase
    }
    else {
        [StringComparison]::Ordinal
    }

    $directorySeparators = [char[]] @(
        [IO.Path]::DirectorySeparatorChar
        [IO.Path]::AltDirectorySeparatorChar
    )

    $rootPrefix =
    $resolvedRoot.TrimEnd($directorySeparators) +
    [IO.Path]::DirectorySeparatorChar

    if (-not $resolvedTarget.StartsWith($rootPrefix, $pathComparison)) {
        throw "Xiph source patch target escapes its source root: $RelativeTarget"
    }

    return $resolvedTarget
}


function Get-XiphPatchSourcePin {
    param(
        [Parameter(Mandatory)]
        [object] $SourcePins,

        [Parameter(Mandatory)]
        [ValidateSet('ogg', 'vorbis')]
        [string] $Source,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DescriptorFile
    )

    $property = $SourcePins.PSObject.Properties[$Source]

    if ($null -eq $property -or
        $property.Name -cne $Source -or
        $null -eq $property.Value) {
        throw "missing $Source source pin for Xiph patch descriptor: $DescriptorFile"
    }

    return $property.Value
}


function Test-XiphPatchSourceIdentity {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Identity,

        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $SourcePin,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DescriptorFile
    )

    $identityContext = "source identity in Xiph patch descriptor '$DescriptorFile'"

    if (-not (Test-XiphExactPropertySet `
                -InputObject $Identity `
                -ExpectedNames @(
                'archive_sha256'
                'commit_sha'
                'repository'
            ))) {
        throw "invalid source identity in Xiph patch descriptor: $DescriptorFile"
    }

    $identityRepository = Get-XiphStringPropertyValue `
        -InputObject $Identity `
        -Name 'repository' `
        -Context $identityContext

    $identityCommitSha = Get-XiphStringPropertyValue `
        -InputObject $Identity `
        -Name 'commit_sha' `
        -Context $identityContext

    $identityArchiveSha256 = Get-XiphStringPropertyValue `
        -InputObject $Identity `
        -Name 'archive_sha256' `
        -Context $identityContext

    if ($identityRepository -cnotmatch $script:XiphRepositoryPattern -or
        $identityCommitSha -cnotmatch $script:XiphCommitShaPattern -or
        $identityArchiveSha256 -cnotmatch $script:XiphSha256Pattern) {
        throw "invalid source identity in Xiph patch descriptor: $DescriptorFile"
    }

    if ($null -eq $SourcePin) {
        throw "invalid source pin for Xiph patch descriptor: $DescriptorFile"
    }

    $sourcePinContext = "source pin for Xiph patch descriptor '$DescriptorFile'"

    $repositoryProperty = Get-XiphObjectProperty `
        -InputObject $SourcePin `
        -Name 'repository' `
        -Context $sourcePinContext `
        -Required

    $archiveSha256Property = Get-XiphObjectProperty `
        -InputObject $SourcePin `
        -Name 'archive_sha256' `
        -Context $sourcePinContext `
        -Required

    $commitShaProperty = Get-XiphObjectProperty `
        -InputObject $SourcePin `
        -Name 'commit_sha' `
        -Context $sourcePinContext

    if ($repositoryProperty.Value -isnot [string] -or
        $archiveSha256Property.Value -isnot [string] -or
        ($null -ne $commitShaProperty -and
        $null -ne $commitShaProperty.Value -and
        $commitShaProperty.Value -isnot [string])) {
        throw "invalid source pin for Xiph patch descriptor: $DescriptorFile"
    }

    $sourcePinRepository = [string] $repositoryProperty.Value
    $sourcePinArchiveSha256 = [string] $archiveSha256Property.Value
    $sourcePinCommitSha = if ($null -eq $commitShaProperty) {
        $null
    }
    elseif ($null -eq $commitShaProperty.Value) {
        $null
    }
    else {
        [string] $commitShaProperty.Value
    }

    if ($sourcePinRepository -cnotmatch $script:XiphRepositoryPattern -or
        $sourcePinArchiveSha256 -cnotmatch $script:XiphSha256Pattern -or
        ($null -ne $sourcePinCommitSha -and
        $sourcePinCommitSha -cnotmatch $script:XiphCommitShaPattern)) {
        throw "invalid source pin for Xiph patch descriptor: $DescriptorFile"
    }

    return $sourcePinRepository -ceq $identityRepository -and
    $sourcePinCommitSha -ceq $identityCommitSha -and
    $sourcePinArchiveSha256 -ceq $identityArchiveSha256
}


function ConvertTo-XiphReplacement {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Replacement,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $PatchId,

        [Parameter(Mandatory)]
        [ValidateRange(0, [int]::MaxValue)]
        [int] $Index
    )

    $context = "replacement $Index for Xiph patch '$PatchId'"

    if ($null -eq $Replacement) {
        throw "invalid $context"
    }

    $kind = Get-XiphStringPropertyValue `
        -InputObject $Replacement `
        -Name 'kind' `
        -Context $context

    switch -CaseSensitive ($kind) {
        'replace' {
            if (-not (Test-XiphExactPropertySet `
                        -InputObject $Replacement `
                        -ExpectedNames @('kind', 'from', 'to'))) {
                throw "invalid property set in $context"
            }

            $needle = Get-XiphStringPropertyValue `
                -InputObject $Replacement `
                -Name 'from' `
                -Context $context

            $replacementText = Get-XiphStringPropertyValue `
                -InputObject $Replacement `
                -Name 'to' `
                -Context $context `
                -AllowEmpty
        }

        'insert_before' {
            if (-not (Test-XiphExactPropertySet `
                        -InputObject $Replacement `
                        -ExpectedNames @('kind', 'anchor', 'content'))) {
                throw "invalid property set in $context"
            }

            $needle = Get-XiphStringPropertyValue `
                -InputObject $Replacement `
                -Name 'anchor' `
                -Context $context

            $insertedContent = Get-XiphStringPropertyValue `
                -InputObject $Replacement `
                -Name 'content' `
                -Context $context `
                -AllowEmpty

            $replacementText = $insertedContent + $needle
        }

        default {
            throw "${PatchId}: unsupported replacement kind '$kind'"
        }
    }

    return [pscustomobject]@{
        Needle          = $needle
        ReplacementText = $replacementText
    }
}


function Read-XiphPatchDescriptor {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DescriptorFile
    )

    try {
        $descriptorJson = [IO.File]::ReadAllText($DescriptorFile)
        $descriptor = ConvertFrom-Json `
            -InputObject $descriptorJson `
            -ErrorAction Stop
    }
    catch {
        throw "invalid JSON in Xiph patch descriptor '$DescriptorFile': $($_.Exception.Message)"
    }

    $context = "Xiph patch descriptor '$DescriptorFile'"

    Assert-XiphKnownPropertySet `
        -InputObject $descriptor `
        -AllowedNames @(
        'schema_version'
        'patch_id'
        'source'
        'target'
        'description'
        'applies_to'
        'expected_original_sha256'
        'expected_patched_sha256'
        'skip_if_any_contains'
        'apply_if_all_contains'
        'optional_when_not_applicable'
        'replacements'
    ) `
        -Context $context

    $schemaVersionProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'schema_version' `
        -Context $context `
        -Required

    $patchId = Get-XiphStringPropertyValue `
        -InputObject $descriptor `
        -Name 'patch_id' `
        -Context $context

    $source = Get-XiphStringPropertyValue `
        -InputObject $descriptor `
        -Name 'source' `
        -Context $context

    $targetValue = Get-XiphStringPropertyValue `
        -InputObject $descriptor `
        -Name 'target' `
        -Context $context

    $null = Get-XiphStringPropertyValue `
        -InputObject $descriptor `
        -Name 'description' `
        -Context $context

    if ($schemaVersionProperty.Value -ne 1 -or
        $patchId -cnotmatch $script:XiphPatchIdPattern -or
        ($source -cne 'ogg' -and $source -cne 'vorbis')) {
        throw "invalid Xiph source patch descriptor: $DescriptorFile"
    }

    $relativeTarget = ConvertTo-XiphPatchTarget `
        -Target $targetValue `
        -DescriptorFile $DescriptorFile

    $identityProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'applies_to' `
        -Context $context

    $originalHashProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'expected_original_sha256' `
        -Context $context

    $patchedHashProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'expected_patched_sha256' `
        -Context $context

    $hasIdentity = $null -ne $identityProperty
    $hasOriginalHash = $null -ne $originalHashProperty
    $hasPatchedHash = $null -ne $patchedHashProperty

    if ($hasIdentity -ne $hasOriginalHash -or
        $hasIdentity -ne $hasPatchedHash) {
        throw "source-scoped Xiph patches require applies_to and both expected hashes: $DescriptorFile"
    }

    $expectedOriginalSha256 = $null
    $expectedPatchedSha256 = $null

    if ($hasIdentity) {
        if ($originalHashProperty.Value -isnot [string] -or
            $patchedHashProperty.Value -isnot [string]) {
            throw "invalid expected hashes in Xiph patch descriptor: $DescriptorFile"
        }

        $expectedOriginalSha256 = [string] $originalHashProperty.Value
        $expectedPatchedSha256 = [string] $patchedHashProperty.Value

        if ($expectedOriginalSha256 -cnotmatch $script:XiphSha256Pattern -or
            $expectedPatchedSha256 -cnotmatch $script:XiphSha256Pattern -or
            $expectedOriginalSha256 -ceq $expectedPatchedSha256) {
            throw "invalid expected hashes in Xiph patch descriptor: $DescriptorFile"
        }
    }

    $skipMarkersProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'skip_if_any_contains' `
        -Context $context

    $skipMarkers = @()

    if ($null -ne $skipMarkersProperty) {
        $skipMarkers = @(
            ConvertTo-XiphMarkerArray `
                -Value $skipMarkersProperty.Value `
                -PropertyName 'skip_if_any_contains' `
                -Context $context
        )
    }

    $requiredMarkersProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'apply_if_all_contains' `
        -Context $context `
        -Required

    $requiredMarkers = @(
        ConvertTo-XiphMarkerArray `
            -Value $requiredMarkersProperty.Value `
            -PropertyName 'apply_if_all_contains' `
            -Context $context
    )

    if ($requiredMarkers.Count -eq 0) {
        throw "'apply_if_all_contains' must not be empty in $context"
    }

    $optionalProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'optional_when_not_applicable' `
        -Context $context

    $optionalWhenNotApplicable = $false

    if ($null -ne $optionalProperty) {
        if ($optionalProperty.Value -isnot [bool]) {
            throw "'optional_when_not_applicable' must be a boolean in $context"
        }

        $optionalWhenNotApplicable = [bool] $optionalProperty.Value
    }

    $replacementsProperty = Get-XiphObjectProperty `
        -InputObject $descriptor `
        -Name 'replacements' `
        -Context $context `
        -Required

    if ($replacementsProperty.Value -isnot [Collections.IList] -or
        $replacementsProperty.Value -is [string]) {
        throw "'replacements' must be an array in $context"
    }

    $rawReplacements = @($replacementsProperty.Value)

    if ($rawReplacements.Count -eq 0 -or
        ($rawReplacements.Count -eq 1 -and $null -eq $rawReplacements[0])) {
        throw "Xiph patch '$patchId' contains no replacements"
    }

    $replacements = [Collections.Generic.List[object]]::new()

    for ($index = 0; $index -lt $rawReplacements.Count; $index++) {
        $replacements.Add(
            (ConvertTo-XiphReplacement `
                -Replacement $rawReplacements[$index] `
                -PatchId $patchId `
                -Index $index)
        )
    }

    return [pscustomobject]@{
        File                      = $DescriptorFile
        PatchId                   = $patchId
        Source                    = $source
        RelativeTarget            = $relativeTarget
        Identity                  = if ($hasIdentity) {
            $identityProperty.Value
        }
        else {
            $null
        }
        ExpectedOriginalSha256    = $expectedOriginalSha256
        ExpectedPatchedSha256     = $expectedPatchedSha256
        SkipMarkers               = [string[]] $skipMarkers
        RequiredMarkers           = [string[]] $requiredMarkers
        OptionalWhenNotApplicable = $optionalWhenNotApplicable
        Replacements              = $replacements.ToArray()
    }
}


function Get-XiphLiteralOccurrenceCount {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Needle
    )

    $count = 0
    $startIndex = 0

    while ($startIndex -le $Content.Length) {
        $matchIndex = $Content.IndexOf(
            $Needle,
            $startIndex,
            [StringComparison]::Ordinal
        )

        if ($matchIndex -lt 0) {
            break
        }

        $count++
        $startIndex = $matchIndex + $Needle.Length
    }

    return $count
}


function Test-XiphContentContainsAny {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $Markers
    )

    foreach ($marker in $Markers) {
        if ($Content.IndexOf($marker, [StringComparison]::Ordinal) -ge 0) {
            return $true
        }
    }

    return $false
}


function Test-XiphContentContainsAll {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]] $Markers
    )

    foreach ($marker in $Markers) {
        if ($Content.IndexOf($marker, [StringComparison]::Ordinal) -lt 0) {
            return $false
        }
    }

    return $true
}


function Invoke-XiphSourcePatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $OggRoot,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $VorbisRoot,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $SourcePins,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [string[]] $DescriptorFiles
    )

    $roots = [Collections.Generic.Dictionary[string, string]]::new(
        [StringComparer]::Ordinal
    )
    $roots.Add('ogg', [IO.Path]::GetFullPath($OggRoot))
    $roots.Add('vorbis', [IO.Path]::GetFullPath($VorbisRoot))

    $receipts = [ordered] @{}

    foreach ($descriptorFile in @($DescriptorFiles | Sort-Object -CaseSensitive)) {
        $patch = Read-XiphPatchDescriptor -DescriptorFile $descriptorFile

        if ($null -ne $patch.Identity) {
            $sourcePin = Get-XiphPatchSourcePin `
                -SourcePins $SourcePins `
                -Source $patch.Source `
                -DescriptorFile $descriptorFile

            $identityMatches = Test-XiphPatchSourceIdentity `
                -Identity $patch.Identity `
                -SourcePin $sourcePin `
                -DescriptorFile $descriptorFile

            if (-not $identityMatches) {
                continue
            }
        }

        $target = Resolve-XiphPatchTargetPath `
            -Root $roots[$patch.Source] `
            -RelativeTarget $patch.RelativeTarget

        if (-not [IO.File]::Exists($target)) {
            throw "Xiph source patch target does not exist: $target"
        }

        $targetState = Read-XiphPatchTarget -Path $target
        $content = [string] $targetState.Content
        $originalSha256 = [string] $targetState.Sha256

        if ($null -ne $patch.Identity -and
            $originalSha256 -cne $patch.ExpectedOriginalSha256) {
            throw "$($patch.PatchId): original target SHA-256 drift in $($patch.RelativeTarget)"
        }

        $hasSkipMarker = $patch.SkipMarkers.Count -gt 0 -and (
            Test-XiphContentContainsAny `
                -Content $content `
                -Markers $patch.SkipMarkers
        )

        if ($hasSkipMarker) {
            continue
        }

        $preconditionsMatch = Test-XiphContentContainsAll `
            -Content $content `
            -Markers $patch.RequiredMarkers

        if (-not $preconditionsMatch) {
            if ($patch.OptionalWhenNotApplicable) {
                continue
            }

            throw "$($patch.PatchId): source precondition drift in $($patch.RelativeTarget)"
        }

        if ($receipts.Contains($patch.PatchId)) {
            throw "multiple applicable Xiph patches use patch_id '$($patch.PatchId)'"
        }

        foreach ($replacement in $patch.Replacements) {
            $occurrenceCount = Get-XiphLiteralOccurrenceCount `
                -Content $content `
                -Needle $replacement.Needle

            if ($occurrenceCount -ne 1) {
                throw (
                    "$($patch.PatchId): expected one occurrence of " +
                    "'$($replacement.Needle)', found $occurrenceCount"
                )
            }

            $content = $content.Replace(
                $replacement.Needle,
                $replacement.ReplacementText
            )
        }

        $patchedSha256 = Get-XiphTextSha256 -Content $content

        if ($null -ne $patch.Identity -and
            $patchedSha256 -cne $patch.ExpectedPatchedSha256) {
            throw "$($patch.PatchId): patched target SHA-256 drift in $($patch.RelativeTarget)"
        }

        [IO.File]::WriteAllText(
            $target,
            $content,
            $script:XiphUtf8NoBom
        )

        $receipts[$patch.PatchId] = [ordered] @{
            source            = $patch.Source
            target            = $patch.RelativeTarget
            descriptor_sha256 = Get-XiphFileSha256 -Path $descriptorFile
            original_sha256   = $originalSha256
            patched_sha256    = $patchedSha256
        }
    }

    return $receipts
}


Export-ModuleMember -Function Invoke-XiphSourcePatches

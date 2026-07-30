[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)

function Write-Utf8NoBomFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content
    )

    [IO.File]::WriteAllText(
        $Path,
        $Content,
        $script:Utf8NoBom
    )
}

function Write-JsonObject {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [object] $Value
    )

    Write-Utf8NoBomFile `
        -Path $Path `
        -Content ($Value | ConvertTo-Json -Depth 10)
}

function Get-FileSha256 {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    return (
        Get-FileHash -LiteralPath $Path -Algorithm SHA256
    ).Hash.ToLowerInvariant()
}

function New-VorbisSourcePins {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Repository,

        [Parameter(Mandatory)]
        [string] $CommitSha,

        [Parameter(Mandatory)]
        [string] $ArchiveSha256
    )

    return [pscustomobject]@{
        vorbis = [pscustomobject]@{
            repository     = $Repository
            commit_sha     = $CommitSha
            archive_sha256 = $ArchiveSha256
        }
    }
}

function Write-SyntheticPatchDescriptor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $PatchId,

        [Parameter(Mandatory)]
        [string] $Repository,

        [Parameter(Mandatory)]
        [string] $CommitSha,

        [Parameter(Mandatory)]
        [string] $ArchiveSha256,

        [Parameter(Mandatory)]
        [string] $OriginalSha256,

        [Parameter(Mandatory)]
        [string] $PatchedSha256
    )

    $descriptor = [ordered]@{
        schema_version           = 1
        patch_id                 = $PatchId
        source                   = 'vorbis'
        target                   = 'win32/vorbis.def'
        description              = 'Synthetic source-scoped patch contract.'

        applies_to               = [ordered]@{
            repository     = $Repository
            commit_sha     = $CommitSha
            archive_sha256 = $ArchiveSha256
        }

        expected_original_sha256 = $OriginalSha256
        expected_patched_sha256  = $PatchedSha256
        apply_if_all_contains    = @(
            '_analysis_output_always'
        )

        replacements             = @(
            [ordered]@{
                kind = 'replace'
                from = '_analysis_output_always'
                to   = ';_analysis_output_always'
            }
        )
    }

    $json = $descriptor | ConvertTo-Json -Depth 10

    Write-Utf8NoBomFile -Path $Path -Content $json
}

function Invoke-TestSourcePatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $OggRoot,

        [Parameter(Mandatory)]
        [string] $VorbisRoot,

        [Parameter(Mandatory)]
        [object] $SourcePins,

        [Parameter(Mandatory)]
        [string] $DescriptorPath
    )

    Invoke-XiphSourcePatches `
        -OggRoot $OggRoot `
        -VorbisRoot $VorbisRoot `
        -SourcePins $SourcePins `
        -DescriptorFiles @($DescriptorPath)
}

function Get-RequiredPatchReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Receipts,

        [Parameter(Mandatory)]
        [string] $PatchId
    )

    if ($null -eq $Receipts -or
        $Receipts.Count -ne 1 -or
        -not $Receipts.Contains($PatchId)) {
        throw (
            "the active historical export must produce exactly one " +
            "patch receipt named '$PatchId'"
        )
    }

    return $Receipts[$PatchId]
}

function Assert-PatchReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Receipt,

        [Parameter(Mandatory)]
        [string] $ExpectedDescriptorSha256,

        [Parameter(Mandatory)]
        [string] $ExpectedOriginalSha256,

        [Parameter(Mandatory)]
        [string] $ExpectedPatchedSha256
    )

    $expected = [ordered]@{
        source            = 'vorbis'
        target            = 'win32/vorbis.def'
        descriptor_sha256 = $ExpectedDescriptorSha256
        original_sha256   = $ExpectedOriginalSha256
        patched_sha256    = $ExpectedPatchedSha256
    }

    $actualKeys = @($Receipt.Keys)
    $expectedKeys = @($expected.Keys)
    if (($actualKeys -join "`n") -cne ($expectedKeys -join "`n")) {
        throw (
            'the historical DEF patch receipt has an invalid property set: ' +
            "expected [$($expectedKeys -join ', ')], " +
            "got [$($actualKeys -join ', ')]"
        )
    }

    $actual = [ordered]@{
        source            = [string] $Receipt.source
        target            = [string] $Receipt.target
        descriptor_sha256 = [string] $Receipt.descriptor_sha256
        original_sha256   = [string] $Receipt.original_sha256
        patched_sha256    = [string] $Receipt.patched_sha256
    }

    foreach ($field in $expected.Keys) {
        $expectedValue = [string] $expected[$field]
        $actualValue = [string] $actual[$field]

        if ($actualValue -cne $expectedValue) {
            throw (
                "the historical DEF patch receipt field '$field' is invalid: " +
                "expected '$expectedValue', got '$actualValue'"
            )
        }
    }
}

function Assert-Throws {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock] $Action,

        [Parameter(Mandatory)]
        [string] $FailureMessage,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [regex] $ExpectedMessage
    )

    try {
        & $Action | Out-Null
    }
    catch {
        if (-not $ExpectedMessage.IsMatch($_.Exception.Message)) {
            throw (
                "$FailureMessage The operation failed with an unexpected " +
                "error. Expected '$ExpectedMessage', got: " +
                "$($_.Exception.Message)"
            )
        }

        return
    }

    throw $FailureMessage
}

function Assert-PathWithinRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Root,

        [Parameter(Mandatory)]
        [string] $Description
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root)
    $relativePath = [IO.Path]::GetRelativePath($resolvedRoot, $resolvedPath)
    $parentPrefix = '..' + [IO.Path]::DirectorySeparatorChar
    $alternateParentPrefix = '..' + [IO.Path]::AltDirectorySeparatorChar

    if (
        [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath -eq '..' -or
        $relativePath.StartsWith($parentPrefix, [StringComparison]::Ordinal) -or
        $relativePath.StartsWith(
            $alternateParentPrefix,
            [StringComparison]::Ordinal
        )
    ) {
        throw "$Description escaped its expected root: $resolvedPath"
    }
}

function Assert-ReviewedDescriptorIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object] $Descriptor
    )

    $expected = [ordered]@{
        repository               = 'xiph/vorbis'
        commit_sha               = 'd701313fc8b102737e5fdd3fdd4ec6b5b6410211'
        archive_sha256           =
        'dbf92706c840f214a14d256579cf627d115f91dc580731d0d13ba1abbb93492a'
        expected_original_sha256 =
        'fcdd7c139818144edd33175742eb2d18d71e96418acc9e1b395a6d811e2f0859'
        expected_patched_sha256  =
        '07981be6e4ad30e2905ab6eda089107b079c7cbb2132bb33e63dbb6ef6d2c774'
    }

    $actual = [ordered]@{
        repository               = [string] $Descriptor.applies_to.repository
        commit_sha               = [string] $Descriptor.applies_to.commit_sha
        archive_sha256           = [string] $Descriptor.applies_to.archive_sha256
        expected_original_sha256 =
        [string] $Descriptor.expected_original_sha256
        expected_patched_sha256  =
        [string] $Descriptor.expected_patched_sha256
    }

    foreach ($field in $expected.Keys) {
        $expectedValue = [string] $expected[$field]
        $actualValue = [string] $actual[$field]

        if ($actualValue -cne $expectedValue) {
            throw (
                "the reviewed Vorbis 1.2.3 patch identity field '$field' " +
                "drifted: expected '$expectedValue', got '$actualValue'"
            )
        }
    }
}

$repoRoot = [IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '../..')
)

$modulePath = Join-Path `
    -Path $repoRoot `
    -ChildPath 'scripts/xiph/source-patch.psm1'

$reviewedDescriptorPath = Join-Path `
    -Path $repoRoot `
    -ChildPath 'scripts/xiph/patches/vorbis-win32-analysis-export-v1.json'

Import-Module -Name $modulePath -Force

$patchId = 'vorbis-win32-analysis-export-v1'
$syntheticRepository = 'xiph/vorbis'
$syntheticCommitSha = '1' * 40
$matchingArchiveSha256 = '2' * 64
$nonMatchingArchiveSha256 = '3' * 64

$activeDefinition = @'
LIBRARY vorbis
EXPORTS
_analysis_output_always
vorbis_info_init
'@

$expectedDefinition = $activeDefinition.Replace(
    '_analysis_output_always',
    ';_analysis_output_always'
)

$ambiguousDefinition = @'
LIBRARY vorbis
EXPORTS
;_analysis_output_always
_analysis_output_always
'@

$systemTemp = [IO.Path]::GetFullPath(
    [IO.Path]::GetTempPath()
)

$testRoot = [IO.Path]::GetFullPath(
    (Join-Path `
        -Path $systemTemp `
        -ChildPath (
        "renderpilot-xiph-patch-$([Guid]::NewGuid().ToString('N'))"
    ))
)

Assert-PathWithinRoot `
    -Path $testRoot `
    -Root $systemTemp `
    -Description 'Xiph source patch test root'

$oggRoot = Join-Path $testRoot 'ogg'
$vorbisRoot = Join-Path $testRoot 'vorbis'
$definitionPath = Join-Path $vorbisRoot 'win32/vorbis.def'
$descriptorPath = Join-Path $testRoot 'source-patch.json'
$ambiguousDescriptorPath = Join-Path $testRoot 'ambiguous-source-patch.json'
$invalidDescriptorPath = Join-Path $testRoot 'invalid-source-patch.json'

$matchingSourcePins = New-VorbisSourcePins `
    -Repository $syntheticRepository `
    -CommitSha $syntheticCommitSha `
    -ArchiveSha256 $matchingArchiveSha256

$nonMatchingSourcePins = New-VorbisSourcePins `
    -Repository $syntheticRepository `
    -CommitSha $syntheticCommitSha `
    -ArchiveSha256 $nonMatchingArchiveSha256

try {
    [void] [IO.Directory]::CreateDirectory($oggRoot)
    [void] [IO.Directory]::CreateDirectory(
        [IO.Path]::GetDirectoryName($definitionPath)
    )

    # Construct the synthetic patch contract from byte-exact fixtures.

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $activeDefinition

    $originalSha256 = Get-FileSha256 -Path $definitionPath

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $expectedDefinition

    $patchedSha256 = Get-FileSha256 -Path $definitionPath

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $activeDefinition

    Write-SyntheticPatchDescriptor `
        -Path $descriptorPath `
        -PatchId $patchId `
        -Repository $syntheticRepository `
        -CommitSha $syntheticCommitSha `
        -ArchiveSha256 $matchingArchiveSha256 `
        -OriginalSha256 $originalSha256 `
        -PatchedSha256 $patchedSha256

    $descriptorSha256 = Get-FileSha256 -Path $descriptorPath

    # Matching source identity must apply exactly one reviewed mutation.

    $receipts = Invoke-TestSourcePatches `
        -OggRoot $oggRoot `
        -VorbisRoot $vorbisRoot `
        -SourcePins $matchingSourcePins `
        -DescriptorPath $descriptorPath

    $receipt = Get-RequiredPatchReceipt `
        -Receipts $receipts `
        -PatchId $patchId

    $actualPatchedDefinition = [IO.File]::ReadAllText($definitionPath)

    if ($actualPatchedDefinition -cne $expectedDefinition) {
        throw (
            'the historical DEF patch changed bytes outside the ' +
            'reviewed export'
        )
    }

    Assert-PatchReceipt `
        -Receipt $receipt `
        -ExpectedDescriptorSha256 $descriptorSha256 `
        -ExpectedOriginalSha256 $originalSha256 `
        -ExpectedPatchedSha256 $patchedSha256

    # A different source identity must not modify the source tree.

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $activeDefinition

    $unaffectedReceipts = Invoke-TestSourcePatches `
        -OggRoot $oggRoot `
        -VorbisRoot $vorbisRoot `
        -SourcePins $nonMatchingSourcePins `
        -DescriptorPath $descriptorPath

    if ($null -ne $unaffectedReceipts -and
        $unaffectedReceipts.Count -ne 0) {
        throw 'a non-matching source pin must not produce patch receipts'
    }

    $unaffectedDefinition = [IO.File]::ReadAllText($definitionPath)

    if ($unaffectedDefinition -cne $activeDefinition) {
        throw 'a non-matching source pin must remain byte-identical'
    }

    # Ambiguous source content must be rejected rather than partially patched.

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $ambiguousDefinition

    $ambiguousOriginalSha256 = Get-FileSha256 -Path $definitionPath
    $ambiguousPatchedDefinition = $ambiguousDefinition.Replace(
        '_analysis_output_always',
        ';_analysis_output_always'
    )

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $ambiguousPatchedDefinition

    $ambiguousPatchedSha256 = Get-FileSha256 -Path $definitionPath

    Write-Utf8NoBomFile `
        -Path $definitionPath `
        -Content $ambiguousDefinition

    $ambiguousPatchId = "$patchId-ambiguous"
    Write-SyntheticPatchDescriptor `
        -Path $ambiguousDescriptorPath `
        -PatchId $ambiguousPatchId `
        -Repository $syntheticRepository `
        -CommitSha $syntheticCommitSha `
        -ArchiveSha256 $matchingArchiveSha256 `
        -OriginalSha256 $ambiguousOriginalSha256 `
        -PatchedSha256 $ambiguousPatchedSha256

    Assert-Throws `
        -Action {
        Invoke-TestSourcePatches `
            -OggRoot $oggRoot `
            -VorbisRoot $vorbisRoot `
            -SourcePins $matchingSourcePins `
            -DescriptorPath $ambiguousDescriptorPath
    } `
        -FailureMessage (
        'the historical DEF patch must fail closed on an ambiguous source'
    ) `
        -ExpectedMessage ([regex] 'expected one occurrence.*found 2')

    $definitionAfterRejectedPatch = [IO.File]::ReadAllText($definitionPath)
    if ($definitionAfterRejectedPatch -cne $ambiguousDefinition) {
        throw 'a rejected ambiguous patch must leave its target byte-identical'
    }

    # Descriptor arrays and property sets are closed contracts.

    $invalidDescriptor = ConvertFrom-Json -InputObject (
        [IO.File]::ReadAllText($descriptorPath)
    )
    $invalidDescriptor |
    Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    Write-JsonObject `
        -Path $invalidDescriptorPath `
        -Value $invalidDescriptor

    Assert-Throws `
        -Action {
        Invoke-TestSourcePatches `
            -OggRoot $oggRoot `
            -VorbisRoot $vorbisRoot `
            -SourcePins $matchingSourcePins `
            -DescriptorPath $invalidDescriptorPath
    } `
        -FailureMessage 'patch descriptors must reject unknown properties' `
        -ExpectedMessage ([regex] "unknown property 'unexpected'")

    $invalidDescriptor = ConvertFrom-Json -InputObject (
        [IO.File]::ReadAllText($descriptorPath)
    )
    $invalidDescriptor.apply_if_all_contains = '_analysis_output_always'
    Write-JsonObject `
        -Path $invalidDescriptorPath `
        -Value $invalidDescriptor

    Assert-Throws `
        -Action {
        Invoke-TestSourcePatches `
            -OggRoot $oggRoot `
            -VorbisRoot $vorbisRoot `
            -SourcePins $matchingSourcePins `
            -DescriptorPath $invalidDescriptorPath
    } `
        -FailureMessage 'patch marker collections must remain arrays' `
        -ExpectedMessage ([regex] 'must be an array of non-empty strings')

    $invalidDescriptor = ConvertFrom-Json -InputObject (
        [IO.File]::ReadAllText($descriptorPath)
    )
    $invalidDescriptor.replacements[0] |
    Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    Write-JsonObject `
        -Path $invalidDescriptorPath `
        -Value $invalidDescriptor

    Assert-Throws `
        -Action {
        Invoke-TestSourcePatches `
            -OggRoot $oggRoot `
            -VorbisRoot $vorbisRoot `
            -SourcePins $matchingSourcePins `
            -DescriptorPath $invalidDescriptorPath
    } `
        -FailureMessage 'patch replacements must reject unknown properties' `
        -ExpectedMessage ([regex] 'invalid property set in replacement')

    # Source mutation is text-only and therefore rejects malformed UTF-8.

    [IO.File]::WriteAllBytes(
        $definitionPath,
        [byte[]] @(0xFF, 0xFE, 0xFD)
    )

    Assert-Throws `
        -Action {
        Invoke-TestSourcePatches `
            -OggRoot $oggRoot `
            -VorbisRoot $vorbisRoot `
            -SourcePins $matchingSourcePins `
            -DescriptorPath $descriptorPath
    } `
        -FailureMessage 'patch targets must be valid UTF-8 text' `
        -ExpectedMessage ([regex] 'not valid UTF-8')

    # The committed descriptor is an immutable reviewed identity contract.

    $reviewedDescriptor = ConvertFrom-Json -InputObject (
        [IO.File]::ReadAllText($reviewedDescriptorPath)
    )

    Assert-ReviewedDescriptorIdentity -Descriptor $reviewedDescriptor

    Write-Host 'Xiph source patch tests passed.'
}
finally {
    if ([IO.Directory]::Exists($testRoot)) {
        Assert-PathWithinRoot `
            -Path $testRoot `
            -Root $systemTemp `
            -Description 'Xiph source patch cleanup root'

        Remove-Item `
            -LiteralPath $testRoot `
            -Recurse `
            -Force
    }
}

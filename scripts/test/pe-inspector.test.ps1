$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock] $Action,

        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    try {
        & $Action
    }
    catch {
        return
    }
    throw "Expected PE boundary failure: $Description"
}

function Set-UInt16 {
    param([byte[]] $Bytes, [int] $Offset, [uint16] $Value)
    [BitConverter]::GetBytes($Value).CopyTo($Bytes, $Offset)
}

function Set-UInt32 {
    param([byte[]] $Bytes, [int] $Offset, [uint32] $Value)
    [BitConverter]::GetBytes($Value).CopyTo($Bytes, $Offset)
}

$modulePath = Join-Path $PSScriptRoot '../lib/pe-inspector.psm1'
Import-Module -Name $modulePath -Force
$module = Get-Module -Name pe-inspector

& $module {
    Assert-PeRange 0 64 64 'exact header boundary'
}
Assert-Throws -Description 'truncated headers' -Action {
    & $module {
        Assert-PeRange 63 2 64 'truncated PE header'
    }
}
Assert-Throws -Description 'overflowing section table' -Action {
    & $module {
        Assert-PeRange ([int64]::MaxValue - 4) 40 [int64]::MaxValue 'section table'
    }
}

$section = [pscustomobject]@{
    VirtualSize = [uint32]0x200
    VirtualAddress = [uint32]0x1000
    RawSize = [uint32]0x100
    RawPointer = [uint32]0x200
}
$headerOffset = & $module {
    param($Section)
    Convert-RvaToFileOffset 0x1FF @($Section) 0x200 0x400
} $section
if ($headerOffset -ne 0x1FF) {
    throw "Header RVA mapped to $headerOffset instead of 0x1FF"
}
$sectionOffset = & $module {
    param($Section)
    Convert-RvaToFileOffset 0x1010 @($Section) 0x200 0x400
} $section
if ($sectionOffset -ne 0x210) {
    throw "Section RVA mapped to $sectionOffset instead of 0x210"
}
Assert-Throws -Description 'RVA in virtual-only section tail' -Action {
    & $module {
        param($Section)
        Convert-RvaToFileOffset 0x1100 @($Section) 0x200 0x400
    } $section
}
Assert-Throws -Description 'unmapped RVA' -Action {
    & $module {
        param($Section)
        Convert-RvaToFileOffset 0x2000 @($Section) 0x200 0x400
    } $section
}

$nonOverlappingSections = @(
    [pscustomobject]@{
        Index = 0
        VirtualSize = [uint32]0x100
        VirtualAddress = [uint32]0x1000
        RawSize = [uint32]0x100
        RawPointer = [uint32]0x200
    },
    [pscustomobject]@{
        Index = 1
        VirtualSize = [uint32]0x100
        VirtualAddress = [uint32]0x1100
        RawSize = [uint32]0x100
        RawPointer = [uint32]0x300
    }
)
& $module {
    param($Sections)
    Assert-PeSectionsDoNotOverlap $Sections '<adjacent sections>'
} $nonOverlappingSections

$rawOverlapSections = @(
    $nonOverlappingSections[0],
    [pscustomobject]@{
        Index = 1
        VirtualSize = [uint32]0x100
        VirtualAddress = [uint32]0x1100
        RawSize = [uint32]0x100
        RawPointer = [uint32]0x280
    }
)
Assert-Throws -Description 'overlapping section raw data' -Action {
    & $module {
        param($Sections)
        Assert-PeSectionsDoNotOverlap $Sections '<raw overlap>'
    } $rawOverlapSections
}

$rvaOverlapSections = @(
    $nonOverlappingSections[0],
    [pscustomobject]@{
        Index = 1
        VirtualSize = [uint32]0x100
        VirtualAddress = [uint32]0x1080
        RawSize = [uint32]0x100
        RawPointer = [uint32]0x300
    }
)
Assert-Throws -Description 'overlapping section RVA ranges' -Action {
    & $module {
        param($Sections)
        Assert-PeSectionsDoNotOverlap $Sections '<RVA overlap>'
    } $rvaOverlapSections
}

[byte[]] $validName = [Text.Encoding]::ASCII.GetBytes("VR_InitInternal`0")
$exportName = & $module {
    param($Bytes)
    Read-AsciiExportName $Bytes 0
} $validName
if ($exportName -ne 'VR_InitInternal') {
    throw "Unexpected parsed export name $exportName"
}
Assert-Throws -Description 'empty export name' -Action {
    & $module {
        Read-AsciiExportName ([byte[]]@(0)) 0
    }
}
Assert-Throws -Description 'non-printable export name' -Action {
    & $module {
        Read-AsciiExportName ([byte[]]@(0x41, 0x1F, 0)) 0
    }
}
Assert-Throws -Description 'unterminated export name' -Action {
    & $module {
        Read-AsciiExportName ([byte[]](0x41) * 257) 0
    }
}

[byte[]] $exportBytes = [byte[]]::new(1024)
$exportSection = [pscustomobject]@{
    Index = 0
    VirtualSize = [uint32]0x200
    VirtualAddress = [uint32]0x1000
    RawSize = [uint32]0x200
    RawPointer = [uint32]0x200
}
$exportDirectoryOffset = 0x200
Set-UInt32 $exportBytes ($exportDirectoryOffset + 20) 1
Set-UInt32 $exportBytes ($exportDirectoryOffset + 24) 1
Set-UInt32 $exportBytes ($exportDirectoryOffset + 28) 0x1040
Set-UInt32 $exportBytes ($exportDirectoryOffset + 32) 0x1044
Set-UInt32 $exportBytes ($exportDirectoryOffset + 36) 0x1048
Set-UInt32 $exportBytes 0x240 0x1080
Set-UInt32 $exportBytes 0x244 0x1050
Set-UInt16 $exportBytes 0x248 0
[Text.Encoding]::ASCII.GetBytes("VR_InitInternal`0").CopyTo($exportBytes, 0x250)

$parsedExports = @(
    & $module {
        param($Bytes, $Section)
        Get-PeExportNames `
            -Bytes $Bytes `
            -Sections @($Section) `
            -SizeOfHeaders 0x200 `
            -ExportRva 0x1000 `
            -ExportSize 0x80 `
            -Path '<synthetic export fixture>'
    } $exportBytes $exportSection
)
if ($parsedExports.Count -ne 1 -or $parsedExports[0] -ne 'VR_InitInternal') {
    throw "Synthetic export fixture parsed incorrectly"
}
Assert-Throws -Description 'truncated export directory' -Action {
    & $module {
        param($Bytes, $Section)
        Get-PeExportNames `
            -Bytes $Bytes `
            -Sections @($Section) `
            -SizeOfHeaders 0x200 `
            -ExportRva 0x1000 `
            -ExportSize 39 `
            -Path '<truncated export fixture>'
    } $exportBytes $exportSection
}

[byte[]] $invalidOrdinal = $exportBytes.Clone()
Set-UInt16 $invalidOrdinal 0x248 1
Assert-Throws -Description 'export ordinal outside function table' -Action {
    & $module {
        param($Bytes, $Section)
        Get-PeExportNames `
            -Bytes $Bytes `
            -Sections @($Section) `
            -SizeOfHeaders 0x200 `
            -ExportRva 0x1000 `
            -ExportSize 0x80 `
            -Path '<invalid ordinal fixture>'
    } $invalidOrdinal $exportSection
}

[byte[]] $truncatedNameTable = $exportBytes.Clone()
Set-UInt32 $truncatedNameTable ($exportDirectoryOffset + 32) 0x11FF
Assert-Throws -Description 'export name pointer table crossing section boundary' -Action {
    & $module {
        param($Bytes, $Section)
        Get-PeExportNames `
            -Bytes $Bytes `
            -Sections @($Section) `
            -SizeOfHeaders 0x200 `
            -ExportRva 0x1000 `
            -ExportSize 0x80 `
            -Path '<truncated name table fixture>'
    } $truncatedNameTable $exportSection
}

$fixturePath = Join-Path `
    ([IO.Path]::GetTempPath()) `
    "renderpilot-pe-$([Guid]::NewGuid().ToString('N')).dll"
try {
    Add-Type `
        -TypeDefinition 'public static class RenderPilotPeFixture { public static int Value => 1; }' `
        -OutputAssembly $fixturePath
    $metadata = Get-PeMetadata -Path $fixturePath
    if ($metadata.architecture -notin @('X64', 'X86')) {
        throw "Unexpected fixture architecture $($metadata.architecture)"
    }

    [byte[]] $bytes = [IO.File]::ReadAllBytes($fixturePath)
    $peOffset = [BitConverter]::ToUInt32($bytes, 0x3C)
    $coffOffset = $peOffset + 4
    $optionalOffset = $coffOffset + 20

    [byte[]] $truncatedOptional = $bytes.Clone()
    [BitConverter]::GetBytes([uint16]1).CopyTo(
        $truncatedOptional,
        [int]($coffOffset + 16)
    )
    [IO.File]::WriteAllBytes($fixturePath, $truncatedOptional)
    Assert-Throws -Description 'truncated optional header' -Action {
        Get-PeMetadata -Path $fixturePath
    }

    [byte[]] $truncatedSections = $bytes.Clone()
    $optionalSize = [BitConverter]::ToUInt16($truncatedSections, $coffOffset + 16)
    $sectionCount = [BitConverter]::ToUInt16($truncatedSections, $coffOffset + 2)
    $sectionTableEnd = $optionalOffset + $optionalSize + (40 * $sectionCount)
    [Array]::Resize([ref]$truncatedSections, $sectionTableEnd - 1)
    [IO.File]::WriteAllBytes($fixturePath, $truncatedSections)
    Assert-Throws -Description 'truncated section table' -Action {
        Get-PeMetadata -Path $fixturePath
    }
}
finally {
    if (Test-Path -LiteralPath $fixturePath) {
        Remove-Item -LiteralPath $fixturePath -Force
    }
}

Write-Output 'PE inspector boundary tests passed.'

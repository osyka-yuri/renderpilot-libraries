Set-StrictMode -Version Latest

$script:MaximumExportNames = 16384
$script:MaximumExportFunctions = 65536
$script:MaximumExportNameBytes = 256
$script:MaximumSectionCount = 96

function Assert-PeRange {
    param(
        [Parameter(Mandatory = $true)]
        [int64] $Offset,

        [Parameter(Mandatory = $true)]
        [int64] $Size,

        [Parameter(Mandatory = $true)]
        [int64] $FileLength,

        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    if ($Offset -lt 0 -or $Size -lt 0 -or
        $Offset -gt $FileLength -or $Size -gt ($FileLength - $Offset)) {
        throw [IO.InvalidDataException]::new(
            "$Description is outside the PE file"
        )
    }
}

function Read-UInt16At {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]] $Bytes,

        [Parameter(Mandatory = $true)]
        [int64] $Offset
    )

    Assert-PeRange $Offset 2 $Bytes.LongLength "16-bit read at offset $Offset"
    return [BitConverter]::ToUInt16($Bytes, [int]$Offset)
}

function Read-UInt32At {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]] $Bytes,

        [Parameter(Mandatory = $true)]
        [int64] $Offset
    )

    Assert-PeRange $Offset 4 $Bytes.LongLength "32-bit read at offset $Offset"
    return [BitConverter]::ToUInt32($Bytes, [int]$Offset)
}

function Convert-RvaToFileOffset {
    param(
        [Parameter(Mandatory = $true)]
        [uint32] $Rva,

        [Parameter(Mandatory = $true)]
        [object[]] $Sections,

        [Parameter(Mandatory = $true)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory = $true)]
        [int64] $FileLength
    )

    if ($Rva -lt $SizeOfHeaders -and $Rva -lt $FileLength) {
        return [int64]$Rva
    }

    $candidate = [uint64]$Rva
    foreach ($section in $Sections) {
        $start = [uint64]$section.VirtualAddress
        $span = [Math]::Max([uint64]$section.VirtualSize, [uint64]$section.RawSize)
        if ($candidate -lt $start -or $candidate -ge ($start + $span)) {
            continue
        }

        $delta = $candidate - $start
        if ($delta -ge [uint64]$section.RawSize) {
            throw [IO.InvalidDataException]::new(
                "PE RVA 0x$($Rva.ToString('X8')) points outside section raw data"
            )
        }
        $offset = [uint64]$section.RawPointer + $delta
        if ($offset -ge [uint64]$FileLength) {
            throw [IO.InvalidDataException]::new(
                "PE RVA 0x$($Rva.ToString('X8')) points outside the file"
            )
        }
        return [int64]$offset
    }

    throw [IO.InvalidDataException]::new(
        "PE RVA 0x$($Rva.ToString('X8')) is not mapped by a section"
    )
}

function Convert-RvaRangeToFileOffset {
    param(
        [Parameter(Mandatory = $true)]
        [uint32] $Rva,

        [Parameter(Mandatory = $true)]
        [uint32] $Size,

        [Parameter(Mandatory = $true)]
        [object[]] $Sections,

        [Parameter(Mandatory = $true)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory = $true)]
        [int64] $FileLength,

        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    if ($Size -eq 0) {
        throw [IO.InvalidDataException]::new("$Description is empty")
    }
    $lastRva = [uint64]$Rva + [uint64]$Size - 1
    if ($lastRva -gt [uint32]::MaxValue) {
        throw [IO.InvalidDataException]::new("$Description RVA range overflows")
    }
    $firstOffset = Convert-RvaToFileOffset `
        $Rva $Sections $SizeOfHeaders $FileLength
    $lastOffset = Convert-RvaToFileOffset `
        ([uint32]$lastRva) $Sections $SizeOfHeaders $FileLength
    if (($lastOffset - $firstOffset) -ne ($Size - 1)) {
        throw [IO.InvalidDataException]::new(
            "$Description is not contiguous in the PE file"
        )
    }
    Assert-PeRange $firstOffset $Size $FileLength $Description
    return $firstOffset
}

function Assert-PeSectionsDoNotOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [object[]] $Sections,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    for ($leftIndex = 0; $leftIndex -lt $Sections.Count; $leftIndex++) {
        $left = $Sections[$leftIndex]
        for (
            $rightIndex = $leftIndex + 1;
            $rightIndex -lt $Sections.Count;
            $rightIndex++
        ) {
            $right = $Sections[$rightIndex]

            if ($left.RawSize -gt 0 -and $right.RawSize -gt 0) {
                $leftRawEnd = [uint64]$left.RawPointer + [uint64]$left.RawSize
                $rightRawEnd = [uint64]$right.RawPointer + [uint64]$right.RawSize
                if ([uint64]$left.RawPointer -lt $rightRawEnd -and
                    [uint64]$right.RawPointer -lt $leftRawEnd) {
                    throw [IO.InvalidDataException]::new(
                        "PE sections $($left.Index) and $($right.Index) have overlapping raw data: $Path"
                    )
                }
            }

            $leftVirtualSpan = [Math]::Max(
                [uint64]$left.VirtualSize,
                [uint64]$left.RawSize
            )
            $rightVirtualSpan = [Math]::Max(
                [uint64]$right.VirtualSize,
                [uint64]$right.RawSize
            )
            if ($leftVirtualSpan -eq 0 -or $rightVirtualSpan -eq 0) {
                continue
            }
            $leftVirtualEnd =
                [uint64]$left.VirtualAddress + $leftVirtualSpan
            $rightVirtualEnd =
                [uint64]$right.VirtualAddress + $rightVirtualSpan
            if ([uint64]$left.VirtualAddress -lt $rightVirtualEnd -and
                [uint64]$right.VirtualAddress -lt $leftVirtualEnd) {
                throw [IO.InvalidDataException]::new(
                    "PE sections $($left.Index) and $($right.Index) have overlapping RVA ranges: $Path"
                )
            }
        }
    }
}

function Read-AsciiExportName {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]] $Bytes,

        [Parameter(Mandatory = $true)]
        [int64] $Offset
    )

    $nameBytes = [Collections.Generic.List[byte]]::new()
    for ($index = 0; $index -le $script:MaximumExportNameBytes; $index++) {
        $position = $Offset + $index
        if ($position -ge $Bytes.LongLength) {
            throw [IO.InvalidDataException]::new(
                "PE export name is not terminated inside the file"
            )
        }
        $value = $Bytes[[int]$position]
        if ($value -eq 0) {
            if ($nameBytes.Count -eq 0) {
                throw [IO.InvalidDataException]::new("PE export name is empty")
            }
            return [Text.Encoding]::ASCII.GetString($nameBytes.ToArray())
        }
        if ($value -lt 0x20 -or $value -gt 0x7E) {
            throw [IO.InvalidDataException]::new(
                "PE export name contains non-printable ASCII"
            )
        }
        $nameBytes.Add($value)
    }

    throw [IO.InvalidDataException]::new(
        "PE export name exceeds $($script:MaximumExportNameBytes) bytes"
    )
}

function Get-PeExportNames {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]] $Bytes,

        [Parameter(Mandatory = $true)]
        [object[]] $Sections,

        [Parameter(Mandatory = $true)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory = $true)]
        [uint32] $ExportRva,

        [Parameter(Mandatory = $true)]
        [uint32] $ExportSize,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if ($ExportRva -eq 0 -and $ExportSize -eq 0) {
        return @()
    }
    if ($ExportRva -eq 0 -or $ExportSize -lt 40) {
        throw [IO.InvalidDataException]::new(
            "Malformed PE export directory: $Path"
        )
    }

    $directoryOffset = Convert-RvaRangeToFileOffset `
        $ExportRva `
        $ExportSize `
        $Sections `
        $SizeOfHeaders `
        $Bytes.LongLength `
        "PE export directory"
    $functionCount = Read-UInt32At $Bytes ($directoryOffset + 20)
    $nameCount = Read-UInt32At $Bytes ($directoryOffset + 24)
    if ($functionCount -gt $script:MaximumExportFunctions) {
        throw [IO.InvalidDataException]::new(
            "PE export function count $functionCount exceeds $($script:MaximumExportFunctions)`: $Path"
        )
    }
    if ($nameCount -gt $script:MaximumExportNames -or
        $nameCount -gt $functionCount) {
        throw [IO.InvalidDataException]::new(
            "PE export name count $nameCount is invalid: $Path"
        )
    }
    if ($nameCount -eq 0) {
        return @()
    }

    $functionsRva = Read-UInt32At $Bytes ($directoryOffset + 28)
    $namesRva = Read-UInt32At $Bytes ($directoryOffset + 32)
    $ordinalsRva = Read-UInt32At $Bytes ($directoryOffset + 36)
    if ($functionsRva -eq 0 -or $namesRva -eq 0 -or $ordinalsRva -eq 0) {
        throw [IO.InvalidDataException]::new(
            "PE export address, name, or ordinal table is missing: $Path"
        )
    }

    [void](Convert-RvaRangeToFileOffset `
        $functionsRva `
        ([uint32]([uint64]$functionCount * 4)) `
        $Sections `
        $SizeOfHeaders `
        $Bytes.LongLength `
        "PE export address table")
    $namesOffset = Convert-RvaRangeToFileOffset `
        $namesRva `
        ([uint32]([uint64]$nameCount * 4)) `
        $Sections `
        $SizeOfHeaders `
        $Bytes.LongLength `
        "PE export name pointer table"
    $ordinalsOffset = Convert-RvaRangeToFileOffset `
        $ordinalsRva `
        ([uint32]([uint64]$nameCount * 2)) `
        $Sections `
        $SizeOfHeaders `
        $Bytes.LongLength `
        "PE export ordinal table"

    $exportNames = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    for ($index = 0; $index -lt $nameCount; $index++) {
        $ordinal = Read-UInt16At $Bytes ($ordinalsOffset + 2 * $index)
        if ($ordinal -ge $functionCount) {
            throw [IO.InvalidDataException]::new(
                "PE export ordinal $ordinal is outside the function table: $Path"
            )
        }
        $nameRva = Read-UInt32At $Bytes ($namesOffset + 4 * $index)
        if ($nameRva -eq 0) {
            throw [IO.InvalidDataException]::new(
                "PE export name RVA is zero: $Path"
            )
        }
        $nameOffset = Convert-RvaToFileOffset `
            $nameRva $Sections $SizeOfHeaders $Bytes.LongLength
        $name = Read-AsciiExportName $Bytes $nameOffset
        if (-not $seen.Add($name)) {
            throw [IO.InvalidDataException]::new(
                "PE export name is duplicated: $name"
            )
        }
        $exportNames.Add($name)
    }
    $exportNames.Sort([StringComparer]::Ordinal)
    return @($exportNames)
}

function Get-PeMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    [byte[]] $bytes = [IO.File]::ReadAllBytes($resolved)
    if ($bytes.LongLength -lt 64 -or (Read-UInt16At $bytes 0) -ne 0x5A4D) {
        throw [IO.InvalidDataException]::new("Not a PE file: $resolved")
    }

    $peOffset = [int64](Read-UInt32At $bytes 0x3C)
    if ((Read-UInt32At $bytes $peOffset) -ne 0x00004550) {
        throw [IO.InvalidDataException]::new("Invalid PE signature: $resolved")
    }

    $coffOffset = $peOffset + 4
    $machine = Read-UInt16At $bytes $coffOffset
    $architecture = switch ($machine) {
        0x014C { 'X86' }
        0x8664 { 'X64' }
        default {
            throw [IO.InvalidDataException]::new(
                "Unsupported PE machine 0x$($machine.ToString('X4')): $resolved"
            )
        }
    }

    $sectionCount = Read-UInt16At $bytes ($coffOffset + 2)
    if ($sectionCount -lt 1 -or $sectionCount -gt $script:MaximumSectionCount) {
        throw [IO.InvalidDataException]::new(
            "Invalid PE section count $sectionCount`: $resolved"
        )
    }

    $optionalHeaderSize = Read-UInt16At $bytes ($coffOffset + 16)
    $optionalOffset = $coffOffset + 20
    Assert-PeRange $optionalOffset $optionalHeaderSize $bytes.LongLength `
        "PE optional header"
    $optionalMagic = Read-UInt16At $bytes $optionalOffset
    $directoryLayout = switch ($optionalMagic) {
        0x010B {
            [pscustomobject]@{
                MinimumSize = 96
                NumberOfDirectoriesOffset = 92
                DataDirectoryOffset = 96
            }
        }
        0x020B {
            [pscustomobject]@{
                MinimumSize = 112
                NumberOfDirectoriesOffset = 108
                DataDirectoryOffset = 112
            }
        }
        default {
            throw [IO.InvalidDataException]::new(
                "Unsupported PE optional-header magic: $resolved"
            )
        }
    }
    if ($optionalHeaderSize -lt $directoryLayout.MinimumSize) {
        throw [IO.InvalidDataException]::new(
            "PE optional header is truncated: $resolved"
        )
    }

    $sizeOfHeaders = Read-UInt32At $bytes ($optionalOffset + 60)
    $numberOfDirectories = Read-UInt32At $bytes (
        $optionalOffset + $directoryLayout.NumberOfDirectoriesOffset
    )
    $availableDirectories = [Math]::Floor(
        ($optionalHeaderSize - $directoryLayout.DataDirectoryOffset) / 8
    )
    if ($numberOfDirectories -gt $availableDirectories) {
        throw [IO.InvalidDataException]::new(
            "PE optional header declares truncated data directories: $resolved"
        )
    }
    $exportRva = [uint32]0
    $exportSize = [uint32]0
    if ($numberOfDirectories -gt 0) {
        $dataDirectoryOffset = $optionalOffset + $directoryLayout.DataDirectoryOffset
        if (($dataDirectoryOffset + 8) -gt ($optionalOffset + $optionalHeaderSize)) {
            throw [IO.InvalidDataException]::new(
                "PE optional header has a truncated export directory: $resolved"
            )
        }
        $exportRva = Read-UInt32At $bytes $dataDirectoryOffset
        $exportSize = Read-UInt32At $bytes ($dataDirectoryOffset + 4)
    }

    $sectionOffset = $optionalOffset + $optionalHeaderSize
    $sectionTableSize = [int64]$sectionCount * 40
    Assert-PeRange $sectionOffset $sectionTableSize $bytes.LongLength `
        "PE section table"
    $sectionTableEnd = $sectionOffset + $sectionTableSize
    if ($sizeOfHeaders -lt $sectionTableEnd -or
        $sizeOfHeaders -gt $bytes.LongLength) {
        throw [IO.InvalidDataException]::new(
            "PE SizeOfHeaders does not contain the header tables: $resolved"
        )
    }
    $sections = @(
        for ($index = 0; $index -lt $sectionCount; $index++) {
            $offset = $sectionOffset + 40 * $index
            $rawSize = Read-UInt32At $bytes ($offset + 16)
            $rawPointer = Read-UInt32At $bytes ($offset + 20)
            if ($rawSize -gt 0) {
                Assert-PeRange $rawPointer $rawSize $bytes.LongLength `
                    "PE section $index raw data"
                if ($rawPointer -lt $sizeOfHeaders) {
                    throw [IO.InvalidDataException]::new(
                        "PE section $index overlaps the headers: $resolved"
                    )
                }
            }
            [pscustomobject]@{
                Index = $index
                VirtualSize = Read-UInt32At $bytes ($offset + 8)
                VirtualAddress = Read-UInt32At $bytes ($offset + 12)
                RawSize = $rawSize
                RawPointer = $rawPointer
            }
        }
    )
    Assert-PeSectionsDoNotOverlap -Sections $sections -Path $resolved

    $exportNames = Get-PeExportNames `
        -Bytes $bytes `
        -Sections $sections `
        -SizeOfHeaders $sizeOfHeaders `
        -ExportRva $exportRva `
        -ExportSize $exportSize `
        -Path $resolved

    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($resolved)
    $peVersion = $null
    if (-not [string]::IsNullOrWhiteSpace($versionInfo.FileVersion) -and
        $versionInfo.FileMajorPart -ge 0 -and
        $versionInfo.FileMinorPart -ge 0 -and
        $versionInfo.FileBuildPart -ge 0 -and
        $versionInfo.FilePrivatePart -ge 0) {
        $peVersion = "$($versionInfo.FileMajorPart).$($versionInfo.FileMinorPart).$($versionInfo.FileBuildPart).$($versionInfo.FilePrivatePart)"
    }

    return [ordered]@{
        architecture = $architecture
        pe_version = $peVersion
        pe_named_exports = @($exportNames)
    }
}

Export-ModuleMember -Function Get-PeMetadata

Set-StrictMode -Version Latest

$script:PeLimits = [pscustomobject]@{
    MaximumExportNames          = 16384
    MaximumExportFunctions      = 65536
    MaximumExportNameBytes      = 256
    MaximumSectionCount         = 96
    MaximumImportDescriptors    = 4096
    MaximumImportNameBytes      = 256
    MaximumImportDirectoryBytes = 16MB
}

$script:PeConstants = [pscustomobject]@{
    DosHeaderMinimumSize = 64
    DosSignature         = [uint16]0x5A4D
    PeSignature          = [uint32]0x00004550
    CoffHeaderSize       = 20
    SectionHeaderSize    = 40
    ExportDirectorySize  = 40
    RvaAddressSpaceSize  = [uint64]4294967296
}

function Assert-PeFileRange {
    param(
        [Parameter(Mandatory)]
        [int64] $Offset,

        [Parameter(Mandatory)]
        [int64] $Size,

        [Parameter(Mandatory)]
        [int64] $FileLength,

        [Parameter(Mandatory)]
        [string] $Description
    )

    $isOutsideFile =
    $Offset -lt 0 -or
    $Size -lt 0 -or
    $Offset -gt $FileLength -or
    $Size -gt ($FileLength - $Offset)

    if ($isOutsideFile) {
        throw [IO.InvalidDataException]::new(
            "$Description is outside the PE file"
        )
    }
}

function Read-PeUnsignedInteger {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset,

        [Parameter(Mandatory)]
        [ValidateSet(2, 4, 8)]
        [int] $ByteCount
    )

    Assert-PeFileRange `
        -Offset $Offset `
        -Size $ByteCount `
        -FileLength $Bytes.LongLength `
        -Description "$($ByteCount * 8)-bit read at offset $Offset"

    $start = [int]$Offset
    [uint64] $value = 0

    for ($index = 0; $index -lt $ByteCount; $index++) {
        $value = $value -bor (
            [uint64]$Bytes[$start + $index] -shl (8 * $index)
        )
    }

    return $value
}

function Read-PeUInt16 {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset
    )

    return [uint16](Read-PeUnsignedInteger `
            -Bytes $Bytes `
            -Offset $Offset `
            -ByteCount 2)
}

function Read-PeUInt32 {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset
    )

    return [uint32](Read-PeUnsignedInteger `
            -Bytes $Bytes `
            -Offset $Offset `
            -ByteCount 4)
}

function Read-PeUInt64 {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset
    )

    return [uint64](Read-PeUnsignedInteger `
            -Bytes $Bytes `
            -Offset $Offset `
            -ByteCount 8)
}

function Read-PeAsciiString {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65536)]
        [int] $MaximumByteCount,

        [Parameter(Mandatory)]
        [string] $Description,

        [byte] $MinimumByte = 0x20,

        [byte] $MaximumByte = 0x7E
    )

    Assert-PeFileRange `
        -Offset $Offset `
        -Size 1 `
        -FileLength $Bytes.LongLength `
        -Description $Description

    for ($length = 0; $length -le $MaximumByteCount; $length++) {
        $position = $Offset + $length
        if ($position -ge $Bytes.LongLength) {
            throw [IO.InvalidDataException]::new(
                "$Description is not terminated inside the PE file"
            )
        }

        $value = $Bytes[[int]$position]
        if ($value -eq 0) {
            if ($length -eq 0) {
                throw [IO.InvalidDataException]::new("$Description is empty")
            }

            return [Text.Encoding]::ASCII.GetString(
                $Bytes,
                [int]$Offset,
                $length
            )
        }

        if ($value -lt $MinimumByte -or $value -gt $MaximumByte) {
            throw [IO.InvalidDataException]::new(
                "$Description contains invalid ASCII"
            )
        }
    }

    throw [IO.InvalidDataException]::new(
        "$Description exceeds $MaximumByteCount bytes"
    )
}

function Test-PeByteRangeIsZero {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset,

        [Parameter(Mandatory)]
        [ValidateRange(1, 1024)]
        [int] $Size
    )

    Assert-PeFileRange `
        -Offset $Offset `
        -Size $Size `
        -FileLength $Bytes.LongLength `
        -Description "PE byte range"

    for ($index = 0; $index -lt $Size; $index++) {
        if ($Bytes[[int]($Offset + $index)] -ne 0) {
            return $false
        }
    }

    return $true
}

function Get-PeRvaRangeEnd {
    param(
        [Parameter(Mandatory)]
        [uint32] $Rva,

        [Parameter(Mandatory)]
        [uint32] $Size,

        [Parameter(Mandatory)]
        [string] $Description
    )

    if ($Size -eq 0) {
        throw [IO.InvalidDataException]::new("$Description is empty")
    }

    $end = [uint64]$Rva + [uint64]$Size
    if ($end -gt $script:PeConstants.RvaAddressSpaceSize) {
        throw [IO.InvalidDataException]::new(
            "$Description RVA range overflows"
        )
    }

    return $end
}

function Find-PeRawMapping {
    param(
        [Parameter(Mandatory)]
        [uint64] $Rva,

        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [int64] $FileLength
    )

    if ($Rva -lt [uint64]$SizeOfHeaders) {
        if ($Rva -ge [uint64]$FileLength) {
            return $null
        }

        return [pscustomobject]@{
            RvaStart  = [uint64]0
            RvaEnd    = [uint64]$SizeOfHeaders
            FileStart = [uint64]0
        }
    }

    foreach ($section in $Sections) {
        $virtualStart = [uint64]$section.VirtualAddress
        $rawEnd = $virtualStart + [uint64]$section.RawSize

        if ($Rva -ge $virtualStart -and $Rva -lt $rawEnd) {
            return [pscustomobject]@{
                RvaStart  = $virtualStart
                RvaEnd    = $rawEnd
                FileStart = [uint64]$section.RawPointer
            }
        }

        if ($Rva -ge $virtualStart -and $Rva -lt [uint64]$section.VirtualEnd) {
            throw [IO.InvalidDataException]::new(
                "PE RVA 0x$(([uint32]$Rva).ToString('X8')) points outside section raw data"
            )
        }
    }

    return $null
}

function Convert-PeRvaRangeToFileOffset {
    param(
        [Parameter(Mandatory)]
        [uint32] $Rva,

        [Parameter(Mandatory)]
        [uint32] $Size,

        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [int64] $FileLength,

        [Parameter(Mandatory)]
        [string] $Description
    )

    $rangeEnd = Get-PeRvaRangeEnd `
        -Rva $Rva `
        -Size $Size `
        -Description $Description

    [uint64] $cursor = $Rva
    [uint64] $firstFileOffset = 0
    [uint64] $expectedFileOffset = 0
    $hasFirstMapping = $false

    while ($cursor -lt $rangeEnd) {
        $mapping = Find-PeRawMapping `
            -Rva $cursor `
            -Sections $Sections `
            -SizeOfHeaders $SizeOfHeaders `
            -FileLength $FileLength

        if ($null -eq $mapping) {
            throw [IO.InvalidDataException]::new(
                "$Description is not fully mapped by the PE file"
            )
        }

        $fileOffset =
        [uint64]$mapping.FileStart +
        ($cursor - [uint64]$mapping.RvaStart)

        if (-not $hasFirstMapping) {
            $firstFileOffset = $fileOffset
            $expectedFileOffset = $fileOffset
            $hasFirstMapping = $true
        }

        if ($fileOffset -ne $expectedFileOffset) {
            throw [IO.InvalidDataException]::new(
                "$Description is not contiguous in the PE file"
            )
        }

        $mappingEnd = [Math]::Min(
            [uint64]$mapping.RvaEnd,
            $rangeEnd
        )
        $mappedByteCount = $mappingEnd - $cursor
        if ($mappedByteCount -eq 0) {
            throw [IO.InvalidDataException]::new(
                "$Description has an invalid PE mapping"
            )
        }

        $cursor = $mappingEnd
        $expectedFileOffset += $mappedByteCount
    }

    if ($firstFileOffset -gt [uint64][int64]::MaxValue) {
        throw [IO.InvalidDataException]::new(
            "$Description file offset is too large"
        )
    }

    Assert-PeFileRange `
        -Offset ([int64]$firstFileOffset) `
        -Size $Size `
        -FileLength $FileLength `
        -Description $Description

    return [int64]$firstFileOffset
}

function Convert-PeRvaToFileOffset {
    param(
        [Parameter(Mandatory)]
        [uint32] $Rva,

        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [int64] $FileLength,

        [string] $Description = 'PE RVA'
    )

    return Convert-PeRvaRangeToFileOffset `
        -Rva $Rva `
        -Size 1 `
        -Sections $Sections `
        -SizeOfHeaders $SizeOfHeaders `
        -FileLength $FileLength `
        -Description $Description
}

function Test-PeRangesOverlap {
    param(
        [Parameter(Mandatory)]
        [uint64] $LeftStart,

        [Parameter(Mandatory)]
        [uint64] $LeftEnd,

        [Parameter(Mandatory)]
        [uint64] $RightStart,

        [Parameter(Mandatory)]
        [uint64] $RightEnd
    )

    return $LeftStart -lt $RightEnd -and $RightStart -lt $LeftEnd
}

function Assert-PeSectionsDoNotOverlap {
    param(
        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
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
                $rawRangesOverlap = Test-PeRangesOverlap `
                    -LeftStart ([uint64]$left.RawPointer) `
                    -LeftEnd ([uint64]$left.RawEnd) `
                    -RightStart ([uint64]$right.RawPointer) `
                    -RightEnd ([uint64]$right.RawEnd)

                if ($rawRangesOverlap) {
                    throw [IO.InvalidDataException]::new(
                        "PE sections $($left.Index) and $($right.Index) have overlapping raw data: $Path"
                    )
                }
            }

            if ($left.VirtualSpan -eq 0 -or $right.VirtualSpan -eq 0) {
                continue
            }

            $virtualRangesOverlap = Test-PeRangesOverlap `
                -LeftStart ([uint64]$left.VirtualAddress) `
                -LeftEnd ([uint64]$left.VirtualEnd) `
                -RightStart ([uint64]$right.VirtualAddress) `
                -RightEnd ([uint64]$right.VirtualEnd)

            if ($virtualRangesOverlap) {
                throw [IO.InvalidDataException]::new(
                    "PE sections $($left.Index) and $($right.Index) have overlapping RVA ranges: $Path"
                )
            }
        }
    }
}

function Get-PeArchitecture {
    param(
        [Parameter(Mandatory)]
        [uint16] $Machine,

        [Parameter(Mandatory)]
        [string] $Path
    )

    switch ($Machine) {
        0x014C { return 'X86' }
        0x8664 { return 'X64' }
        default {
            throw [IO.InvalidDataException]::new(
                "Unsupported PE machine 0x$($Machine.ToString('X4')): $Path"
            )
        }
    }
}

function Read-PeOptionalHeader {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $Offset,

        [Parameter(Mandatory)]
        [uint16] $Size,

        [Parameter(Mandatory)]
        [uint16] $Machine,

        [Parameter(Mandatory)]
        [string] $Path
    )

    Assert-PeFileRange `
        -Offset $Offset `
        -Size $Size `
        -FileLength $Bytes.LongLength `
        -Description "PE optional header"

    $magic = Read-PeUInt16 -Bytes $Bytes -Offset $Offset
    $layout = switch ($magic) {
        0x010B {
            [pscustomobject]@{
                MinimumSize               = 96
                NumberOfDirectoriesOffset = 92
                DataDirectoryOffset       = 96
                ImageBaseOffset           = 28
                ImageBaseSize             = 4
            }
        }
        0x020B {
            [pscustomobject]@{
                MinimumSize               = 112
                NumberOfDirectoriesOffset = 108
                DataDirectoryOffset       = 112
                ImageBaseOffset           = 24
                ImageBaseSize             = 8
            }
        }
        default {
            throw [IO.InvalidDataException]::new(
                "Unsupported PE optional-header magic 0x$($magic.ToString('X4')): $Path"
            )
        }
    }

    $machineAndMagicMatch =
    ($Machine -eq 0x014C -and $magic -eq 0x010B) -or
    ($Machine -eq 0x8664 -and $magic -eq 0x020B)

    if (-not $machineAndMagicMatch) {
        throw [IO.InvalidDataException]::new(
            "PE machine and optional-header format do not match: $Path"
        )
    }

    if ($Size -lt $layout.MinimumSize) {
        throw [IO.InvalidDataException]::new(
            "PE optional header is truncated: $Path"
        )
    }

    $sizeOfHeaders = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($Offset + 60)
    $dllCharacteristics = Read-PeUInt16 `
        -Bytes $Bytes `
        -Offset ($Offset + 70)

    $imageBase = if ($layout.ImageBaseSize -eq 8) {
        Read-PeUInt64 `
            -Bytes $Bytes `
            -Offset ($Offset + $layout.ImageBaseOffset)
    }
    else {
        [uint64](Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset ($Offset + $layout.ImageBaseOffset))
    }

    $numberOfDirectories = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($Offset + $layout.NumberOfDirectoriesOffset)

    $availableDirectoryBytes =
    [int64]$Size -
    [int64]$layout.DataDirectoryOffset
    $availableDirectories = [uint32][Math]::Floor(
        [double]$availableDirectoryBytes / 8
    )

    if ($numberOfDirectories -gt $availableDirectories) {
        throw [IO.InvalidDataException]::new(
            "PE optional header declares truncated data directories: $Path"
        )
    }

    return [pscustomobject]@{
        Magic               = $magic
        SizeOfHeaders       = $sizeOfHeaders
        DllCharacteristics  = $dllCharacteristics
        ImageBase           = $imageBase
        NumberOfDirectories = $numberOfDirectories
        DataDirectoryOffset = $Offset + $layout.DataDirectoryOffset
    }
}

function Get-PeDataDirectory {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $DataDirectoryOffset,

        [Parameter(Mandatory)]
        [uint32] $DirectoryCount,

        [Parameter(Mandatory)]
        [ValidateRange(0, 255)]
        [int] $Index
    )

    if ([uint32]$Index -ge $DirectoryCount) {
        return [pscustomobject]@{
            Rva  = [uint32]0
            Size = [uint32]0
        }
    }

    $offset = $DataDirectoryOffset + 8 * $Index
    return [pscustomobject]@{
        Rva  = Read-PeUInt32 -Bytes $Bytes -Offset $offset
        Size = Read-PeUInt32 -Bytes $Bytes -Offset ($offset + 4)
    }
}

function Read-PeSections {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int64] $SectionTableOffset,

        [Parameter(Mandatory)]
        [uint16] $SectionCount,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $sectionTableSize =
    [int64]$SectionCount *
    $script:PeConstants.SectionHeaderSize

    Assert-PeFileRange `
        -Offset $SectionTableOffset `
        -Size $sectionTableSize `
        -FileLength $Bytes.LongLength `
        -Description "PE section table"

    $sectionTableEnd = $SectionTableOffset + $sectionTableSize
    if (
        $SizeOfHeaders -lt $sectionTableEnd -or
        $SizeOfHeaders -gt $Bytes.LongLength
    ) {
        throw [IO.InvalidDataException]::new(
            "PE SizeOfHeaders does not contain the header tables: $Path"
        )
    }

    $sections = @(
        for ($index = 0; $index -lt $SectionCount; $index++) {
            $offset =
            $SectionTableOffset +
            $script:PeConstants.SectionHeaderSize * $index

            $virtualSize = Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset ($offset + 8)
            $virtualAddress = Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset ($offset + 12)
            $rawSize = Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset ($offset + 16)
            $rawPointer = Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset ($offset + 20)

            $virtualSpan = [Math]::Max(
                [uint64]$virtualSize,
                [uint64]$rawSize
            )
            $virtualEnd = [uint64]$virtualAddress + $virtualSpan
            if (
                $virtualEnd -gt
                $script:PeConstants.RvaAddressSpaceSize
            ) {
                throw [IO.InvalidDataException]::new(
                    "PE section $index RVA range overflows: $Path"
                )
            }

            if (
                $virtualSpan -gt 0 -and
                $virtualAddress -lt $SizeOfHeaders
            ) {
                throw [IO.InvalidDataException]::new(
                    "PE section $index overlaps the header RVA range: $Path"
                )
            }

            $rawEnd = [uint64]$rawPointer + [uint64]$rawSize
            if ($rawSize -gt 0) {
                Assert-PeFileRange `
                    -Offset $rawPointer `
                    -Size $rawSize `
                    -FileLength $Bytes.LongLength `
                    -Description "PE section $index raw data"

                if ($rawPointer -lt $SizeOfHeaders) {
                    throw [IO.InvalidDataException]::new(
                        "PE section $index overlaps the file headers: $Path"
                    )
                }
            }

            [pscustomobject]@{
                Index          = $index
                VirtualSize    = $virtualSize
                VirtualAddress = $virtualAddress
                VirtualSpan    = $virtualSpan
                VirtualEnd     = $virtualEnd
                RawSize        = $rawSize
                RawPointer     = $rawPointer
                RawEnd         = $rawEnd
            }
        }
    )

    Assert-PeSectionsDoNotOverlap `
        -Sections $sections `
        -Path $Path

    return $sections
}

function Get-PeExportNames {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [uint32] $DirectoryRva,

        [Parameter(Mandatory)]
        [uint32] $DirectorySize,

        [Parameter(Mandatory)]
        [string] $Path
    )

    if ($DirectoryRva -eq 0 -and $DirectorySize -eq 0) {
        return @()
    }

    if (
        $DirectoryRva -eq 0 -or
        $DirectorySize -lt $script:PeConstants.ExportDirectorySize
    ) {
        throw [IO.InvalidDataException]::new(
            "Malformed PE export directory: $Path"
        )
    }

    $directoryOffset = Convert-PeRvaRangeToFileOffset `
        -Rva $DirectoryRva `
        -Size $DirectorySize `
        -Sections $Sections `
        -SizeOfHeaders $SizeOfHeaders `
        -FileLength $Bytes.LongLength `
        -Description "PE export directory"

    $functionCount = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($directoryOffset + 20)
    $nameCount = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($directoryOffset + 24)

    if ($functionCount -gt $script:PeLimits.MaximumExportFunctions) {
        throw [IO.InvalidDataException]::new(
            "PE export function count $functionCount exceeds $($script:PeLimits.MaximumExportFunctions): $Path"
        )
    }

    if (
        $nameCount -gt $script:PeLimits.MaximumExportNames -or
        $nameCount -gt $functionCount
    ) {
        throw [IO.InvalidDataException]::new(
            "PE export name count $nameCount is invalid: $Path"
        )
    }

    if ($nameCount -eq 0) {
        return @()
    }

    $functionsRva = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($directoryOffset + 28)
    $namesRva = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($directoryOffset + 32)
    $ordinalsRva = Read-PeUInt32 `
        -Bytes $Bytes `
        -Offset ($directoryOffset + 36)

    if (
        $functionsRva -eq 0 -or
        $namesRva -eq 0 -or
        $ordinalsRva -eq 0
    ) {
        throw [IO.InvalidDataException]::new(
            "PE export address, name, or ordinal table is missing: $Path"
        )
    }

    [void](Convert-PeRvaRangeToFileOffset `
            -Rva $functionsRva `
            -Size ([uint32]([uint64]$functionCount * 4)) `
            -Sections $Sections `
            -SizeOfHeaders $SizeOfHeaders `
            -FileLength $Bytes.LongLength `
            -Description "PE export address table")

    $namesOffset = Convert-PeRvaRangeToFileOffset `
        -Rva $namesRva `
        -Size ([uint32]([uint64]$nameCount * 4)) `
        -Sections $Sections `
        -SizeOfHeaders $SizeOfHeaders `
        -FileLength $Bytes.LongLength `
        -Description "PE export name pointer table"

    $ordinalsOffset = Convert-PeRvaRangeToFileOffset `
        -Rva $ordinalsRva `
        -Size ([uint32]([uint64]$nameCount * 2)) `
        -Sections $Sections `
        -SizeOfHeaders $SizeOfHeaders `
        -FileLength $Bytes.LongLength `
        -Description "PE export ordinal table"

    $names = [Collections.Generic.List[string]]::new()
    $seenNames = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )

    for ($index = 0; $index -lt $nameCount; $index++) {
        $ordinal = Read-PeUInt16 `
            -Bytes $Bytes `
            -Offset ($ordinalsOffset + 2 * $index)

        if ($ordinal -ge $functionCount) {
            throw [IO.InvalidDataException]::new(
                "PE export ordinal $ordinal is outside the function table: $Path"
            )
        }

        $nameRva = Read-PeUInt32 `
            -Bytes $Bytes `
            -Offset ($namesOffset + 4 * $index)

        if ($nameRva -eq 0) {
            throw [IO.InvalidDataException]::new(
                "PE export name RVA is zero: $Path"
            )
        }

        $nameOffset = Convert-PeRvaToFileOffset `
            -Rva $nameRva `
            -Sections $Sections `
            -SizeOfHeaders $SizeOfHeaders `
            -FileLength $Bytes.LongLength `
            -Description "PE export name"

        $name = Read-PeAsciiString `
            -Bytes $Bytes `
            -Offset $nameOffset `
            -MaximumByteCount $script:PeLimits.MaximumExportNameBytes `
            -Description "PE export name"

        if (-not $seenNames.Add($name)) {
            throw [IO.InvalidDataException]::new(
                "PE export name '$name' is duplicated: $Path"
            )
        }

        $names.Add($name)
    }

    $names.Sort([StringComparer]::Ordinal)
    return @($names)
}

function Get-PeImportNames {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [object[]] $Sections,

        [Parameter(Mandatory)]
        [uint32] $SizeOfHeaders,

        [Parameter(Mandatory)]
        [uint32] $DirectoryRva,

        [Parameter(Mandatory)]
        [uint32] $DirectorySize,

        [Parameter(Mandatory)]
        [ValidateSet(20, 32)]
        [int] $DescriptorSize,

        [Parameter(Mandatory)]
        [ValidateSet(4, 12)]
        [int] $NameOffset,

        [Parameter(Mandatory)]
        [uint64] $ImageBase,

        [Parameter(Mandatory)]
        [bool] $IsDelayImport,

        [Parameter(Mandatory)]
        [string] $Path
    )

    if ($DirectoryRva -eq 0 -and $DirectorySize -eq 0) {
        return @()
    }

    if (
        $DirectoryRva -eq 0 -or
        $DirectorySize -lt $DescriptorSize -or
        $DirectorySize -gt $script:PeLimits.MaximumImportDirectoryBytes
    ) {
        throw [IO.InvalidDataException]::new(
            "Malformed PE import directory: $Path"
        )
    }

    $directoryOffset = Convert-PeRvaRangeToFileOffset `
        -Rva $DirectoryRva `
        -Size $DirectorySize `
        -Sections $Sections `
        -SizeOfHeaders $SizeOfHeaders `
        -FileLength $Bytes.LongLength `
        -Description "PE import directory"

    $descriptorsInDirectory = [int][Math]::Floor(
        [double]$DirectorySize / $DescriptorSize
    )
    $descriptorLimit = [Math]::Min(
        $descriptorsInDirectory,
        $script:PeLimits.MaximumImportDescriptors + 1
    )

    $names = [Collections.Generic.List[string]]::new()
    $seenNames = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    $hasTerminator = $false

    for ($index = 0; $index -lt $descriptorLimit; $index++) {
        $descriptorOffset =
        $directoryOffset +
        $index * $DescriptorSize

        if (Test-PeByteRangeIsZero `
                -Bytes $Bytes `
                -Offset $descriptorOffset `
                -Size $DescriptorSize) {
            $hasTerminator = $true
            break
        }

        if ($names.Count -ge $script:PeLimits.MaximumImportDescriptors) {
            throw [IO.InvalidDataException]::new(
                "Too many PE imports: $Path"
            )
        }

        [uint64] $nameRva = Read-PeUInt32 `
            -Bytes $Bytes `
            -Offset ($descriptorOffset + $NameOffset)

        if ($nameRva -eq 0) {
            throw [IO.InvalidDataException]::new(
                "PE import name pointer is zero: $Path"
            )
        }

        if ($IsDelayImport) {
            $attributes = Read-PeUInt32 `
                -Bytes $Bytes `
                -Offset $descriptorOffset

            if (($attributes -band 0xFFFFFFFE) -ne 0) {
                throw [IO.InvalidDataException]::new(
                    "Unsupported delay-import attributes: $Path"
                )
            }

            $usesRva = ($attributes -band 1) -ne 0
            if (-not $usesRva) {
                if (
                    $nameRva -lt $ImageBase -or
                    ($nameRva - $ImageBase) -gt [uint32]::MaxValue
                ) {
                    throw [IO.InvalidDataException]::new(
                        "Invalid delay-import VA: $Path"
                    )
                }

                $nameRva -= $ImageBase
            }
        }

        $nameFileOffset = Convert-PeRvaToFileOffset `
            -Rva ([uint32]$nameRva) `
            -Sections $Sections `
            -SizeOfHeaders $SizeOfHeaders `
            -FileLength $Bytes.LongLength `
            -Description "PE import name"

        $name = (
            Read-PeAsciiString `
                -Bytes $Bytes `
                -Offset $nameFileOffset `
                -MaximumByteCount $script:PeLimits.MaximumImportNameBytes `
                -Description "PE import name"
        ).ToLowerInvariant()

        if (
            $name -notmatch '^[a-z0-9._-]+\.dll$' -or
            $name.Contains('..')
        ) {
            throw [IO.InvalidDataException]::new(
                "Unsafe PE import name '$name': $Path"
            )
        }

        if (-not $seenNames.Add($name)) {
            throw [IO.InvalidDataException]::new(
                "Duplicate PE import name '$name': $Path"
            )
        }

        $names.Add($name)
    }

    if (-not $hasTerminator) {
        throw [IO.InvalidDataException]::new(
            "PE import directory has no terminator: $Path"
        )
    }

    $names.Sort([StringComparer]::Ordinal)
    return @($names)
}

function Get-PeFileVersion {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    if (
        [string]::IsNullOrWhiteSpace($versionInfo.FileVersion) -or
        $versionInfo.FileMajorPart -lt 0 -or
        $versionInfo.FileMinorPart -lt 0 -or
        $versionInfo.FileBuildPart -lt 0 -or
        $versionInfo.FilePrivatePart -lt 0
    ) {
        return $null
    }

    return (
        '{0}.{1}.{2}.{3}' -f
        $versionInfo.FileMajorPart,
        $versionInfo.FileMinorPart,
        $versionInfo.FileBuildPart,
        $versionInfo.FilePrivatePart
    )
}

function Resolve-PeFilePath {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (
        $item.PSProvider.Name -ne 'FileSystem' -or
        $item.PSIsContainer
    ) {
        throw [IO.FileNotFoundException]::new(
            "PE path is not a file: $Path"
        )
    }

    return $item.FullName
}

function Get-PeMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $resolvedPath = Resolve-PeFilePath -Path $Path
    [byte[]] $bytes = [IO.File]::ReadAllBytes($resolvedPath)

    if (
        $bytes.LongLength -lt $script:PeConstants.DosHeaderMinimumSize -or
        (Read-PeUInt16 -Bytes $bytes -Offset 0) -ne
        $script:PeConstants.DosSignature
    ) {
        throw [IO.InvalidDataException]::new(
            "Not a PE file: $resolvedPath"
        )
    }

    $peOffset = [int64](Read-PeUInt32 -Bytes $bytes -Offset 0x3C)
    Assert-PeFileRange `
        -Offset $peOffset `
        -Size (4 + $script:PeConstants.CoffHeaderSize) `
        -FileLength $bytes.LongLength `
        -Description "PE signature and COFF header"

    if (
        (Read-PeUInt32 -Bytes $bytes -Offset $peOffset) -ne
        $script:PeConstants.PeSignature
    ) {
        throw [IO.InvalidDataException]::new(
            "Invalid PE signature: $resolvedPath"
        )
    }

    $coffOffset = $peOffset + 4
    $machine = Read-PeUInt16 `
        -Bytes $bytes `
        -Offset $coffOffset
    $architecture = Get-PeArchitecture `
        -Machine $machine `
        -Path $resolvedPath

    $sectionCount = Read-PeUInt16 `
        -Bytes $bytes `
        -Offset ($coffOffset + 2)

    if (
        $sectionCount -lt 1 -or
        $sectionCount -gt $script:PeLimits.MaximumSectionCount
    ) {
        throw [IO.InvalidDataException]::new(
            "Invalid PE section count ${sectionCount}: $resolvedPath"
        )
    }

    $optionalHeaderSize = Read-PeUInt16 `
        -Bytes $bytes `
        -Offset ($coffOffset + 16)
    $optionalHeaderOffset =
    $coffOffset +
    $script:PeConstants.CoffHeaderSize

    $optionalHeader = Read-PeOptionalHeader `
        -Bytes $bytes `
        -Offset $optionalHeaderOffset `
        -Size $optionalHeaderSize `
        -Machine $machine `
        -Path $resolvedPath

    $sections = Read-PeSections `
        -Bytes $bytes `
        -SectionTableOffset (
        $optionalHeaderOffset +
        $optionalHeaderSize
    ) `
        -SectionCount $sectionCount `
        -SizeOfHeaders $optionalHeader.SizeOfHeaders `
        -Path $resolvedPath

    $exportDirectory = Get-PeDataDirectory `
        -Bytes $bytes `
        -DataDirectoryOffset $optionalHeader.DataDirectoryOffset `
        -DirectoryCount $optionalHeader.NumberOfDirectories `
        -Index 0

    $importDirectory = Get-PeDataDirectory `
        -Bytes $bytes `
        -DataDirectoryOffset $optionalHeader.DataDirectoryOffset `
        -DirectoryCount $optionalHeader.NumberOfDirectories `
        -Index 1

    $delayImportDirectory = Get-PeDataDirectory `
        -Bytes $bytes `
        -DataDirectoryOffset $optionalHeader.DataDirectoryOffset `
        -DirectoryCount $optionalHeader.NumberOfDirectories `
        -Index 13

    $exportNames = Get-PeExportNames `
        -Bytes $bytes `
        -Sections $sections `
        -SizeOfHeaders $optionalHeader.SizeOfHeaders `
        -DirectoryRva $exportDirectory.Rva `
        -DirectorySize $exportDirectory.Size `
        -Path $resolvedPath

    $regularImports = Get-PeImportNames `
        -Bytes $bytes `
        -Sections $sections `
        -SizeOfHeaders $optionalHeader.SizeOfHeaders `
        -DirectoryRva $importDirectory.Rva `
        -DirectorySize $importDirectory.Size `
        -DescriptorSize 20 `
        -NameOffset 12 `
        -ImageBase $optionalHeader.ImageBase `
        -IsDelayImport $false `
        -Path $resolvedPath

    $delayImports = Get-PeImportNames `
        -Bytes $bytes `
        -Sections $sections `
        -SizeOfHeaders $optionalHeader.SizeOfHeaders `
        -DirectoryRva $delayImportDirectory.Rva `
        -DirectorySize $delayImportDirectory.Size `
        -DescriptorSize 32 `
        -NameOffset 4 `
        -ImageBase $optionalHeader.ImageBase `
        -IsDelayImport $true `
        -Path $resolvedPath

    return [ordered]@{
        architecture     = $architecture
        pe_version       = Get-PeFileVersion -Path $resolvedPath
        pe_named_exports = @($exportNames)
        pe_imports       = [ordered]@{
            regular = @($regularImports)
            delay   = @($delayImports)
        }
        pe_security      = [ordered]@{
            high_entropy_va = (
                $optionalHeader.DllCharacteristics -band 0x0020
            ) -ne 0
            dynamic_base    = (
                $optionalHeader.DllCharacteristics -band 0x0040
            ) -ne 0
            nx_compat       = (
                $optionalHeader.DllCharacteristics -band 0x0100
            ) -ne 0
            guard_cf        = (
                $optionalHeader.DllCharacteristics -band 0x4000
            ) -ne 0
        }
    }
}

Export-ModuleMember -Function Get-PeMetadata

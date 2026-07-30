[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$modulePath = [IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '../lib/pe-inspector.psm1')
)
if (-not [IO.File]::Exists($modulePath)) {
    throw "PE inspector module does not exist: $modulePath"
}

[System.Management.Automation.PSModuleInfo] $peInspectorModule = Import-Module `
    -Name $modulePath `
    -Force `
    -PassThru `
    -ErrorAction Stop

& $peInspectorModule {
    # Run in a child scope: private module functions remain visible, while test helpers
    # disappear as soon as the test suite finishes.
    & {
        function Assert-Throws(
            [scriptblock] $Action,
            [string] $Description
        ) {
            try {
                $null = & $Action
            }
            catch {
                return
            }

            throw "Expected PE boundary failure: $Description"
        }

        function Assert-Equal(
            $Actual,
            $Expected,
            [string] $Description
        ) {
            if ($Actual -ne $Expected) {
                throw "$Description. Expected '$Expected', got '$Actual'."
            }
        }

        function Assert-SingleValue(
            [object[]] $Actual,
            $Expected,
            [string] $Description
        ) {
            if ($Actual.Count -eq 1 -and $Actual[0] -eq $Expected) {
                return
            }

            throw "$Description. Expected ['$Expected'], got [$($Actual -join ', ')]."
        }

        function Assert-OneOf(
            $Actual,
            [object[]] $Expected,
            [string] $Description
        ) {
            if ($Expected -notcontains $Actual) {
                throw "$Description. Expected one of [$($Expected -join ', ')], got '$Actual'."
            }
        }

        function Set-UInt16LittleEndian(
            [byte[]] $Bytes,
            [int] $Offset,
            [uint16] $Value
        ) {
            $Bytes[$Offset] = [byte]($Value -band 0xFF)
            $Bytes[$Offset + 1] = [byte](($Value -shr 8) -band 0xFF)
        }

        function Set-UInt32LittleEndian(
            [byte[]] $Bytes,
            [int] $Offset,
            [uint32] $Value
        ) {
            $Bytes[$Offset] = [byte]($Value -band 0xFF)
            $Bytes[$Offset + 1] = [byte](($Value -shr 8) -band 0xFF)
            $Bytes[$Offset + 2] = [byte](($Value -shr 16) -band 0xFF)
            $Bytes[$Offset + 3] = [byte](($Value -shr 24) -band 0xFF)
        }

        function Set-AsciiNullTerminated(
            [byte[]] $Bytes,
            [int] $Offset,
            [string] $Value
        ) {
            [byte[]] $encoded = [Text.Encoding]::ASCII.GetBytes("$Value`0")
            [Array]::Copy($encoded, 0, $Bytes, $Offset, $encoded.Length)
        }

        function New-PeSectionFixture(
            [int] $Index = 0,
            [uint32] $VirtualSize = 0x200,
            [uint32] $VirtualAddress = 0x1000,
            [uint32] $RawSize = 0x200,
            [uint32] $RawPointer = 0x200
        ) {
            [uint64] $virtualSpan = [Math]::Max(
                [uint64] $VirtualSize,
                [uint64] $RawSize
            )

            [pscustomobject]@{
                Index          = $Index
                VirtualSize    = $VirtualSize
                VirtualAddress = $VirtualAddress
                VirtualSpan    = $virtualSpan
                VirtualEnd     = [uint64] $VirtualAddress + $virtualSpan
                RawSize        = $RawSize
                RawPointer     = $RawPointer
                RawEnd         = [uint64] $RawPointer + [uint64] $RawSize
            }
        }

        function New-ExportDirectoryFixture {
            $directoryOffset = 0x200
            [byte[]] $bytes = [byte[]]::new(1024)

            # IMAGE_EXPORT_DIRECTORY fields consumed by Get-PeExportNames.
            Set-UInt32LittleEndian $bytes ($directoryOffset + 20) 1
            Set-UInt32LittleEndian $bytes ($directoryOffset + 24) 1
            Set-UInt32LittleEndian $bytes ($directoryOffset + 28) 0x1040
            Set-UInt32LittleEndian $bytes ($directoryOffset + 32) 0x1044
            Set-UInt32LittleEndian $bytes ($directoryOffset + 36) 0x1048

            Set-UInt32LittleEndian $bytes 0x240 0x1080
            Set-UInt32LittleEndian $bytes 0x244 0x1050
            Set-UInt16LittleEndian $bytes 0x248 0
            Set-AsciiNullTerminated $bytes 0x250 'VR_InitInternal'

            [pscustomobject]@{
                Bytes           = $bytes
                Section         = New-PeSectionFixture
                DirectoryOffset = $directoryOffset
            }
        }

        function New-ImportDirectoryFixture([string] $LibraryName) {
            [byte[]] $bytes = [byte[]]::new(1024)
            Set-AsciiNullTerminated $bytes 0x280 $LibraryName

            [pscustomobject]@{
                Bytes   = $bytes
                Section = New-PeSectionFixture
            }
        }

        function Get-TestExportNames(
            [byte[]] $Bytes,
            [object] $Section,
            [uint32] $DirectorySize,
            [string] $Path
        ) {
            $parameters = @{
                Bytes         = $Bytes
                Sections      = @($Section)
                SizeOfHeaders = 0x200
                DirectoryRva  = 0x1000
                DirectorySize = $DirectorySize
                Path          = $Path
            }

            @(Get-PeExportNames @parameters)
        }

        function Get-TestImportNames(
            [byte[]] $Bytes,
            [object] $Section,
            [uint32] $DirectorySize,
            [uint32] $DescriptorSize,
            [uint32] $NameOffset,
            [uint64] $ImageBase,
            [bool] $IsDelay,
            [string] $Path
        ) {
            $parameters = @{
                Bytes          = $Bytes
                Sections       = @($Section)
                SizeOfHeaders  = 0x200
                DirectoryRva   = 0x1000
                DirectorySize  = $DirectorySize
                DescriptorSize = $DescriptorSize
                NameOffset     = $NameOffset
                ImageBase      = $ImageBase
                IsDelayImport  = $IsDelay
                Path           = $Path
            }

            @(Get-PeImportNames @parameters)
        }

        function Test-PeRangeBoundaries {
            Assert-PeFileRange 0 64 64 'exact header boundary'

            Assert-Throws {
                Assert-PeFileRange 63 2 64 'truncated PE header'
            } 'truncated headers'

            Assert-Throws {
                Assert-PeFileRange `
                ([int64]::MaxValue - 4) `
                    40 `
                ([int64]::MaxValue) `
                    'section table'
            } 'overflowing section table'
        }

        function Test-RvaMappingBoundaries {
            $section = New-PeSectionFixture -RawSize 0x100

            $headerOffset = Convert-PeRvaToFileOffset 0x1FF @($section) 0x200 0x400
            Assert-Equal $headerOffset 0x1FF 'Header RVA was mapped incorrectly'

            $sectionOffset = Convert-PeRvaToFileOffset 0x1010 @($section) 0x200 0x400
            Assert-Equal $sectionOffset 0x210 'Section RVA was mapped incorrectly'

            Assert-Throws {
                Convert-PeRvaToFileOffset 0x1100 @($section) 0x200 0x400
            } 'RVA in virtual-only section tail'

            Assert-Throws {
                Convert-PeRvaToFileOffset 0x2000 @($section) 0x200 0x400
            } 'unmapped RVA'
        }

        function Test-SectionOverlapBoundaries {
            $firstSection = New-PeSectionFixture `
                -Index 0 `
                -VirtualSize 0x100 `
                -RawSize 0x100

            $adjacentSection = New-PeSectionFixture `
                -Index 1 `
                -VirtualSize 0x100 `
                -VirtualAddress 0x1100 `
                -RawSize 0x100 `
                -RawPointer 0x300

            Assert-PeSectionsDoNotOverlap `
            @($firstSection, $adjacentSection) `
                '<adjacent sections>'

            $rawOverlapSection = New-PeSectionFixture `
                -Index 1 `
                -VirtualSize 0x100 `
                -VirtualAddress 0x1100 `
                -RawSize 0x100 `
                -RawPointer 0x280
            Assert-Throws {
                Assert-PeSectionsDoNotOverlap `
                @($firstSection, $rawOverlapSection) `
                    '<raw overlap>'
            } 'overlapping section raw data'

            $rvaOverlapSection = New-PeSectionFixture `
                -Index 1 `
                -VirtualSize 0x100 `
                -VirtualAddress 0x1080 `
                -RawSize 0x100 `
                -RawPointer 0x300
            Assert-Throws {
                Assert-PeSectionsDoNotOverlap `
                @($firstSection, $rvaOverlapSection) `
                    '<RVA overlap>'
            } 'overlapping section RVA ranges'
        }

        function Test-AsciiExportNameBoundaries {
            [byte[]] $validName = [Text.Encoding]::ASCII.GetBytes("VR_InitInternal`0")
            $parsedName = Read-PeAsciiString `
                -Bytes $validName `
                -Offset 0 `
                -MaximumByteCount 256 `
                -Description 'synthetic export name'
            Assert-Equal $parsedName 'VR_InitInternal' 'Export name was parsed incorrectly'

            Assert-Throws {
                Read-PeAsciiString `
                    -Bytes ([byte[]]@(0)) `
                    -Offset 0 `
                    -MaximumByteCount 256 `
                    -Description 'empty synthetic export name'
            } 'empty export name'

            Assert-Throws {
                Read-PeAsciiString `
                    -Bytes ([byte[]]@(0x41, 0x1F, 0)) `
                    -Offset 0 `
                    -MaximumByteCount 256 `
                    -Description 'non-printable synthetic export name'
            } 'non-printable export name'

            Assert-Throws {
                Read-PeAsciiString `
                    -Bytes ([byte[]](0x41) * 257) `
                    -Offset 0 `
                    -MaximumByteCount 256 `
                    -Description 'unterminated synthetic export name'
            } 'unterminated export name'
        }

        function Test-ExportDirectoryBoundaries {
            $fixture = New-ExportDirectoryFixture
            $validParameters = @{
                Bytes         = $fixture.Bytes
                Section       = $fixture.Section
                DirectorySize = 0x80
                Path          = '<synthetic export fixture>'
            }

            $parsedExports = @(Get-TestExportNames @validParameters)
            Assert-SingleValue `
                $parsedExports `
                'VR_InitInternal' `
                'Synthetic export fixture was parsed incorrectly'

            $truncatedParameters = $validParameters.Clone()
            $truncatedParameters.DirectorySize = 39
            $truncatedParameters.Path = '<truncated export fixture>'
            Assert-Throws {
                Get-TestExportNames @truncatedParameters
            } 'truncated export directory'

            [byte[]] $invalidOrdinal = $fixture.Bytes.Clone()
            Set-UInt16LittleEndian $invalidOrdinal 0x248 1
            $invalidOrdinalParameters = $validParameters.Clone()
            $invalidOrdinalParameters.Bytes = $invalidOrdinal
            $invalidOrdinalParameters.Path = '<invalid ordinal fixture>'
            Assert-Throws {
                Get-TestExportNames @invalidOrdinalParameters
            } 'export ordinal outside function table'

            [byte[]] $truncatedNameTable = $fixture.Bytes.Clone()
            Set-UInt32LittleEndian `
                $truncatedNameTable `
            ($fixture.DirectoryOffset + 32) `
                0x11FF
            $truncatedNameParameters = $validParameters.Clone()
            $truncatedNameParameters.Bytes = $truncatedNameTable
            $truncatedNameParameters.Path = '<truncated name table fixture>'
            Assert-Throws {
                Get-TestExportNames @truncatedNameParameters
            } 'export name pointer table crossing section boundary'
        }

        function Test-ImportDirectoryBoundaries {
            $regularFixture = New-ImportDirectoryFixture 'KERNEL32.DLL'

            # IMAGE_IMPORT_DESCRIPTOR.Name is an RVA in PE32 and PE32+.
            Set-UInt32LittleEndian $regularFixture.Bytes (0x200 + 12) 0x1080
            $regularParameters = @{
                Bytes          = $regularFixture.Bytes
                Section        = $regularFixture.Section
                DirectorySize  = 40
                DescriptorSize = 20
                NameOffset     = 12
                ImageBase      = 0x140000000
                IsDelay        = $false
                Path           = '<synthetic PE32+ regular imports>'
            }

            $regularImports = @(Get-TestImportNames @regularParameters)
            Assert-SingleValue `
                $regularImports `
                'kernel32.dll' `
                'Synthetic PE32+ regular import fixture was parsed incorrectly'

            # Delay descriptors with dlattrRva=1 store the name as an RVA.
            $delayRvaFixture = New-ImportDirectoryFixture 'VORBIS.DLL'
            Set-UInt32LittleEndian $delayRvaFixture.Bytes 0x200 1
            Set-UInt32LittleEndian $delayRvaFixture.Bytes 0x204 0x1080
            $delayRvaParameters = @{
                Bytes          = $delayRvaFixture.Bytes
                Section        = $delayRvaFixture.Section
                DirectorySize  = 64
                DescriptorSize = 32
                NameOffset     = 4
                ImageBase      = 0x140000000
                IsDelay        = $true
                Path           = '<synthetic PE32+ delay RVA imports>'
            }

            $delayRvaImports = @(Get-TestImportNames @delayRvaParameters)
            Assert-SingleValue `
                $delayRvaImports `
                'vorbis.dll' `
                'Synthetic PE32+ delay RVA fixture was parsed incorrectly'

            # Legacy PE32 delay descriptors may store the name as a VA.
            [byte[]] $delayVaBytes = $delayRvaFixture.Bytes.Clone()
            Set-UInt32LittleEndian $delayVaBytes 0x200 0
            Set-UInt32LittleEndian $delayVaBytes 0x204 0x401080
            $delayVaParameters = $delayRvaParameters.Clone()
            $delayVaParameters.Bytes = $delayVaBytes
            $delayVaParameters.ImageBase = 0x400000
            $delayVaParameters.Path = '<synthetic PE32 delay VA imports>'

            $delayVaImports = @(Get-TestImportNames @delayVaParameters)
            Assert-SingleValue `
                $delayVaImports `
                'vorbis.dll' `
                'Synthetic PE32 delay VA fixture was parsed incorrectly'

            [byte[]] $unsupportedAttributes = $delayRvaFixture.Bytes.Clone()
            Set-UInt32LittleEndian $unsupportedAttributes 0x200 2
            $unsupportedAttributesParameters = $delayRvaParameters.Clone()
            $unsupportedAttributesParameters.Bytes = $unsupportedAttributes
            $unsupportedAttributesParameters.ImageBase = 0x400000
            $unsupportedAttributesParameters.Path = '<delay attributes>'
            Assert-Throws {
                Get-TestImportNames @unsupportedAttributesParameters
            } 'unsupported delay import attributes'

            [byte[]] $unmappedName = $regularFixture.Bytes.Clone()
            Set-UInt32LittleEndian $unmappedName (0x200 + 12) 0x2000
            $unmappedNameParameters = $regularParameters.Clone()
            $unmappedNameParameters.Bytes = $unmappedName
            $unmappedNameParameters.ImageBase = 0x400000
            $unmappedNameParameters.Path = '<unmapped import>'
            Assert-Throws {
                Get-TestImportNames @unmappedNameParameters
            } 'unmapped import name RVA'

            [byte[]] $unterminatedDirectory = $regularFixture.Bytes.Clone()
            for ($index = 20; $index -lt 40; $index++) {
                $unterminatedDirectory[0x200 + $index] = 1
            }
            $unterminatedParameters = $regularParameters.Clone()
            $unterminatedParameters.Bytes = $unterminatedDirectory
            $unterminatedParameters.ImageBase = 0x400000
            $unterminatedParameters.Path = '<unterminated imports>'
            Assert-Throws {
                Get-TestImportNames @unterminatedParameters
            } 'import descriptor table without a zero terminator'
        }

        function Test-PeMetadataBoundaries {
            $fixtureId = [Guid]::NewGuid().ToString('N')
            $fixturePath = Join-Path `
            ([IO.Path]::GetTempPath()) `
                "renderpilot-pe-$fixtureId.dll"
            $typeName = "RenderPilotPeFixture$fixtureId"
            $source = "public static class $typeName { public static int Value { get { return 1; } } }"

            try {
                Add-Type `
                    -TypeDefinition $source `
                    -OutputAssembly $fixturePath | Out-Null

                $metadata = Get-PeMetadata -Path $fixturePath
                Assert-OneOf `
                    $metadata.architecture `
                @('X64', 'X86') `
                    'Generated PE fixture has an unexpected architecture'

                $expectedSecurityKeys = @(
                    'high_entropy_va'
                    'dynamic_base'
                    'nx_compat'
                    'guard_cf'
                )
                $actualSecurityKeys = @(
                    $metadata.pe_security.Keys
                )
                if (($actualSecurityKeys -join "`0") -cne
                    ($expectedSecurityKeys -join "`0")) {
                    throw (
                        'Generated PE fixture has an invalid security contract: ' +
                        "[$($actualSecurityKeys -join ', ')]"
                    )
                }
                foreach ($securityValue in $metadata.pe_security.Values) {
                    if ($securityValue -isnot [bool]) {
                        throw 'Generated PE fixture has a non-boolean security flag'
                    }
                }

                [byte[]] $originalBytes = [IO.File]::ReadAllBytes($fixturePath)
                $peOffset = [int][BitConverter]::ToUInt32($originalBytes, 0x3C)
                $coffOffset = $peOffset + 4
                $optionalHeaderOffset = $coffOffset + 20

                [byte[]] $truncatedOptionalHeader = $originalBytes.Clone()
                Set-UInt16LittleEndian `
                    $truncatedOptionalHeader `
                ($coffOffset + 16) `
                    1
                [IO.File]::WriteAllBytes($fixturePath, $truncatedOptionalHeader)
                Assert-Throws {
                    Get-PeMetadata -Path $fixturePath
                } 'truncated optional header'

                [byte[]] $truncatedSectionTable = $originalBytes.Clone()
                $optionalHeaderSize = [BitConverter]::ToUInt16(
                    $truncatedSectionTable,
                    $coffOffset + 16
                )
                $sectionCount = [BitConverter]::ToUInt16(
                    $truncatedSectionTable,
                    $coffOffset + 2
                )
                $sectionTableEnd = `
                    $optionalHeaderOffset + `
                    $optionalHeaderSize + `
                (40 * $sectionCount)

                [Array]::Resize(
                    [ref]$truncatedSectionTable,
                    [int]($sectionTableEnd - 1)
                )
                [IO.File]::WriteAllBytes($fixturePath, $truncatedSectionTable)
                Assert-Throws {
                    Get-PeMetadata -Path $fixturePath
                } 'truncated section table'
            }
            finally {
                if ([IO.File]::Exists($fixturePath)) {
                    [IO.File]::Delete($fixturePath)
                }
            }
        }

        Test-PeRangeBoundaries
        Test-RvaMappingBoundaries
        Test-SectionOverlapBoundaries
        Test-AsciiExportNameBoundaries
        Test-ExportDirectoryBoundaries
        Test-ImportDirectoryBoundaries
        Test-PeMetadataBoundaries
    }
}

Write-Output 'PE inspector boundary tests passed.'

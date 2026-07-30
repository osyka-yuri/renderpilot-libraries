[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Throws {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [scriptblock] $Action,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [regex] $Pattern,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    try {
        & $Action | Out-Null
    }
    catch {
        $exception = $_.Exception

        if ($Pattern.IsMatch($exception.Message)) {
            return
        }

        $message = @(
            "Test '$Description' failed with an unexpected error."
            "Expected message matching: $Pattern"
            "Actual message: $($exception.Message)"
        ) -join ' '

        throw ([InvalidOperationException]::new($message, $exception))
    }

    throw ([InvalidOperationException]::new(
            "Expected source-archive failure for test '$Description', but the action completed successfully."
        ))
}

function Assert-PathWithinRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Root,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root)
    $relativePath = [IO.Path]::GetRelativePath($resolvedRoot, $resolvedPath)

    $parentPrefix = '..' + [IO.Path]::DirectorySeparatorChar
    $alternateParentPrefix = '..' + [IO.Path]::AltDirectorySeparatorChar

    $isOutsideRoot =
    [IO.Path]::IsPathRooted($relativePath) -or
    $relativePath -eq '..' -or
    $relativePath.StartsWith(
        $parentPrefix,
        [StringComparison]::Ordinal
    ) -or
    $relativePath.StartsWith(
        $alternateParentPrefix,
        [StringComparison]::Ordinal
    )

    if ($isOutsideRoot) {
        throw "$Description escaped its expected root: $resolvedPath"
    }
}

function New-TestTarDirectoryEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name
    )

    return [pscustomobject]@{
        Type = [System.Formats.Tar.TarEntryType]::Directory
        Name = $Name
    }
}

function New-TestTarFileEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name,

        [AllowEmptyString()]
        [string] $Content = ''
    )

    return [pscustomobject]@{
        Type    = [System.Formats.Tar.TarEntryType]::RegularFile
        Name    = $Name
        Content = $Content
    }
}

function New-TestTarSymbolicLinkEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $LinkName
    )

    return [pscustomobject]@{
        Type     = [System.Formats.Tar.TarEntryType]::SymbolicLink
        Name     = $Name
        LinkName = $LinkName
    }
}

function Write-TestTarEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [System.Formats.Tar.TarWriter] $Writer,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Definition
    )

    $entryType = [System.Formats.Tar.TarEntryType] $Definition.Type
    $entryName = [string] $Definition.Name

    if ([string]::IsNullOrWhiteSpace($entryName)) {
        throw 'Test tar entry name must not be empty'
    }

    $entry = [System.Formats.Tar.PaxTarEntry]::new(
        $entryType,
        $entryName
    )

    if ($entryType -eq [System.Formats.Tar.TarEntryType]::RegularFile) {
        $content = [string] $Definition.Content
        $contentBytes = [Text.Encoding]::UTF8.GetBytes($content)
        $contentStream = [IO.MemoryStream]::new($contentBytes, $false)

        try {
            $entry.DataStream = $contentStream
            $Writer.WriteEntry($entry)
        }
        finally {
            $contentStream.Dispose()
        }

        return
    }

    if ($entryType -eq [System.Formats.Tar.TarEntryType]::SymbolicLink) {
        $linkName = [string] $Definition.LinkName

        if ([string]::IsNullOrWhiteSpace($linkName)) {
            throw "Symbolic-link test entry has no target: $entryName"
        }

        $entry.LinkName = $linkName
        $Writer.WriteEntry($entry)
        return
    }

    if ($entryType -eq [System.Formats.Tar.TarEntryType]::Directory) {
        $Writer.WriteEntry($entry)
        return
    }

    throw "Unsupported test tar entry type '$entryType' for entry '$entryName'"
}

function New-TestTar {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object[]] $Entries
    )

    $stream = [IO.File]::Create($Path)

    try {
        # Leave the underlying stream open so that ownership remains explicit:
        # TarWriter is disposed first, then the FileStream.
        $writer = [System.Formats.Tar.TarWriter]::new($stream, $true)

        try {
            foreach ($entry in $Entries) {
                Write-TestTarEntry `
                    -Writer $writer `
                    -Definition $entry
            }
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function New-EntryCountLimitFixture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483646)]
        [int] $FileCount
    )

    $entries = [Collections.Generic.List[object]]::new($FileCount + 1)
    $entries.Add((New-TestTarDirectoryEntry -Name 'source/'))

    for ($index = 0; $index -lt $FileCount; $index++) {
        $entries.Add(
            (New-TestTarFileEntry -Name "source/$index")
        )
    }

    return $entries.ToArray()
}

function Invoke-ValidArchiveTest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $TestRoot
    )

    $archivePath = Join-Path $TestRoot 'valid.tar'
    $destinationPath = Join-Path $TestRoot 'valid'
    $expectedContent = 'license'

    New-TestTar -Path $archivePath -Entries @(
        (New-TestTarDirectoryEntry -Name 'libogg-1.0/'),
        (New-TestTarFileEntry `
            -Name 'libogg-1.0/COPYING' `
            -Content $expectedContent)
    )

    Expand-SafeXiphTar `
        -Archive $archivePath `
        -Destination $destinationPath

    $extractedFile = Join-Path $destinationPath 'libogg-1.0/COPYING'

    if (-not [IO.File]::Exists($extractedFile)) {
        throw "Valid source archive did not extract the expected file: $extractedFile"
    }

    $actualContent = [IO.File]::ReadAllText(
        $extractedFile,
        [Text.Encoding]::UTF8
    )

    if ($actualContent -cne $expectedContent) {
        throw @(
            'Valid source archive did not round-trip its file content.'
            "Expected: '$expectedContent'"
            "Actual: '$actualContent'"
        ) -join ' '
    }
}

function Invoke-RejectedArchiveTest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $TestRoot,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $ArchiveName,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DestinationName,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object[]] $Entries,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [regex] $ExpectedMessage,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    $archivePath = Join-Path $TestRoot $ArchiveName
    $destinationPath = Join-Path $TestRoot $DestinationName

    New-TestTar `
        -Path $archivePath `
        -Entries $Entries

    Assert-Throws `
        -Description $Description `
        -Pattern $ExpectedMessage `
        -Action {
        Expand-SafeXiphTar `
            -Archive $archivePath `
            -Destination $destinationPath
    }

    if ([IO.File]::Exists($destinationPath) -or
        [IO.Directory]::Exists($destinationPath)) {
        throw (
            "Rejected source archive published a destination for test " +
            "'$Description': $destinationPath"
        )
    }
}

$modulePath = [IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '../xiph/source-archive.psm1')
)

Import-Module -Name $modulePath -Force

$systemTemp = [IO.Path]::GetFullPath(
    [IO.Path]::GetTempPath()
)

$testRootName = 'renderpilot-xiph-archive-{0}' -f (
    [Guid]::NewGuid().ToString('N')
)

$resolvedTestRoot = [IO.Path]::GetFullPath(
    (Join-Path $systemTemp $testRootName)
)

Assert-PathWithinRoot `
    -Path $resolvedTestRoot `
    -Root $systemTemp `
    -Description 'Xiph archive test root'

[IO.Directory]::CreateDirectory($resolvedTestRoot) | Out-Null

try {
    Invoke-ValidArchiveTest -TestRoot $resolvedTestRoot

    $entryCountLimitFixture = @(
        New-EntryCountLimitFixture -FileCount 10000
    )

    $rejectionCases = @(
        [pscustomobject]@{
            Description     = 'reserved Windows path'
            ArchiveName     = 'reserved.tar'
            DestinationName = 'reserved'
            ExpectedMessage = [regex] 'reserved Windows name'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source/CON.txt')
            )
        }

        [pscustomobject]@{
            Description     = 'absolute path'
            ArchiveName     = 'absolute.tar'
            DestinationName = 'absolute'
            ExpectedMessage = [regex] 'absolute path'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name '/outside')
            )
        }

        [pscustomobject]@{
            Description     = 'parent traversal'
            ArchiveName     = 'parent-traversal.tar'
            DestinationName = 'parent-traversal'
            ExpectedMessage = [regex] 'unsafe tar path component'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source/../outside')
            )
        }

        [pscustomobject]@{
            Description     = 'Windows separator traversal'
            ArchiveName     = 'backslash-traversal.tar'
            DestinationName = 'backslash-traversal'
            ExpectedMessage = [regex] 'unsafe tar path component'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source\..\outside')
            )
        }

        [pscustomobject]@{
            Description     = 'symbolic link'
            ArchiveName     = 'symlink.tar'
            DestinationName = 'symlink'
            ExpectedMessage = [regex] 'regular files and directories only'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarSymbolicLinkEntry `
                    -Name 'source/link' `
                    -LinkName '../outside')
            )
        }

        [pscustomobject]@{
            Description     = 'case-insensitive duplicate path'
            ArchiveName     = 'duplicate-case.tar'
            DestinationName = 'duplicate-case'
            ExpectedMessage = [regex] 'duplicate Windows path'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source/File'),
                (New-TestTarFileEntry -Name 'source/file')
            )
        }

        [pscustomobject]@{
            Description     = 'file used as a parent directory'
            ArchiveName     = 'file-parent.tar'
            DestinationName = 'file-parent'
            ExpectedMessage = [regex] 'file is used as a parent directory'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source/file'),
                (New-TestTarFileEntry -Name 'source/file/child')
            )
        }

        [pscustomobject]@{
            Description     = 'inconsistent directory casing'
            ArchiveName     = 'directory-case.tar'
            DestinationName = 'directory-case'
            ExpectedMessage = [regex] 'inconsistent Windows path casing'
            Entries         = @(
                (New-TestTarDirectoryEntry -Name 'source/'),
                (New-TestTarFileEntry -Name 'source/Directory/a'),
                (New-TestTarFileEntry -Name 'source/directory/b')
            )
        }

        [pscustomobject]@{
            Description     = 'entry-count limit'
            ArchiveName     = 'too-many-entries.tar'
            DestinationName = 'too-many'
            ExpectedMessage = [regex] 'more than 10000 entries'
            Entries         = $entryCountLimitFixture
        }
    )

    foreach ($testCase in $rejectionCases) {
        Invoke-RejectedArchiveTest `
            -TestRoot $resolvedTestRoot `
            -ArchiveName $testCase.ArchiveName `
            -DestinationName $testCase.DestinationName `
            -Entries $testCase.Entries `
            -ExpectedMessage $testCase.ExpectedMessage `
            -Description $testCase.Description
    }

    Write-Host 'Xiph source archive boundary tests passed.'
}
finally {
    if ([IO.Directory]::Exists($resolvedTestRoot)) {
        Assert-PathWithinRoot `
            -Path $resolvedTestRoot `
            -Root $systemTemp `
            -Description 'Xiph archive cleanup root'

        Remove-Item `
            -LiteralPath $resolvedTestRoot `
            -Recurse `
            -Force
    }
}

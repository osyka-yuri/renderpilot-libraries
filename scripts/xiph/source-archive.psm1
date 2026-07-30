#requires -Version 7.0

Set-StrictMode -Version Latest

$script:MaximumArchiveEntryCount = 10000
$script:MaximumArchivePathLength = 1024
$script:MaximumPathComponentLength = 255
$script:MaximumArchiveByteCount = [int64](64MB)
$script:MaximumExpandedByteCount = [uint64](256MB)
$script:TarCommandTimeoutMilliseconds = 120000

function Invoke-TarCommand {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Executable,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList,

        [Parameter(Mandatory)]
        [string] $Operation
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    foreach ($argument in $ArgumentList) {
        [void] $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo

    try {
        if (-not $process.Start()) {
            throw "failed to start tar while attempting to $Operation"
        }

        # Read both streams asynchronously to avoid a redirected-stream deadlock.
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit(
                $script:TarCommandTimeoutMilliseconds
            )) {
            try {
                $process.Kill($true)
            }
            finally {
                $process.WaitForExit()
            }

            throw (
                "tar timed out after " +
                "$($script:TarCommandTimeoutMilliseconds) ms " +
                "while attempting to $Operation"
            )
        }

        $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
        $standardError = $standardErrorTask.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }

    if ($exitCode -ne 0) {
        $details = $standardError.Trim()
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = $standardOutput.Trim()
        }

        $message = "tar exited with code $exitCode while attempting to $Operation"
        if (-not [string]::IsNullOrWhiteSpace($details)) {
            $message += ":$([Environment]::NewLine)$details"
        }

        throw $message
    }

    [pscustomobject] @{
        StandardOutput = $standardOutput
        StandardError  = $standardError
    }
}

function ConvertTo-TarOutputLine {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Text
    )

    if ($Text.Length -eq 0) {
        return [string[]] @()
    }

    $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")

    # Remove only the line terminator produced after the final entry. Removing
    # every trailing terminator could hide an invalid entry containing one.
    if ($normalized.EndsWith("`n", [StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(0, $normalized.Length - 1)
    }

    if ($normalized.Length -eq 0) {
        return [string[]] @('')
    }

    return [string[]] $normalized.Split(
        [char[]] @([char] "`n"),
        [StringSplitOptions]::None
    )
}

function Test-WindowsReservedFileName {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string] $Component
    )

    $dotIndex = $Component.IndexOf('.')
    $baseName = if ($dotIndex -ge 0) {
        $Component.Substring(0, $dotIndex)
    }
    else {
        $Component
    }

    # Windows also normalizes spaces and periods adjacent to device names.
    $baseName = $baseName.TrimEnd([char[]] @(' ', '.'))

    return $baseName -match (
        '^(?i:' +
        'con|prn|aux|nul|clock\$|conin\$|conout\$|' +
        'com(?:[1-9]|[¹²³])|' +
        'lpt(?:[1-9]|[¹²³])' +
        ')$'
    )
}

function ConvertTo-SafeTarPath {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Entry,

        [Parameter(Mandatory)]
        [string] $Archive
    )

    # A backslash is a path separator on Windows even when it originated as a
    # literal character in a POSIX archive name.
    $normalized = $Entry.Replace('\', '/')

    if ($normalized.Length -eq 0) {
        throw "source archive contains an empty path: $Archive"
    }

    if ($normalized.Length -gt $script:MaximumArchivePathLength) {
        throw "tar path exceeds $($script:MaximumArchivePathLength) characters: $Entry"
    }

    if ($normalized.StartsWith('/', [StringComparison]::Ordinal) -or
        $normalized -match '^[A-Za-z]:') {
        throw "source archive contains an absolute path: $Entry"
    }

    $hadTrailingSeparator = $normalized.EndsWith(
        '/',
        [StringComparison]::Ordinal
    )

    # Remove exactly one directory marker. Removing every trailing slash would
    # incorrectly accept paths such as "root/directory//".
    $trimmed = if ($hadTrailingSeparator) {
        $normalized.Substring(0, $normalized.Length - 1)
    }
    else {
        $normalized
    }

    if ($trimmed.Length -eq 0) {
        throw "source archive contains an empty root path: $Entry"
    }

    $components = [string[]] $trimmed.Split(
        [char[]] @('/'),
        [StringSplitOptions]::None
    )

    foreach ($component in $components) {
        if ([string]::IsNullOrWhiteSpace($component) -or
            $component -eq '.' -or
            $component -eq '..') {
            throw "unsafe tar path component '$component': $Entry"
        }

        if ($component.Length -gt $script:MaximumPathComponentLength) {
            throw (
                "tar path component exceeds " +
                "$($script:MaximumPathComponentLength) characters: $Entry"
            )
        }

        if ($component -match '[<>:"|?*\x00-\x1F]') {
            throw "tar path contains an invalid Windows character: $Entry"
        }

        if ($component.EndsWith('.', [StringComparison]::Ordinal) -or
            $component.EndsWith(' ', [StringComparison]::Ordinal)) {
            throw "tar path has a trailing period or space: $Entry"
        }

        if (Test-WindowsReservedFileName -Component $component) {
            throw "tar path uses the reserved Windows name '$component': $Entry"
        }
    }

    [pscustomobject] @{
        Original             = $Entry
        Normalized           = $trimmed
        Components           = $components
        HadTrailingSeparator = $hadTrailingSeparator
    }
}

function Get-TarEntryMetadata {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Line
    )

    # Supported common verbose formats:
    #
    # BSD/libarchive:
    #   -rw-r--r--  0 owner group 123 date time path
    #
    # GNU tar:
    #   -rw-r--r-- owner/group 123 date time path
    #
    # Some BSD variants omit the link-count column:
    #   -rw-r--r-- owner group 123 date time path
    $patterns = @(
        '^(?<Mode>\S+)\s+\d+\s+\S+\s+\S+\s+(?<Size>\d+)\s+'
        '^(?<Mode>\S+)\s+\S+/\S+\s+(?<Size>\d+)\s+'
        '^(?<Mode>\S+)\s+\S+\s+\S+\s+(?<Size>\d+)\s+'
    )

    $match = $null

    foreach ($pattern in $patterns) {
        $candidate = [regex]::Match(
            $Line,
            $pattern,
            [Text.RegularExpressions.RegexOptions]::CultureInvariant
        )

        if ($candidate.Success) {
            $match = $candidate
            break
        }
    }

    if ($null -eq $match) {
        throw "cannot verify tar entry metadata: $Line"
    }

    [char] $entryType = $match.Groups['Mode'].Value[0]

    if ($entryType -ne '-' -and $entryType -ne 'd') {
        throw (
            "source archive may contain regular files and directories only; " +
            "unsupported entry: $Line"
        )
    }

    [uint64] $entrySize = 0

    if (-not [uint64]::TryParse(
            $match.Groups['Size'].Value,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref] $entrySize
        )) {
        throw "cannot verify declared tar entry size: $Line"
    }

    [pscustomobject] @{
        Type = $entryType
        Size = $entrySize
    }
}

function Get-ValidatedTarManifest {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $TarExecutable,

        [Parameter(Mandatory)]
        [string] $Archive
    )

    $plainListing = Invoke-TarCommand `
        -Executable $TarExecutable `
        -ArgumentList @('-tf', $Archive) `
        -Operation "list archive entries"

    $entryLines = @(
        ConvertTo-TarOutputLine -Text $plainListing.StandardOutput
    )

    if ($entryLines.Count -eq 0) {
        throw "source archive is empty: $Archive"
    }

    if ($entryLines.Count -gt $script:MaximumArchiveEntryCount) {
        throw (
            "source archive contains more than " +
            "$($script:MaximumArchiveEntryCount) entries: $Archive"
        )
    }

    $verboseListing = Invoke-TarCommand `
        -Executable $TarExecutable `
        -ArgumentList @('-tvf', $Archive) `
        -Operation "inspect archive entry metadata"

    $metadataLines = @(
        ConvertTo-TarOutputLine -Text $verboseListing.StandardOutput
    )

    if ($metadataLines.Count -ne $entryLines.Count) {
        throw (
            "tar listings disagree about the number of archive entries: " +
            "$Archive"
        )
    }

    $explicitPaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )

    $records = [Collections.Generic.List[object]]::new()

    $rootName = $null
    $regularFileCount = 0
    [uint64] $declaredFileBytes = 0

    for ($index = 0; $index -lt $entryLines.Count; $index++) {
        $path = ConvertTo-SafeTarPath `
            -Entry $entryLines[$index] `
            -Archive $Archive

        if (-not $explicitPaths.Add($path.Normalized)) {
            throw (
                "source archive contains a duplicate Windows path: " +
                "$($path.Original)"
            )
        }

        $metadata = Get-TarEntryMetadata `
            -Line $metadataLines[$index]

        if ($metadata.Type -eq '-' -and $path.HadTrailingSeparator) {
            throw (
                "regular-file tar entry has a directory separator suffix: " +
                "$($path.Original)"
            )
        }

        if ($path.Components.Count -eq 1 -and $metadata.Type -ne 'd') {
            throw (
                "source archive root must be a directory: " +
                "$($path.Original)"
            )
        }

        $entryRoot = $path.Components[0]

        if ($null -eq $rootName) {
            $rootName = $entryRoot
        }
        elseif ($rootName -cne $entryRoot) {
            throw (
                "source archive must contain exactly one consistently-cased " +
                "root directory: $Archive"
            )
        }

        if ($metadata.Type -eq '-') {
            if ($metadata.Size -gt $script:MaximumExpandedByteCount -or
                $declaredFileBytes -gt (
                    $script:MaximumExpandedByteCount - $metadata.Size
                )) {
                throw "declared archive size exceeds 256 MiB: $Archive"
            }

            $declaredFileBytes += $metadata.Size
            $regularFileCount++
        }
        elseif ($metadata.Size -ne 0) {
            throw (
                "directory entry declares a nonzero payload size: " +
                "$($path.Original)"
            )
        }

        $records.Add(
            [pscustomobject] @{
                Path     = $path
                Metadata = $metadata
            }
        )
    }

    # Validate the complete Windows path graph. A simple duplicate check is not
    # sufficient for cases such as:
    #
    #   root/file
    #   root/file/child
    #
    # or case aliases such as:
    #
    #   root/Directory/a
    #   root/directory/b
    $directoryPaths = [Collections.Generic.Dictionary[string, string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )

    $filePaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )

    foreach ($record in $records) {
        $components = $record.Path.Components
        $prefix = ''

        for (
            $componentIndex = 0
            $componentIndex -lt $components.Count
            $componentIndex++
        ) {
            if ($componentIndex -eq 0) {
                $prefix = $components[$componentIndex]
            }
            else {
                $prefix += "/$($components[$componentIndex])"
            }

            $isLeaf = $componentIndex -eq ($components.Count - 1)
            $isFileLeaf = $isLeaf -and $record.Metadata.Type -eq '-'

            if ($isFileLeaf) {
                if ($directoryPaths.ContainsKey($prefix)) {
                    throw (
                        "archive path is both a file and a directory: " +
                        "$prefix"
                    )
                }

                if (-not $filePaths.Add($prefix)) {
                    throw "source archive contains a duplicate file path: $prefix"
                }

                continue
            }

            if ($filePaths.Contains($prefix)) {
                throw "archive file is used as a parent directory: $prefix"
            }

            $canonicalPath = $null

            if ($directoryPaths.TryGetValue(
                    $prefix,
                    [ref] $canonicalPath
                )) {
                if ($canonicalPath -cne $prefix) {
                    throw (
                        "archive uses inconsistent Windows path casing: " +
                        "'$canonicalPath' and '$prefix'"
                    )
                }
            }
            else {
                $directoryPaths.Add($prefix, $prefix)
            }
        }
    }

    [pscustomobject] @{
        RootName             = $rootName
        RegularFileCount     = $regularFileCount
        DeclaredExpandedSize = $declaredFileBytes
    }
}

function Copy-ArchiveSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Source,

        [Parameter(Mandatory)]
        [string] $Destination
    )

    # Deny concurrent modification and deletion while copying on platforms
    # where FileShare is enforced. All tar operations then use this snapshot.
    $sourceStream = [IO.FileStream]::new(
        $Source,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )

    try {
        $destinationStream = [IO.FileStream]::new(
            $Destination,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )

        try {
            $sourceStream.CopyTo($destinationStream)
            $destinationStream.Flush($true)
        }
        finally {
            $destinationStream.Dispose()
        }
    }
    finally {
        $sourceStream.Dispose()
    }
}

function Confirm-ExpandedTarTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Root,

        [Parameter(Mandatory)]
        [string] $ExpectedRootName,

        [Parameter(Mandatory)]
        [int] $ExpectedFileCount,

        [Parameter(Mandatory)]
        [uint64] $ExpectedExpandedSize,

        [Parameter(Mandatory)]
        [string] $Archive
    )

    $topLevelEntries = @(
        [IO.Directory]::EnumerateFileSystemEntries($Root)
    )

    if ($topLevelEntries.Count -ne 1) {
        throw (
            "expanded archive must contain exactly one root directory: " +
            "$Archive"
        )
    }

    $expandedRoot = $topLevelEntries[0]
    $expandedRootAttributes = [IO.File]::GetAttributes($expandedRoot)

    if (($expandedRootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "expanded archive root is a reparse point: $Archive"
    }

    if (($expandedRootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "expanded archive root is not a directory: $Archive"
    }

    $actualRootName = [IO.Path]::GetFileName($expandedRoot)

    if ($actualRootName -cne $ExpectedRootName) {
        throw (
            "expanded archive root differs from the validated manifest: " +
            "'$actualRootName' instead of '$ExpectedRootName'"
        )
    }

    $pendingDirectories = [Collections.Generic.Stack[string]]::new()
    $pendingDirectories.Push($expandedRoot)

    $expandedEntryCount = 1
    $expandedFileCount = 0
    [uint64] $expandedByteCount = 0

    while ($pendingDirectories.Count -ne 0) {
        $directory = $pendingDirectories.Pop()

        foreach (
            $entry in [IO.Directory]::EnumerateFileSystemEntries($directory)
        ) {
            $expandedEntryCount++

            if ($expandedEntryCount -gt $script:MaximumArchiveEntryCount) {
                throw (
                    "expanded archive contains more than " +
                    "$($script:MaximumArchiveEntryCount) entries: $Archive"
                )
            }

            $attributes = [IO.File]::GetAttributes($entry)

            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "expanded archive contains a reparse point: $entry"
            }

            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pendingDirectories.Push($entry)
                continue
            }

            $expandedFileCount++

            if ($expandedFileCount -gt $script:MaximumArchiveEntryCount) {
                throw (
                    "expanded archive contains more than " +
                    "$($script:MaximumArchiveEntryCount) files: $Archive"
                )
            }

            [uint64] $fileSize = ([IO.FileInfo]::new($entry)).Length

            if ($fileSize -gt $script:MaximumExpandedByteCount -or
                $expandedByteCount -gt (
                    $script:MaximumExpandedByteCount - $fileSize
                )) {
                throw "expanded archive exceeds 256 MiB: $Archive"
            }

            $expandedByteCount += $fileSize
        }
    }

    if ($expandedFileCount -ne $ExpectedFileCount) {
        throw (
            "expanded file count differs from the validated manifest: " +
            "expected $ExpectedFileCount, found $expandedFileCount"
        )
    }

    if ($expandedByteCount -ne $ExpectedExpandedSize) {
        throw (
            "expanded size differs from the validated manifest: expected " +
            "$ExpectedExpandedSize bytes, found $expandedByteCount bytes"
        )
    }
}

function Expand-SafeXiphTar {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Archive,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Destination
    )

    $resolvedArchive = [IO.Path]::GetFullPath($Archive)
    $resolvedDestination = [IO.Path]::GetFullPath($Destination)

    if (-not [IO.File]::Exists($resolvedArchive)) {
        throw "source archive does not exist or is not a file: $resolvedArchive"
    }

    $archiveLength = ([IO.FileInfo]::new($resolvedArchive)).Length
    if ($archiveLength -le 0 -or
        $archiveLength -gt $script:MaximumArchiveByteCount) {
        throw (
            "source archive size must be within 1.." +
            "$($script:MaximumArchiveByteCount) bytes: $resolvedArchive"
        )
    }

    # Extracting into an existing directory is unsafe: an attacker could place
    # a junction or symbolic link at a path that the archive will overwrite.
    if ([IO.File]::Exists($resolvedDestination) -or
        [IO.Directory]::Exists($resolvedDestination)) {
        throw "destination already exists: $resolvedDestination"
    }

    $destinationParent = [IO.Path]::GetDirectoryName($resolvedDestination)

    if ([string]::IsNullOrWhiteSpace($destinationParent)) {
        throw "destination has no parent directory: $resolvedDestination"
    }

    [void] [IO.Directory]::CreateDirectory($destinationParent)

    $tarCommand = Get-Command `
        -Name 'tar' `
        -CommandType Application `
        -ErrorAction Stop |
    Select-Object -First 1

    $tarExecutable = $tarCommand.Source

    $workspace = Join-Path `
        $destinationParent `
        ".xiph-extract-$([Guid]::NewGuid().ToString('N'))"

    [void] [IO.Directory]::CreateDirectory($workspace)

    try {
        $archiveSnapshot = Join-Path $workspace 'source.tar'
        $extractionRoot = Join-Path $workspace 'expanded'

        [void] [IO.Directory]::CreateDirectory($extractionRoot)

        Copy-ArchiveSnapshot `
            -Source $resolvedArchive `
            -Destination $archiveSnapshot

        $manifest = Get-ValidatedTarManifest `
            -TarExecutable $tarExecutable `
            -Archive $archiveSnapshot

        [void] (
            Invoke-TarCommand `
                -Executable $tarExecutable `
                -ArgumentList @(
                '-xf'
                $archiveSnapshot
                '-C'
                $extractionRoot
            ) `
                -Operation "extract source archive"
        )

        Confirm-ExpandedTarTree `
            -Root $extractionRoot `
            -ExpectedRootName $manifest.RootName `
            -ExpectedFileCount $manifest.RegularFileCount `
            -ExpectedExpandedSize $manifest.DeclaredExpandedSize `
            -Archive $resolvedArchive

        # The destination is published only after the complete extracted tree
        # has passed validation. Because both paths share a parent volume, this
        # is a directory rename rather than a cross-volume copy.
        [IO.Directory]::Move($extractionRoot, $resolvedDestination)
    }
    finally {
        if ([IO.Directory]::Exists($workspace)) {
            try {
                [IO.Directory]::Delete($workspace, $true)
            }
            catch {
                Write-Warning (
                    "failed to remove temporary extraction directory " +
                    "'$workspace': $($_.Exception.Message)"
                )
            }
        }
    }
}

Export-ModuleMember -Function Expand-SafeXiphTar

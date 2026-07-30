[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootPath = [IO.Path]::GetFullPath($Root)
$rootDirectory = [IO.DirectoryInfo]::new($rootPath)

if (-not $rootDirectory.Exists) {
    throw "Bundle root does not exist or is not a directory: $rootPath"
}

$reparsePointAttribute = [IO.FileAttributes]::ReparsePoint

if (($rootDirectory.Attributes -band $reparsePointAttribute) -ne 0) {
    throw "Bundle root is a Windows reparse point: $rootPath"
}

$pendingDirectories =
[Collections.Generic.Stack[IO.DirectoryInfo]]::new()

$pendingDirectories.Push($rootDirectory)

while ($pendingDirectories.Count -gt 0) {
    $currentDirectory = $pendingDirectories.Pop()

    foreach ($entry in $currentDirectory.EnumerateFileSystemInfos()) {
        if (($entry.Attributes -band $reparsePointAttribute) -ne 0) {
            throw "Bundle contains a Windows reparse point: $($entry.FullName)"
        }

        if ($entry -is [IO.DirectoryInfo]) {
            $pendingDirectories.Push($entry)
        }
    }
}

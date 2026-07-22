param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]] $Paths
)

$ErrorActionPreference = 'Stop'
$authenticodeModule = Join-Path $PSScriptRoot 'lib/authenticode-inspector.psm1'
Import-Module -Name $authenticodeModule -Force

$results = foreach ($filePath in $Paths) {
    $resolved = (Resolve-Path -LiteralPath $filePath).Path
    $stream = [System.IO.File]::OpenRead($resolved)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "Not a PE file: $resolved"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -gt ($stream.Length - 6)) {
            throw "PE header is outside the file: $resolved"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Invalid PE signature: $resolved"
        }
        $machine = $reader.ReadUInt16()
        $architecture = switch ($machine) {
            0x014C { 'X86' }
            0x8664 { 'X64' }
            default { throw "Unsupported PE machine 0x$($machine.ToString('X4')): $resolved" }
        }
    }
    finally {
        $stream.Dispose()
    }

    $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($resolved)
    if ([string]::IsNullOrWhiteSpace($version.FileVersion) -or
        $version.FileMajorPart -lt 0 -or $version.FileMinorPart -lt 0 -or
        $version.FileBuildPart -lt 0 -or $version.FilePrivatePart -lt 0) {
        throw "Missing numeric FileVersion: $resolved"
    }

    $signature = Get-VerifiedAuthenticodeMetadata -Path $resolved

    [ordered]@{
        path = $resolved
        architecture = $architecture
        pe_version = "$($version.FileMajorPart).$($version.FileMinorPart).$($version.FileBuildPart).$($version.FilePrivatePart)"
        signature = $signature
    }
}

@($results) | ConvertTo-Json -Compress -Depth 5

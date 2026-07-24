param(
    [ValidateSet('RequireSigned', 'AllowUnsigned')]
    [string] $AuthenticodeMode = 'RequireSigned',

    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Paths
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module -Name (
    Join-Path $PSScriptRoot 'lib/pe-inspector.psm1'
) -Force
Import-Module -Name (
    Join-Path $PSScriptRoot 'lib/authenticode-inspector.psm1'
) -Force

$results = foreach ($filePath in $Paths) {
    $resolved = (Resolve-Path -LiteralPath $filePath).Path
    $metadata = Get-PeMetadata -Path $resolved
    $signature = Get-AuthenticodeMetadata `
        -Path $resolved `
        -Mode $AuthenticodeMode

    [ordered]@{
        path = $resolved
        architecture = $metadata.architecture
        pe_version = $metadata.pe_version
        pe_named_exports = $metadata.pe_named_exports
        signature = $signature
    }
}

@($results) | ConvertTo-Json -Compress -Depth 6

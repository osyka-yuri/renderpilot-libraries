[CmdletBinding()]
param(
    [ValidateSet('RequireSigned', 'AllowUnsigned')]
    [string] $AuthenticodeMode = 'RequireSigned',

    [Parameter(
        Mandatory = $true,
        Position = 0,
        ValueFromRemainingArguments = $true
    )]
    [ValidateNotNullOrEmpty()]
    [string[]] $Paths
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-PeInputFilePath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string] $LiteralPath
    )

    $item = Get-Item -LiteralPath $LiteralPath -Force

    if ($item -isnot [System.IO.FileInfo]) {
        throw "PE input path is not a file: $LiteralPath"
    }

    return $item.FullName
}

$moduleDirectory = Join-Path -Path $PSScriptRoot -ChildPath 'lib'
$moduleNames = @(
    'pe-inspector.psm1'
    'authenticode-inspector.psm1'
)

foreach ($moduleName in $moduleNames) {
    $modulePath = Join-Path -Path $moduleDirectory -ChildPath $moduleName
    Import-Module -Name $modulePath -Force -Scope Local
}

$results = foreach ($path in $Paths) {
    $resolvedPath = Resolve-PeInputFilePath -LiteralPath $path

    $peMetadata = Get-PeMetadata -Path $resolvedPath
    $authenticodeMetadata = Get-AuthenticodeMetadata `
        -Path $resolvedPath `
        -Mode $AuthenticodeMode

    [pscustomobject][ordered]@{
        path             = $resolvedPath
        architecture     = $peMetadata.architecture
        pe_version       = $peMetadata.pe_version
        pe_named_exports = $peMetadata.pe_named_exports
        pe_imports       = $peMetadata.pe_imports
        signature        = $authenticodeMetadata
    }
}

ConvertTo-Json `
    -InputObject @($results) `
    -Compress `
    -Depth 6
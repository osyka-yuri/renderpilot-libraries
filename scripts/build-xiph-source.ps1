[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string] $LockFile = (
        Join-Path $PSScriptRoot '../catalogs/libraries/xiph.lock.json'
    ),

    [ValidateNotNullOrEmpty()]
    [string] $OutputDirectory = (
        Join-Path $PSScriptRoot '../.artifacts/xiph'
    ),

    [string] $PairKey,

    [switch] $KeepArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pipelineModulePath = Join-Path `
    $PSScriptRoot `
    'xiph/build-pipeline.psm1'

Import-Module `
    -Name $pipelineModulePath `
    -Force `
    -Scope Local `
    -ErrorAction Stop

$parameters = @{
    ScriptRoot      = $PSScriptRoot
    EntryScriptPath = $PSCommandPath
    LockFile        = $LockFile
    OutputDirectory = $OutputDirectory
    PairKey         = $PairKey
    KeepArtifacts   = $KeepArtifacts.IsPresent
}

Invoke-XiphBuildFromLock @parameters

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$modulePath = [IO.Path]::GetFullPath(
    (
        Join-Path `
            -Path $PSScriptRoot `
            -ChildPath '../xiph/build-results.psm1'
    )
)

if (-not [IO.File]::Exists($modulePath)) {
    throw "Xiph build-results module does not exist: $modulePath"
}

$importParameters = @{
    Name        = $modulePath
    Force       = $true
    PassThru    = $true
    ErrorAction = 'Stop'
}

[System.Management.Automation.PSModuleInfo] $buildResultsModule = `
    Import-Module @importParameters

& $buildResultsModule {
    # The child scope keeps test-only helpers out of the module session state.
    & {
        function Assert-CommandFailsExactly {
            [CmdletBinding()]
            param(
                [Parameter(Mandatory)]
                [System.Management.Automation.CommandInfo] $Command,

                [Parameter(Mandatory)]
                [hashtable] $CommandParameters,

                [Parameter(Mandatory)]
                [ValidateNotNullOrEmpty()]
                [string] $ExpectedMessage,

                [Parameter(Mandatory)]
                [ValidateNotNullOrEmpty()]
                [string] $Scenario
            )

            try {
                $null = & $Command @CommandParameters
            }
            catch {
                $actualMessage = $_.Exception.Message

                if ($actualMessage -ceq $ExpectedMessage) {
                    return
                }

                throw (
                    "Scenario '$Scenario' returned an unexpected error. " +
                    "Expected: '$ExpectedMessage'. Actual: '$actualMessage'."
                )
            }

            throw (
                "Scenario '$Scenario' was expected to fail. " +
                "Expected error: '$ExpectedMessage'."
            )
        }

        $securityPolicyCommand = Get-Command `
            -Name 'Assert-XiphSecurityPolicy' `
            -CommandType Function `
            -ErrorAction Stop
        $windowsFileVersionCommand = Get-Command `
            -Name 'Get-XiphWindowsFileVersion' `
            -CommandType Function `
            -ErrorAction Stop

        $validSecurity = [ordered] @{
            high_entropy_va = $true
            dynamic_base    = $true
            nx_compat       = $true
            guard_cf        = $true
        }

        $validPolicyParameters = @{
            Path         = '<valid fixture>'
            Security     = $validSecurity
            Requirements = @(
                'high_entropy_va'
                'dynamic_base'
                'nx_compat'
                'guard_cf'
            )
        }

        Assert-XiphSecurityPolicy @validPolicyParameters

        $failureCases = @(
            [pscustomobject] @{
                scenario         = 'Unknown security requirement is rejected'
                path             = '<unknown requirement>'
                security         = $validSecurity
                requirements     = @('unknown')
                expected_message = (
                    'unsupported PE security policy requirement: unknown'
                )
            }
            [pscustomobject] @{
                scenario         = 'Non-Boolean security value is rejected'
                path             = '<invalid type>'
                security         = [ordered] @{
                    high_entropy_va = $true
                    dynamic_base    = 1
                    nx_compat       = $true
                    guard_cf        = $true
                }
                requirements     = @('dynamic_base')
                expected_message = (
                    'unsupported PE security policy requirement: dynamic_base'
                )
            }
            [pscustomobject] @{
                scenario         = 'Disabled required security flag is rejected'
                path             = '<missing flag>'
                security         = [ordered] @{
                    high_entropy_va = $true
                    dynamic_base    = $true
                    nx_compat       = $true
                    guard_cf        = $false
                }
                requirements     = @('guard_cf')
                expected_message = (
                    "required PE security flag 'guard_cf' is absent: " +
                    '<missing flag>'
                )
            }
            [pscustomobject] @{
                scenario         = 'Empty security requirements are rejected'
                path             = '<empty requirements>'
                security         = $validSecurity
                requirements     = @()
                expected_message = (
                    'required PE security flags are absent: ' +
                    '<empty requirements>'
                )
            }
        )

        foreach ($testCase in $failureCases) {
            $commandParameters = @{
                Path         = $testCase.path
                Security     = $testCase.security
                Requirements = @($testCase.requirements)
            }

            $assertionParameters = @{
                Command           = $securityPolicyCommand
                CommandParameters = $commandParameters
                ExpectedMessage   = $testCase.expected_message
                Scenario          = $testCase.scenario
            }

            Assert-CommandFailsExactly @assertionParameters
        }

        $currentPowerShell = (Get-Process -Id $PID).Path
        $versionResourceText = (
            Get-Item `
                -LiteralPath $currentPowerShell `
                -ErrorAction Stop
        ).VersionInfo.FileVersion
        [version] $versionResource = $null

        if (-not [version]::TryParse(
                $versionResourceText,
                [ref] $versionResource
            )) {
            throw (
                'The current PowerShell executable has no valid ' +
                "Windows file version: $currentPowerShell"
            )
        }

        $actualFileVersion = Get-XiphWindowsFileVersion `
            -Path $currentPowerShell
        $expectedFileVersion = $versionResource.ToString()

        if ($actualFileVersion -cne $expectedFileVersion) {
            throw (
                'Windows file-version reader returned an unexpected value. ' +
                "Expected: '$expectedFileVersion'. " +
                "Actual: '$actualFileVersion'."
            )
        }

        $invalidVersionParameters = @{
            Command           = $windowsFileVersionCommand
            CommandParameters = @{
                Path = $PSCommandPath
            }
            ExpectedMessage   = (
                "tool has no valid Windows file version: $PSCommandPath"
            )
            Scenario          = 'A file without a version resource is rejected'
        }

        Assert-CommandFailsExactly @invalidVersionParameters
    }
}

Write-Output 'Xiph build-results contract tests passed.'

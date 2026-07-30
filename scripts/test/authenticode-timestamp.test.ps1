using namespace System
using namespace System.Globalization
using namespace System.Management.Automation
using namespace System.Reflection
using namespace System.Security.Cryptography
using namespace System.Security.Cryptography.Pkcs
using namespace System.Security.Cryptography.X509Certificates
using namespace System.Text

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$modulePath = Join-Path $PSScriptRoot '../lib/authenticode-inspector.psm1'
[PSModuleInfo] $inspectorModule = Import-Module -Name $modulePath -Force -PassThru

function Format-UtcTimestamp {
    param(
        [Parameter(Mandatory)]
        [DateTimeOffset] $Timestamp
    )

    return $Timestamp.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
        [CultureInfo]::InvariantCulture
    )
}

function Assert-Throws {
    param(
        [Parameter(Mandatory)]
        [scriptblock] $Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    try {
        $null = & $Action
    }
    catch {
        return
    }

    throw "Expected failure: $Description"
}

function Assert-AuthenticodeError {
    param(
        [Parameter(Mandatory)]
        [scriptblock] $Action,

        [Parameter(Mandatory)]
        [RenderPilot.Tooling.AuthenticodeInspectionError] $Code,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Description
    )

    try {
        $null = & $Action
    }
    catch {
        $exception = $_.Exception

        while ($null -ne $exception) {
            if ($exception -is [RenderPilot.Tooling.AuthenticodeInspectionException]) {
                if ($exception.Code -ne $Code) {
                    throw "${Description}: expected $Code, got $($exception.Code)"
                }

                return
            }

            $exception = $exception.InnerException
        }

        throw "${Description}: exception was not typed"
    }

    throw "Expected Authenticode failure: $Description"
}

function Find-UniqueByteSequence {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [byte[]] $Haystack,

        [Parameter(Mandatory)]
        [byte[]] $Needle
    )

    if ($Needle.Length -eq 0) {
        throw 'Byte sequence must not be empty'
    }

    $matchCount = 0
    $matchOffset = -1
    $lastCandidateOffset = $Haystack.Length - $Needle.Length

    for ($offset = 0; $offset -le $lastCandidateOffset; $offset++) {
        $isMatch = $true

        for ($index = 0; $index -lt $Needle.Length; $index++) {
            if ($Haystack[$offset + $index] -ne $Needle[$index]) {
                $isMatch = $false
                break
            }
        }

        if ($isMatch) {
            $matchCount++
            $matchOffset = $offset
        }
    }

    if ($matchCount -ne 1) {
        throw "Expected one byte-sequence match, got $matchCount"
    }

    return $matchOffset
}

function Copy-BytesWithFlippedBit {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [int] $Offset
    )

    if ($Offset -lt 0 -or $Offset -ge $Bytes.Length) {
        throw "Byte offset is outside the array: $Offset"
    }

    [byte[]] $copy = $Bytes.Clone()
    $copy[$Offset] = $copy[$Offset] -bxor 1
    return , $copy
}

function Copy-BytesWithFlippedSequenceBit {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Bytes,

        [Parameter(Mandatory)]
        [byte[]] $Sequence
    )

    $offset = Find-UniqueByteSequence -Haystack $Bytes -Needle $Sequence
    return Copy-BytesWithFlippedBit -Bytes $Bytes -Offset $offset
}

function Read-JsonFixture {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    $json = Get-Content -LiteralPath $Path -Raw
    $parameters = @{ InputObject = $json }

    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        $parameters.DateKind = 'String'
    }

    return ConvertFrom-Json @parameters
}

function New-TestIdentity {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Subject,

        [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow
    )

    $key = [RSA]::Create(2048)

    try {
        $request = [CertificateRequest]::new(
            $Subject,
            $key,
            [HashAlgorithmName]::SHA256,
            [RSASignaturePadding]::Pkcs1
        )
        $certificate = $request.CreateSelfSigned(
            $Now.AddDays(-1),
            $Now.AddDays(1)
        )

        return [pscustomobject]@{
            Key         = $key
            Certificate = $certificate
        }
    }
    catch {
        $key.Dispose()
        throw
    }
}

function Close-TestIdentity {
    param(
        [AllowNull()]
        [object] $Identity
    )

    if ($null -eq $Identity) {
        return
    }

    try {
        $Identity.Certificate.Dispose()
    }
    finally {
        $Identity.Key.Dispose()
    }
}

function New-TestCmsSigner {
    param(
        [Parameter(Mandatory)]
        [X509Certificate2] $Certificate,

        [DateTime] $SigningTime
    )

    $signer = [CmsSigner]::new($Certificate)
    $signer.IncludeOption = [X509IncludeOption]::EndCertOnly

    if ($PSBoundParameters.ContainsKey('SigningTime')) {
        $null = $signer.SignedAttributes.Add(
            [Pkcs9SigningTime]::new($SigningTime)
        )
    }

    return $signer
}

function New-TestSignedCms {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Content,

        [Parameter(Mandatory)]
        [X509Certificate2] $Certificate
    )

    $contentInfo = [ContentInfo]::new([Encoding]::UTF8.GetBytes($Content))
    $cms = [SignedCms]::new($contentInfo, $false)
    $cms.ComputeSignature((New-TestCmsSigner -Certificate $Certificate))
    return $cms
}

function Add-TestCounterSignature {
    param(
        [Parameter(Mandatory)]
        [SignedCms] $Cms,

        [Parameter(Mandatory)]
        [X509Certificate2] $Certificate,

        [DateTime] $SigningTime
    )

    $signerParameters = @{ Certificate = $Certificate }
    if ($PSBoundParameters.ContainsKey('SigningTime')) {
        $signerParameters.SigningTime = $SigningTime
    }

    $signer = New-TestCmsSigner @signerParameters
    $Cms.SignerInfos[0].ComputeCounterSignature($signer)
}

function Get-PrivateVerifiedSignerTimestamp {
    param(
        [Parameter(Mandatory)]
        [PSModuleInfo] $Module,

        [Parameter(Mandatory)]
        [SignedCms] $Cms,

        [AllowNull()]
        [string] $TrustedTimestampSignerThumbprint,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    return & $Module {
        param($Cms, $TrustedTimestampSignerThumbprint, $Path)

        $parameters = @{
            Signer                           = $Cms.SignerInfos[0]
            Cms                              = $Cms
            SignerIndex                      = 0
            TrustedTimestampSignerThumbprint = $TrustedTimestampSignerThumbprint
            Path                             = $Path
        }
        Get-VerifiedSignerTimestamp @parameters
    } $Cms $TrustedTimestampSignerThumbprint $Path
}

function Invoke-PrivateMatchingSignerRecords {
    param(
        [Parameter(Mandatory)]
        [PSModuleInfo] $Module,

        [Parameter(Mandatory)]
        [object] $Signer,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Thumbprint,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Path
    )

    & $Module {
        param($Signer, $Thumbprint, $Path)

        $parameters = @{
            Records    = @([pscustomobject]@{ Signer = $Signer })
            Thumbprint = $Thumbprint
            Path       = $Path
        }
        Get-MatchingSignerRecords @parameters
    } $Signer $Thumbprint $Path
}

function Get-EncodedPkcs9Parts {
    param(
        [Parameter(Mandatory)]
        [byte[]] $EncodedCms
    )

    $nativeType = [RenderPilot.Tooling.AuthenticodeTimestampNative]
    $bindingFlags = [BindingFlags]::NonPublic -bor [BindingFlags]::Static
    $extractSignerInfo = $nativeType.GetMethod('ExtractSignerInfo', $bindingFlags)
    $extractCounterSignerInfo = $nativeType.GetMethod(
        'ExtractCounterSignerInfo',
        $bindingFlags
    )

    if ($null -eq $extractSignerInfo -or $null -eq $extractCounterSignerInfo) {
        throw 'Required Authenticode reflection helpers were not found'
    }

    [object[]] $signerArguments = @([object] $EncodedCms, [int] 0)
    [byte[]] $encodedSignerInfo = $extractSignerInfo.Invoke(
        $null,
        $signerArguments
    )

    [object[]] $counterSignerArguments = @([object] $encodedSignerInfo, [int] 0)
    [byte[]] $encodedCounterSignerInfo = $extractCounterSignerInfo.Invoke(
        $null,
        $counterSignerArguments
    )

    return [pscustomobject]@{
        SignerInfo        = $encodedSignerInfo
        CounterSignerInfo = $encodedCounterSignerInfo
    }
}

function Invoke-Rfc3161Tests {
    $fixturePath = Join-Path $PSScriptRoot 'fixtures/authenticode-rfc3161-legacy.json'
    $fixture = Read-JsonFixture -Path $fixturePath

    [byte[]] $token = [Convert]::FromBase64String(
        $fixture.timestamp_token_base64
    )
    [byte[]] $signedValue = [Convert]::FromBase64String(
        $fixture.signed_value_base64
    )

    $verifiedSignerThumbprint = [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161AndGetSignerThumbprint(
        $token,
        $signedValue
    )

    $timestampCms = [SignedCms]::new()
    $timestampCms.Decode($token)
    $decodedSignerCertificate = $timestampCms.SignerInfos[0].Certificate

    if ($null -eq $decodedSignerCertificate -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals(
            $verifiedSignerThumbprint,
            $decodedSignerCertificate.Thumbprint
        )) {
        throw "$($fixture.source): native RFC 3161 signer identity is inconsistent"
    }

    $tokenInfo = $null
    [int] $bytesConsumed = 0
    $content = $timestampCms.ContentInfo.Content
    $decoded = [Rfc3161TimestampTokenInfo]::TryDecode(
        [ReadOnlyMemory[byte]]::new($content),
        [ref] $tokenInfo,
        [ref] $bytesConsumed
    )

    if (-not $decoded -or $bytesConsumed -ne $content.Length) {
        throw "$($fixture.source): failed to decode verified TSTInfo"
    }

    $actualTimestamp = Format-UtcTimestamp -Timestamp $tokenInfo.Timestamp
    if ($actualTimestamp -ne $fixture.expected_timestamp) {
        throw (
            "$($fixture.source): expected $($fixture.expected_timestamp), " +
            "got $actualTimestamp"
        )
    }

    [byte[]] $tamperedToken = Copy-BytesWithFlippedBit -Bytes $token -Offset ($token.Length - 1)
    Assert-Throws -Description 'tampered RFC 3161 token' -Action {
        [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161AndGetSignerThumbprint(
            $tamperedToken,
            $signedValue
        )
    }

    [byte[]] $wrongSignedValue = Copy-BytesWithFlippedBit -Bytes $signedValue -Offset 0
    Assert-Throws -Description 'timestamp bound to a different Authenticode signature' -Action {
        [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161AndGetSignerThumbprint(
            $token,
            $wrongSignedValue
        )
    }
}

function Invoke-UntimestampedCmsTest {
    param(
        [Parameter(Mandatory)]
        [PSModuleInfo] $Module
    )

    $identity = $null

    try {
        $identity = New-TestIdentity -Subject 'CN=RenderPilot timestamp test'
        $cms = New-TestSignedCms -Content 'untimestamped CMS' -Certificate $identity.Certificate
        $timestamp = Get-PrivateVerifiedSignerTimestamp -Module $Module -Cms $cms -Path '<synthetic untimestamped CMS>'

        if ($null -ne $timestamp) {
            throw "Untimestamped CMS unexpectedly produced $timestamp"
        }
    }
    finally {
        Close-TestIdentity -Identity $identity
    }
}

function Invoke-Pkcs9Tests {
    param(
        [Parameter(Mandatory)]
        [PSModuleInfo] $Module
    )

    $primaryIdentity = $null
    $timestampIdentity = $null
    $wrongIdentity = $null
    $fixtureCertificate = $null

    try {
        $now = [DateTimeOffset]::UtcNow
        $primaryIdentity = New-TestIdentity -Subject 'CN=RenderPilot primary signer fixture' -Now $now
        $timestampIdentity = New-TestIdentity -Subject 'CN=RenderPilot timestamp signer fixture' -Now $now
        $wrongIdentity = New-TestIdentity -Subject 'CN=RenderPilot wrong timestamp signer' -Now $now

        $counterSignedCms = New-TestSignedCms -Content 'PKCS#9 fixture' -Certificate $primaryIdentity.Certificate
        $legacySigningTime = [DateTime]::UtcNow
        $legacySigningTime = $legacySigningTime.AddTicks(
            - ($legacySigningTime.Ticks % [TimeSpan]::TicksPerSecond)
        )
        Add-TestCounterSignature `
            -Cms $counterSignedCms `
            -Certificate $timestampIdentity.Certificate `
            -SigningTime $legacySigningTime

        [byte[]] $encodedCms = $counterSignedCms.Encode()
        $counterSigner = $counterSignedCms.SignerInfos[0].CounterSignerInfos[0]
        $encodedParts = Get-EncodedPkcs9Parts -EncodedCms $encodedCms
        [byte[]] $encodedSignerInfo = $encodedParts.SignerInfo
        [byte[]] $encodedCounterSignerInfo = $encodedParts.CounterSignerInfo
        [byte[]] $encodedCertificate = $counterSigner.Certificate.Export(
            [X509ContentType]::Cert
        )
        $fixtureCertificate = [X509Certificate2]::new($encodedCertificate)

        [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
            $encodedSignerInfo,
            $encodedCounterSignerInfo,
            $fixtureCertificate
        )

        $trustedTimestamp = Get-PrivateVerifiedSignerTimestamp `
            -Module $Module `
            -Cms $counterSignedCms `
            -TrustedTimestampSignerThumbprint $timestampIdentity.Certificate.Thumbprint `
            -Path '<trusted PKCS#9 fixture>'
        $expectedTrustedTimestamp = Format-UtcTimestamp -Timestamp (
            [DateTimeOffset] $legacySigningTime
        )

        if ($trustedTimestamp -cne $expectedTrustedTimestamp) {
            throw (
                'Trusted PKCS#9 timestamp was decoded incorrectly: ' +
                "expected '$expectedTrustedTimestamp', got '$trustedTimestamp'"
            )
        }

        Assert-AuthenticodeError -Code UntrustedTimestamp -Description 'timestamp absent from Windows trust result' -Action {
            Get-PrivateVerifiedSignerTimestamp `
                -Module $Module `
                -Cms $counterSignedCms `
                -TrustedTimestampSignerThumbprint $null `
                -Path '<untrusted PKCS#9 fixture>'
        }

        Assert-AuthenticodeError -Code UntrustedTimestamp -Description 'timestamp signer differs from Windows trust result' -Action {
            Get-PrivateVerifiedSignerTimestamp `
                -Module $Module `
                -Cms $counterSignedCms `
                -TrustedTimestampSignerThumbprint $wrongIdentity.Certificate.Thumbprint `
                -Path '<mismatched PKCS#9 trust fixture>'
        }

        [byte[]] $originalSignature = $counterSignedCms.SignerInfos[0].GetSignature()
        [byte[]] $tamperedOriginal = Copy-BytesWithFlippedSequenceBit -Bytes $encodedSignerInfo -Sequence $originalSignature
        Assert-Throws -Description 'PKCS#9 countersignature bound to original digest' -Action {
            [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                $tamperedOriginal,
                $encodedCounterSignerInfo,
                $fixtureCertificate
            )
        }

        [byte[]] $counterSignature = $counterSigner.GetSignature()
        [byte[]] $tamperedCounterSigner = Copy-BytesWithFlippedSequenceBit -Bytes $encodedCounterSignerInfo -Sequence $counterSignature
        Assert-Throws -Description 'tampered PKCS#9 countersignature' -Action {
            [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                $encodedSignerInfo,
                $tamperedCounterSigner,
                $fixtureCertificate
            )
        }

        Assert-Throws -Description 'PKCS#9 countersigner certificate identity' -Action {
            [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                $encodedSignerInfo,
                $encodedCounterSignerInfo,
                $wrongIdentity.Certificate
            )
        }

        Assert-AuthenticodeError -Code MalformedCms -Description 'malformed PKCS#9 CMS' -Action {
            [void] [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9Countersignature(
                [byte[]] @(1, 2, 3),
                0,
                0,
                $timestampIdentity.Certificate
            )
        }

        [byte[]] $tamperedCmsBytes = Copy-BytesWithFlippedSequenceBit -Bytes $encodedCms -Sequence $counterSignature
        $tamperedCms = [SignedCms]::new()
        $tamperedCms.Decode($tamperedCmsBytes)
        Assert-AuthenticodeError -Code InvalidPkcs9 -Description 'typed invalid PKCS#9 crypto' -Action {
            Get-PrivateVerifiedSignerTimestamp `
                -Module $Module `
                -Cms $tamperedCms `
                -TrustedTimestampSignerThumbprint $timestampIdentity.Certificate.Thumbprint `
                -Path '<tampered PKCS#9 fixture>'
        }

        Assert-AuthenticodeError -Code SignerMismatch -Description 'typed signer certificate mismatch' -Action {
            Invoke-PrivateMatchingSignerRecords -Module $Module -Signer $counterSignedCms.SignerInfos[0] -Thumbprint ('0' * 40) -Path '<signer mismatch fixture>'
        }

        $unsupportedCms = New-TestSignedCms -Content 'unsupported PKCS#9 fixture' -Certificate $primaryIdentity.Certificate
        Add-TestCounterSignature -Cms $unsupportedCms -Certificate $timestampIdentity.Certificate
        Assert-AuthenticodeError -Code UnsupportedStructure -Description 'PKCS#9 countersignature without signingTime' -Action {
            Get-PrivateVerifiedSignerTimestamp `
                -Module $Module `
                -Cms $unsupportedCms `
                -TrustedTimestampSignerThumbprint $timestampIdentity.Certificate.Thumbprint `
                -Path '<unsupported PKCS#9 fixture>'
        }

        Add-TestCounterSignature -Cms $counterSignedCms -Certificate $timestampIdentity.Certificate -SigningTime ([DateTime]::UtcNow.AddHours(-1))
        Assert-AuthenticodeError -Code ConflictingTimestamps -Description 'conflicting verified PKCS#9 timestamps' -Action {
            Get-PrivateVerifiedSignerTimestamp `
                -Module $Module `
                -Cms $counterSignedCms `
                -TrustedTimestampSignerThumbprint $timestampIdentity.Certificate.Thumbprint `
                -Path '<conflicting PKCS#9 fixture>'
        }
    }
    finally {
        if ($null -ne $fixtureCertificate) {
            $fixtureCertificate.Dispose()
        }
        Close-TestIdentity -Identity $wrongIdentity
        Close-TestIdentity -Identity $timestampIdentity
        Close-TestIdentity -Identity $primaryIdentity
    }
}

function Invoke-UnsignedMetadataTests {
    $fileName = "renderpilot-unsigned-$([Guid]::NewGuid().ToString('N')).dll"
    $unsignedPath = Join-Path ([IO.Path]::GetTempPath()) $fileName

    try {
        $typeDefinition = @'
public static class RenderPilotUnsignedFixture
{
    public static int Value => 1;
}
'@
        $addTypeParameters = @{
            TypeDefinition = $typeDefinition
            OutputAssembly = $unsignedPath
        }
        $null = Add-Type @addTypeParameters

        $unsigned = Get-AuthenticodeMetadata -Path $unsignedPath -Mode AllowUnsigned
        if ($unsigned.status -ne 'unsigned' -or $unsigned.Count -ne 1) {
            throw 'AllowUnsigned mode did not return the canonical unsigned result'
        }

        Assert-AuthenticodeError -Code UnsignedNotAllowed -Description 'RequireSigned mode rejects unsigned files' -Action {
            Get-AuthenticodeMetadata -Path $unsignedPath -Mode RequireSigned
        }
    }
    finally {
        if ([IO.File]::Exists($unsignedPath)) {
            [IO.File]::Delete($unsignedPath)
        }
    }
}

function Invoke-InspectorIntegrationTest {
    $pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
    $inspectorPath = Join-Path $PSScriptRoot '../inspect-pe.ps1'
    $inspectionLines = & $pwshPath -NoLogo -NoProfile -File $inspectorPath -AuthenticodeMode RequireSigned $pwshPath
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        throw "PE inspector failed for ${pwshPath}: exit code $exitCode"
    }

    $inspectionJson = $inspectionLines -join [Environment]::NewLine
    if ([string]::IsNullOrWhiteSpace($inspectionJson)) {
        throw "PE inspector returned no output for $pwshPath"
    }

    $inspection = ConvertFrom-Json -InputObject $inspectionJson
    if ($inspection.signature.status -ne 'signed' -or
        [string]::IsNullOrWhiteSpace($inspection.signature.signed_at)) {
        throw "PE inspector did not return a verified timestamp for $pwshPath"
    }
}

Invoke-Rfc3161Tests
Invoke-UntimestampedCmsTest -Module $inspectorModule
Invoke-Pkcs9Tests -Module $inspectorModule
Invoke-UnsignedMetadataTests
Invoke-InspectorIntegrationTest

Write-Output 'Authenticode timestamp tests passed.'

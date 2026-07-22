$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Format-UtcTimestamp {
    param([DateTimeOffset] $Timestamp)
    return $Timestamp.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock] $Action,

        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    try {
        & $Action
    }
    catch {
        return
    }
    throw "Expected failure: $Description"
}

$modulePath = Join-Path $PSScriptRoot '../lib/authenticode-inspector.psm1'
Import-Module -Name $modulePath -Force

$fixturePath = Join-Path $PSScriptRoot 'fixtures/authenticode-rfc3161-legacy.json'
$fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -DateKind String
$token = [Convert]::FromBase64String($fixture.timestamp_token_base64)
$signedValue = [Convert]::FromBase64String($fixture.signed_value_base64)
[RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161(
    $token,
    $signedValue
)
$timestampCms = [Security.Cryptography.Pkcs.SignedCms]::new()
$timestampCms.Decode($token)
$tokenInfo = $null
$bytesConsumed = 0
$decoded = [Security.Cryptography.Pkcs.Rfc3161TimestampTokenInfo]::TryDecode(
    [ReadOnlyMemory[byte]]::new($timestampCms.ContentInfo.Content),
    [ref]$tokenInfo,
    [ref]$bytesConsumed
)
if (-not $decoded -or $bytesConsumed -ne $timestampCms.ContentInfo.Content.Length) {
    throw "$($fixture.source): failed to decode verified TSTInfo"
}
$actual = Format-UtcTimestamp -Timestamp $tokenInfo.Timestamp
if ($actual -ne $fixture.expected_timestamp) {
    throw "$($fixture.source): expected $($fixture.expected_timestamp), got $actual"
}

$tamperedToken = [byte[]]$token.Clone()
$tamperedToken[$tamperedToken.Length - 1] = $tamperedToken[$tamperedToken.Length - 1] -bxor 1
Assert-Throws -Description 'tampered RFC 3161 token' -Action {
    [void][RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161(
        $tamperedToken,
        $signedValue
    )
}

$wrongSignedValue = [byte[]]$signedValue.Clone()
$wrongSignedValue[0] = $wrongSignedValue[0] -bxor 1
Assert-Throws -Description 'timestamp bound to a different Authenticode signature' -Action {
    [void][RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161(
        $token,
        $wrongSignedValue
    )
}

$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=RenderPilot timestamp test',
        $rsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $certificate = $request.CreateSelfSigned(
        [DateTimeOffset]::UtcNow.AddDays(-1),
        [DateTimeOffset]::UtcNow.AddDays(1)
    )
    try {
        $content = [Security.Cryptography.Pkcs.ContentInfo]::new(
            [Text.Encoding]::UTF8.GetBytes('untimestamped CMS')
        )
        $cms = [Security.Cryptography.Pkcs.SignedCms]::new($content, $false)
        $cmsSigner = [Security.Cryptography.Pkcs.CmsSigner]::new($certificate)
        $cmsSigner.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        $cms.ComputeSignature($cmsSigner)

        $module = Get-Module -Name authenticode-inspector
        $timestamp = & $module {
            param($Signer)
            Get-VerifiedSignerTimestamp -Signer $Signer -Path '<synthetic untimestamped CMS>'
        } $cms.SignerInfos[0]
        if ($null -ne $timestamp) {
            throw "Untimestamped CMS unexpectedly produced $timestamp"
        }
    }
    finally {
        $certificate.Dispose()
    }
}
finally {
    $rsa.Dispose()
}

$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$inspectorPath = Join-Path $PSScriptRoot '../inspect-pe.ps1'
$inspectionJson = & pwsh -NoLogo -NoProfile -File $inspectorPath $pwshPath
if ($LASTEXITCODE -ne 0) {
    throw "PE inspector failed for $pwshPath"
}
$inspection = $inspectionJson | ConvertFrom-Json
if ($inspection.signature.status -ne 'signed' -or
    [string]::IsNullOrWhiteSpace($inspection.signature.signed_at)) {
    throw "PE inspector did not return a verified timestamp for $pwshPath"
}

Write-Output 'Authenticode timestamp tests passed.'

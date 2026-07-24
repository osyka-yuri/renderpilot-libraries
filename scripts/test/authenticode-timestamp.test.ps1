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

function Find-UniqueByteSequence {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]] $Haystack,

        [Parameter(Mandatory = $true)]
        [byte[]] $Needle
    )

    $matches = [Collections.Generic.List[int]]::new()
    for ($offset = 0; $offset -le ($Haystack.Length - $Needle.Length); $offset++) {
        $equal = $true
        for ($index = 0; $index -lt $Needle.Length; $index++) {
            if ($Haystack[$offset + $index] -ne $Needle[$index]) {
                $equal = $false
                break
            }
        }
        if ($equal) {
            $matches.Add($offset)
        }
    }
    if ($matches.Count -ne 1) {
        throw "Expected one byte-sequence match, got $($matches.Count)"
    }
    return $matches[0]
}

function Assert-AuthenticodeError {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock] $Action,

        [Parameter(Mandatory = $true)]
        [RenderPilot.Tooling.AuthenticodeInspectionError] $Code,

        [Parameter(Mandatory = $true)]
        [string] $Description
    )

    try {
        & $Action
    }
    catch {
        $current = $_.Exception
        while ($null -ne $current) {
            if ($current -is [RenderPilot.Tooling.AuthenticodeInspectionException]) {
                if ($current.Code -ne $Code) {
                    throw "$Description`: expected $Code, got $($current.Code)"
                }
                return
            }
            $current = $current.InnerException
        }
        throw "$Description`: exception was not typed"
    }
    throw "Expected Authenticode failure: $Description"
}

$modulePath = Join-Path $PSScriptRoot '../lib/authenticode-inspector.psm1'
Import-Module -Name $modulePath -Force

$fixturePath = Join-Path $PSScriptRoot 'fixtures/authenticode-rfc3161-legacy.json'
$fixtureJson = Get-Content -LiteralPath $fixturePath -Raw
$convertFromJson = @{ InputObject = $fixtureJson }
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    $convertFromJson.DateKind = 'String'
}
$fixture = ConvertFrom-Json @convertFromJson
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
            param($Cms)
            Get-VerifiedSignerTimestamp `
                -Signer $Cms.SignerInfos[0] `
                -Cms $Cms `
                -SignerIndex 0 `
                -Path '<synthetic untimestamped CMS>'
        } $cms
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

$primaryRsa = [Security.Cryptography.RSA]::Create(2048)
$timestampRsa = [Security.Cryptography.RSA]::Create(2048)
$wrongRsa = [Security.Cryptography.RSA]::Create(2048)
try {
    $notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
    $notAfter = [DateTimeOffset]::UtcNow.AddDays(1)
    $primaryRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=RenderPilot primary signer fixture',
        $primaryRsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $timestampRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=RenderPilot timestamp signer fixture',
        $timestampRsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $wrongRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=RenderPilot wrong timestamp signer',
        $wrongRsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $primaryCertificate = $primaryRequest.CreateSelfSigned($notBefore, $notAfter)
    $timestampCertificate = $timestampRequest.CreateSelfSigned($notBefore, $notAfter)
    $wrongCertificate = $wrongRequest.CreateSelfSigned($notBefore, $notAfter)
    try {
        $counterSignedCms = [Security.Cryptography.Pkcs.SignedCms]::new(
            [Security.Cryptography.Pkcs.ContentInfo]::new(
                [Text.Encoding]::UTF8.GetBytes('PKCS#9 fixture')
            ),
            $false
        )
        $primarySigner = [Security.Cryptography.Pkcs.CmsSigner]::new(
            $primaryCertificate
        )
        $primarySigner.IncludeOption = `
            [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        $counterSignedCms.ComputeSignature($primarySigner)

        $timestampSigner = [Security.Cryptography.Pkcs.CmsSigner]::new(
            $timestampCertificate
        )
        $timestampSigner.IncludeOption = `
            [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        [void]$timestampSigner.SignedAttributes.Add(
            [Security.Cryptography.Pkcs.Pkcs9SigningTime]::new([DateTime]::UtcNow)
        )
        $counterSignedCms.SignerInfos[0].ComputeCounterSignature($timestampSigner)

        [byte[]] $encodedCms = $counterSignedCms.Encode()
        $counterSigner = $counterSignedCms.SignerInfos[0].CounterSignerInfos[0]
        $nativeType = [RenderPilot.Tooling.AuthenticodeTimestampNative]
        $nonPublicStatic = `
            [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
        $extractSignerInfo = $nativeType.GetMethod(
            'ExtractSignerInfo',
            $nonPublicStatic
        )
        $extractCounterSignerInfo = $nativeType.GetMethod(
            'ExtractCounterSignerInfo',
            $nonPublicStatic
        )
        [object[]] $signerArguments = @([object]$encodedCms, [int]0)
        [byte[]] $encodedSignerInfo = $extractSignerInfo.Invoke(
            $null,
            $signerArguments
        )
        [object[]] $counterSignerArguments = @([object]$encodedSignerInfo, [int]0)
        [byte[]] $encodedCounterSignerInfo = $extractCounterSignerInfo.Invoke(
            $null,
            $counterSignerArguments
        )
        [byte[]] $encodedCertificate = $counterSigner.Certificate.Export(
            [Security.Cryptography.X509Certificates.X509ContentType]::Cert
        )
        $fixtureCertificate = `
            [Security.Cryptography.X509Certificates.X509Certificate2]::new(
                $encodedCertificate
            )
        try {
            [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                $encodedSignerInfo,
                $encodedCounterSignerInfo,
                $fixtureCertificate
            )

            [byte[]] $tamperedOriginal = $encodedSignerInfo.Clone()
            [byte[]] $originalDigest = $counterSignedCms.SignerInfos[0].GetSignature()
            $originalDigestOffset = `
                Find-UniqueByteSequence $tamperedOriginal $originalDigest
            $tamperedOriginal[$originalDigestOffset] = `
                $tamperedOriginal[$originalDigestOffset] -bxor 1
            Assert-Throws `
                -Description 'PKCS#9 countersignature bound to original digest' `
                -Action {
                    [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                        $tamperedOriginal,
                        $encodedCounterSignerInfo,
                        $fixtureCertificate
                    )
                }

            [byte[]] $tamperedCounterSigner = $encodedCounterSignerInfo.Clone()
            [byte[]] $counterSignature = $counterSigner.GetSignature()
            $counterSignatureOffset = `
                Find-UniqueByteSequence $tamperedCounterSigner $counterSignature
            $tamperedCounterSigner[$counterSignatureOffset] = `
                $tamperedCounterSigner[$counterSignatureOffset] -bxor 1
            Assert-Throws -Description 'tampered PKCS#9 countersignature' -Action {
                [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                    $encodedSignerInfo,
                    $tamperedCounterSigner,
                    $fixtureCertificate
                )
            }

            Assert-Throws `
                -Description 'PKCS#9 countersigner certificate identity' `
                -Action {
                    [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9CountersignatureEncoded(
                        $encodedSignerInfo,
                        $encodedCounterSignerInfo,
                        $wrongCertificate
                    )
                }
        }
        finally {
            $fixtureCertificate.Dispose()
        }

        Assert-AuthenticodeError `
            -Code MalformedCms `
            -Description 'malformed PKCS#9 CMS' `
            -Action {
                [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9Countersignature(
                    [byte[]]@(1, 2, 3),
                    0,
                    0,
                    $timestampCertificate
                )
            }

        [byte[]] $tamperedCmsBytes = $encodedCms.Clone()
        $cmsCounterSignatureOffset = `
            Find-UniqueByteSequence $tamperedCmsBytes $counterSignature
        $tamperedCmsBytes[$cmsCounterSignatureOffset] = `
            $tamperedCmsBytes[$cmsCounterSignatureOffset] -bxor 1
        $tamperedCms = [Security.Cryptography.Pkcs.SignedCms]::new()
        $tamperedCms.Decode($tamperedCmsBytes)
        Assert-AuthenticodeError `
            -Code InvalidPkcs9 `
            -Description 'typed invalid PKCS#9 crypto' `
            -Action {
                & $module {
                    param($Cms)
                    Get-VerifiedSignerTimestamp `
                        -Signer $Cms.SignerInfos[0] `
                        -Cms $Cms `
                        -SignerIndex 0 `
                        -Path '<tampered PKCS#9 fixture>'
                } $tamperedCms
            }

        Assert-AuthenticodeError `
            -Code SignerMismatch `
            -Description 'typed signer certificate mismatch' `
            -Action {
                & $module {
                    param($Signer)
                    Get-MatchingSignerRecords `
                        -Records @([pscustomobject]@{ Signer = $Signer }) `
                        -Thumbprint ('0' * 40) `
                        -Path '<signer mismatch fixture>'
                } $counterSignedCms.SignerInfos[0]
            }

        $unsupportedCms = [Security.Cryptography.Pkcs.SignedCms]::new(
            [Security.Cryptography.Pkcs.ContentInfo]::new(
                [Text.Encoding]::UTF8.GetBytes('unsupported PKCS#9 fixture')
            ),
            $false
        )
        $unsupportedPrimarySigner = [Security.Cryptography.Pkcs.CmsSigner]::new(
            $primaryCertificate
        )
        $unsupportedPrimarySigner.IncludeOption = `
            [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        $unsupportedCms.ComputeSignature($unsupportedPrimarySigner)
        $missingTimeSigner = [Security.Cryptography.Pkcs.CmsSigner]::new(
            $timestampCertificate
        )
        $missingTimeSigner.IncludeOption = `
            [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        $unsupportedCms.SignerInfos[0].ComputeCounterSignature($missingTimeSigner)
        Assert-AuthenticodeError `
            -Code UnsupportedStructure `
            -Description 'PKCS#9 countersignature without signingTime' `
            -Action {
                & $module {
                    param($Cms)
                    Get-VerifiedSignerTimestamp `
                        -Signer $Cms.SignerInfos[0] `
                        -Cms $Cms `
                        -SignerIndex 0 `
                        -Path '<unsupported PKCS#9 fixture>'
                } $unsupportedCms
            }

        $secondTimestampSigner = [Security.Cryptography.Pkcs.CmsSigner]::new(
            $timestampCertificate
        )
        $secondTimestampSigner.IncludeOption = `
            [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
        [void]$secondTimestampSigner.SignedAttributes.Add(
            [Security.Cryptography.Pkcs.Pkcs9SigningTime]::new(
                [DateTime]::UtcNow.AddHours(-1)
            )
        )
        $counterSignedCms.SignerInfos[0].ComputeCounterSignature(
            $secondTimestampSigner
        )
        Assert-AuthenticodeError `
            -Code ConflictingTimestamps `
            -Description 'conflicting verified PKCS#9 timestamps' `
            -Action {
                & $module {
                    param($Cms)
                    Get-VerifiedSignerTimestamp `
                        -Signer $Cms.SignerInfos[0] `
                        -Cms $Cms `
                        -SignerIndex 0 `
                        -Path '<conflicting PKCS#9 fixture>'
                } $counterSignedCms
            }
    }
    finally {
        $primaryCertificate.Dispose()
        $timestampCertificate.Dispose()
        $wrongCertificate.Dispose()
    }
}
finally {
    $primaryRsa.Dispose()
    $timestampRsa.Dispose()
    $wrongRsa.Dispose()
}

$unsignedPath = Join-Path `
    ([IO.Path]::GetTempPath()) `
    "renderpilot-unsigned-$([Guid]::NewGuid().ToString('N')).dll"
try {
    Add-Type `
        -TypeDefinition 'public static class RenderPilotUnsignedFixture { public static int Value => 1; }' `
        -OutputAssembly $unsignedPath
    $unsigned = Get-AuthenticodeMetadata -Path $unsignedPath -Mode AllowUnsigned
    if ($unsigned.status -ne 'unsigned' -or $unsigned.Count -ne 1) {
        throw 'AllowUnsigned mode did not return the canonical unsigned result'
    }
    Assert-AuthenticodeError `
        -Code UnsignedNotAllowed `
        -Description 'RequireSigned mode rejects unsigned files' `
        -Action {
            Get-AuthenticodeMetadata -Path $unsignedPath -Mode RequireSigned
        }
}
finally {
    Remove-Item -LiteralPath $unsignedPath -Force
}

$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$inspectorPath = Join-Path $PSScriptRoot '../inspect-pe.ps1'
$inspectionJson = & pwsh -NoLogo -NoProfile -File $inspectorPath `
    -AuthenticodeMode RequireSigned `
    $pwshPath
if ($LASTEXITCODE -ne 0) {
    throw "PE inspector failed for $pwshPath"
}
$inspection = $inspectionJson | ConvertFrom-Json
if ($inspection.signature.status -ne 'signed' -or
    [string]::IsNullOrWhiteSpace($inspection.signature.signed_at)) {
    throw "PE inspector did not return a verified timestamp for $pwshPath"
}

Write-Output 'Authenticode timestamp tests passed.'

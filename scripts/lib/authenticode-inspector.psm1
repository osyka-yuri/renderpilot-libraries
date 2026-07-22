Set-StrictMode -Version Latest

$nativeSource = Join-Path $PSScriptRoot 'authenticode-timestamp-native.cs'
if ($null -eq ('RenderPilot.Tooling.AuthenticodeTimestampNative' -as [type])) {
    Add-Type -Path $nativeSource
}

$script:Rfc3161TimestampOid = '1.3.6.1.4.1.311.3.3.1'
$script:Rfc3161TstInfoOid = '1.2.840.113549.1.9.16.1.4'
$script:Pkcs9SigningTimeOid = '1.2.840.113549.1.9.5'
$script:NestedAuthenticodeSignatureOid = '1.3.6.1.4.1.311.2.4.1'
$script:PkcsSignedDataCertificateType = 0x0002
$script:MaximumNestedSignatureDepth = 4

function Format-UtcTimestamp {
    param(
        [Parameter(Mandatory = $true)]
        [DateTimeOffset] $Timestamp
    )

    return $Timestamp.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Read-EmbeddedAuthenticodeCms {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $stream = [IO.File]::OpenRead($Path)
    try {
        $peReader = [Reflection.PortableExecutable.PEReader]::new(
            $stream,
            [Reflection.PortableExecutable.PEStreamOptions]::LeaveOpen
        )
        try {
            $peHeader = $peReader.PEHeaders.PEHeader
            if ($null -eq $peHeader) {
                throw "Missing PE optional header: $Path"
            }
            $directory = $peHeader.CertificateTableDirectory
            $tableOffset = [long]$directory.RelativeVirtualAddress
            $tableSize = [long]$directory.Size
        }
        finally {
            $peReader.Dispose()
        }

        if ($tableOffset -le 0 -or $tableSize -lt 8) {
            throw "Missing embedded Authenticode certificate table: $Path"
        }
        $tableEnd = $tableOffset + $tableSize
        if ($tableEnd -lt $tableOffset -or $tableEnd -gt $stream.Length) {
            throw "Authenticode certificate table is outside the file: $Path"
        }

        $cmsDocuments = [Collections.Generic.List[object]]::new()
        $reader = [IO.BinaryReader]::new($stream, [Text.Encoding]::UTF8, $true)
        try {
            $entryOffset = $tableOffset
            while ($entryOffset -lt $tableEnd) {
                if (($tableEnd - $entryOffset) -lt 8) {
                    throw "Truncated WIN_CERTIFICATE header at offset $entryOffset`: $Path"
                }
                $stream.Position = $entryOffset
                $entryLength = [long]$reader.ReadUInt32()
                $revision = $reader.ReadUInt16()
                $certificateType = $reader.ReadUInt16()
                if ($entryLength -lt 8) {
                    throw "Invalid WIN_CERTIFICATE length $entryLength at offset $entryOffset`: $Path"
                }
                $entryEnd = $entryOffset + $entryLength
                if ($entryEnd -lt $entryOffset -or $entryEnd -gt $tableEnd) {
                    throw "WIN_CERTIFICATE at offset $entryOffset exceeds its PE table: $Path"
                }

                if ($certificateType -eq $script:PkcsSignedDataCertificateType) {
                    if ($revision -ne 0x0100 -and $revision -ne 0x0200) {
                        throw "Unsupported WIN_CERTIFICATE revision 0x$($revision.ToString('X4')): $Path"
                    }
                    $encoded = $reader.ReadBytes([int]($entryLength - 8))
                    if ($encoded.Length -ne ($entryLength - 8)) {
                        throw "Truncated Authenticode PKCS#7 payload at offset $entryOffset`: $Path"
                    }
                    $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
                    try {
                        $cms.Decode($encoded)
                    }
                    catch {
                        throw [IO.InvalidDataException]::new(
                            "Invalid Authenticode PKCS#7 payload at offset $entryOffset`: $Path",
                            $_.Exception
                        )
                    }
                    $cmsDocuments.Add($cms)
                }

                $alignedLength = ($entryLength + 7) -band (-bnot 7)
                $nextOffset = $entryOffset + $alignedLength
                if ($nextOffset -le $entryOffset -or $nextOffset -gt $tableEnd) {
                    throw "Invalid WIN_CERTIFICATE alignment at offset $entryOffset`: $Path"
                }
                $entryOffset = $nextOffset
            }
        }
        finally {
            $reader.Dispose()
        }

        if ($cmsDocuments.Count -eq 0) {
            throw "PE certificate table has no Authenticode PKCS#7 payload: $Path"
        }
        return @($cmsDocuments)
    }
    finally {
        $stream.Dispose()
    }
}

function Add-CmsSignerRecords {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [Collections.Generic.List[object]] $Records,

        [Parameter(Mandatory = $true)]
        [int] $Depth,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if ($Depth -gt $script:MaximumNestedSignatureDepth) {
        throw "Authenticode nested-signature depth exceeds $script:MaximumNestedSignatureDepth`: $Path"
    }

    foreach ($signer in $Cms.SignerInfos) {
        $Records.Add([pscustomobject]@{
            Signer = $signer
        })

        foreach ($attribute in $signer.UnsignedAttributes) {
            if ($attribute.Oid.Value -ne $script:NestedAuthenticodeSignatureOid) {
                continue
            }
            if ($attribute.Values.Count -eq 0) {
                throw "Empty nested Authenticode signature attribute: $Path"
            }
            foreach ($value in $attribute.Values) {
                $nestedCms = [Security.Cryptography.Pkcs.SignedCms]::new()
                try {
                    $nestedCms.Decode($value.RawData)
                }
                catch {
                    throw [IO.InvalidDataException]::new(
                        "Malformed nested Authenticode signature: $Path",
                        $_.Exception
                    )
                }
                Add-CmsSignerRecords -Cms $nestedCms -Records $Records -Depth ($Depth + 1) -Path $Path
            }
        }
    }
}

function Get-VerifiedRfc3161Timestamps {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $timestamps = [Collections.Generic.List[string]]::new()
    foreach ($attribute in $Signer.UnsignedAttributes) {
        if ($attribute.Oid.Value -ne $script:Rfc3161TimestampOid) {
            continue
        }
        if ($attribute.Values.Count -eq 0) {
            throw "Empty RFC 3161 timestamp attribute: $Path"
        }
        foreach ($value in $attribute.Values) {
            try {
                [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161(
                    $value.RawData,
                    $Signer.GetSignature()
                )
            }
            catch {
                throw [Security.Cryptography.CryptographicException]::new(
                    "RFC 3161 token does not verify the Authenticode signer: $Path",
                    $_.Exception
                )
            }

            $timestampCms = [Security.Cryptography.Pkcs.SignedCms]::new()
            try {
                $timestampCms.Decode($value.RawData)
            }
            catch {
                throw [IO.InvalidDataException]::new(
                    "Malformed RFC 3161 timestamp CMS: $Path",
                    $_.Exception
                )
            }
            if ($timestampCms.ContentInfo.ContentType.Value -ne $script:Rfc3161TstInfoOid) {
                throw "RFC 3161 timestamp CMS has unexpected content type: $Path"
            }
            $tokenInfo = $null
            $bytesConsumed = 0
            $encodedInfo = [ReadOnlyMemory[byte]]::new($timestampCms.ContentInfo.Content)
            if (-not [Security.Cryptography.Pkcs.Rfc3161TimestampTokenInfo]::TryDecode(
                    $encodedInfo,
                    [ref]$tokenInfo,
                    [ref]$bytesConsumed
                ) -or $bytesConsumed -ne $timestampCms.ContentInfo.Content.Length) {
                throw "Malformed RFC 3161 TSTInfo: $Path"
            }

            # CryptoAPI verified the CMS signature and message imprint above;
            # TSTInfo is that signed content and is the authoritative time value.
            $timestamps.Add((Format-UtcTimestamp -Timestamp $tokenInfo.Timestamp))
        }
    }
    return @($timestamps)
}

function Get-VerifiedLegacyTimestamps {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $timestamps = [Collections.Generic.List[string]]::new()
    foreach ($counterSigner in $Signer.CounterSignerInfos) {
        try {
            $counterSigner.CheckSignature($true)
        }
        catch {
            throw [Security.Cryptography.CryptographicException]::new(
                "Invalid Authenticode PKCS#9 countersignature: $Path",
                $_.Exception
            )
        }

        $signingTimeAttributes = @(
            $counterSigner.SignedAttributes |
                Where-Object { $_.Oid.Value -eq $script:Pkcs9SigningTimeOid }
        )
        if ($signingTimeAttributes.Count -ne 1 -or
            $signingTimeAttributes[0].Values.Count -ne 1) {
            throw "Authenticode countersignature must contain exactly one signingTime: $Path"
        }

        $signingTime = [Security.Cryptography.Pkcs.Pkcs9SigningTime]::new()
        try {
            $signingTime.CopyFrom($signingTimeAttributes[0].Values[0])
        }
        catch {
            throw [IO.InvalidDataException]::new(
                "Malformed Authenticode PKCS#9 signingTime: $Path",
                $_.Exception
            )
        }
        $timestamps.Add((Format-UtcTimestamp -Timestamp ([DateTimeOffset]$signingTime.SigningTime)))
    }
    return @($timestamps)
}

function Get-VerifiedSignerTimestamp {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $timestamps = @(
        Get-VerifiedRfc3161Timestamps -Signer $Signer -Path $Path
        Get-VerifiedLegacyTimestamps -Signer $Signer -Path $Path
    )
    $distinct = @($timestamps | Sort-Object -Unique)
    if ($distinct.Count -gt 1) {
        throw "Authenticode signer has conflicting verified timestamps: $Path"
    }
    if ($distinct.Count -eq 1) {
        return $distinct[0]
    }
    return $null
}

function Get-VerifiedAuthenticodeMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Invalid Authenticode signature ($($signature.Status)): $resolved"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "Valid Authenticode signature has no signer certificate: $resolved"
    }

    $records = [Collections.Generic.List[object]]::new()
    foreach ($cms in @(Read-EmbeddedAuthenticodeCms -Path $resolved)) {
        Add-CmsSignerRecords -Cms $cms -Records $records -Depth 0 -Path $resolved
    }

    $thumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    $matching = @(
        $records | Where-Object {
            $null -ne $_.Signer.Certificate -and
            $_.Signer.Certificate.Thumbprint.ToUpperInvariant() -eq $thumbprint
        }
    )
    if ($matching.Count -eq 0) {
        throw "Windows signer certificate is absent from embedded Authenticode CMS: $resolved"
    }

    $timestampStates = @(
        @(
            foreach ($record in $matching) {
                $timestamp = Get-VerifiedSignerTimestamp `
                    -Signer $record.Signer `
                    -Path $resolved
                if ($null -eq $timestamp) { '<none>' } else { $timestamp }
            }
        ) | Sort-Object -Unique
    )
    if ($timestampStates.Count -ne 1) {
        throw "Matching Authenticode signatures disagree about timestamp presence or value: $resolved"
    }
    $signedAt = if ($timestampStates[0] -eq '<none>') { $null } else { $timestampStates[0] }

    return [ordered]@{
        status = 'signed'
        subject = $signature.SignerCertificate.Subject
        thumbprint = $thumbprint
        signed_at = $signedAt
    }
}

Export-ModuleMember -Function Get-VerifiedAuthenticodeMetadata

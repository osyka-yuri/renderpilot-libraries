Set-StrictMode -Version Latest

$nativeSource = Join-Path $PSScriptRoot 'authenticode-timestamp-native.cs'
if ($null -eq ('RenderPilot.Tooling.AuthenticodeTimestampNative' -as [type])) {
    Add-Type -Path $nativeSource
}

$script:Rfc3161TimestampOid = '1.3.6.1.4.1.311.3.3.1'
$script:Rfc3161TstInfoOid = '1.2.840.113549.1.9.16.1.4'
$script:Pkcs9CounterSignatureOid = '1.2.840.113549.1.9.6'
$script:Pkcs9SigningTimeOid = '1.2.840.113549.1.9.5'
$script:NestedAuthenticodeSignatureOid = '1.3.6.1.4.1.311.2.4.1'
$script:PkcsSignedDataCertificateType = 0x0002
$script:MaximumNestedSignatureDepth = 4

function New-AuthenticodeInspectionException {
    param(
        [Parameter(Mandatory = $true)]
        [RenderPilot.Tooling.AuthenticodeInspectionError] $Code,

        [Parameter(Mandatory = $true)]
        [string] $Message,

        [Exception] $InnerException
    )

    if ($null -eq $InnerException) {
        return [RenderPilot.Tooling.AuthenticodeInspectionException]::new(
            $Code,
            $Message
        )
    }
    return [RenderPilot.Tooling.AuthenticodeInspectionException]::new(
        $Code,
        $Message,
        $InnerException
    )
}

function Find-AuthenticodeInspectionException {
    param(
        [Parameter(Mandatory = $true)]
        [Exception] $Exception
    )

    $current = $Exception
    while ($null -ne $current) {
        if ($current -is [RenderPilot.Tooling.AuthenticodeInspectionException]) {
            return $current
        }
        $current = $current.InnerException
    }
    return $null
}

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
                        throw (New-AuthenticodeInspectionException `
                            -Code UnsupportedStructure `
                            -Message "Unsupported WIN_CERTIFICATE revision 0x$($revision.ToString('X4')): $Path")
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
        throw (New-AuthenticodeInspectionException `
            -Code UnsupportedStructure `
            -Message "Authenticode nested-signature depth exceeds $script:MaximumNestedSignatureDepth`: $Path")
    }

    for ($signerIndex = 0; $signerIndex -lt $Cms.SignerInfos.Count; $signerIndex++) {
        $signer = $Cms.SignerInfos[$signerIndex]
        $Records.Add([pscustomobject]@{
            Signer = $signer
            Cms = $Cms
            SignerIndex = $signerIndex
        })

        foreach ($attribute in $signer.UnsignedAttributes) {
            if ($attribute.Oid.Value -ne $script:NestedAuthenticodeSignatureOid) {
                continue
            }
            if ($attribute.Values.Count -eq 0) {
                throw (New-AuthenticodeInspectionException `
                    -Code MalformedCms `
                    -Message "Empty nested Authenticode signature attribute: $Path")
            }
            foreach ($value in $attribute.Values) {
                $nestedCms = [Security.Cryptography.Pkcs.SignedCms]::new()
                try {
                    $nestedCms.Decode($value.RawData)
                }
                catch {
                    throw (New-AuthenticodeInspectionException `
                        -Code MalformedCms `
                        -Message "Malformed nested Authenticode signature: $Path" `
                        -InnerException $_.Exception)
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
            throw (New-AuthenticodeInspectionException `
                -Code MalformedCms `
                -Message "Empty RFC 3161 timestamp attribute: $Path")
        }
        foreach ($value in $attribute.Values) {
            $timestampCms = [Security.Cryptography.Pkcs.SignedCms]::new()
            try {
                $timestampCms.Decode($value.RawData)
            }
            catch {
                throw (New-AuthenticodeInspectionException `
                    -Code MalformedCms `
                    -Message "Malformed RFC 3161 timestamp CMS: $Path" `
                    -InnerException $_.Exception)
            }
            try {
                [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161(
                    $value.RawData,
                    $Signer.GetSignature()
                )
            }
            catch {
                throw (New-AuthenticodeInspectionException `
                    -Code InvalidRfc3161 `
                    -Message "RFC 3161 token does not verify the Authenticode signer: $Path" `
                    -InnerException $_.Exception)
            }
            if ($timestampCms.ContentInfo.ContentType.Value -ne $script:Rfc3161TstInfoOid) {
                throw (New-AuthenticodeInspectionException `
                    -Code UnsupportedStructure `
                    -Message "RFC 3161 timestamp CMS has unexpected content type: $Path")
            }
            $tokenInfo = $null
            $bytesConsumed = 0
            $encodedInfo = [ReadOnlyMemory[byte]]::new($timestampCms.ContentInfo.Content)
            if (-not [Security.Cryptography.Pkcs.Rfc3161TimestampTokenInfo]::TryDecode(
                    $encodedInfo,
                    [ref]$tokenInfo,
                    [ref]$bytesConsumed
                ) -or $bytesConsumed -ne $timestampCms.ContentInfo.Content.Length) {
                throw (New-AuthenticodeInspectionException `
                    -Code MalformedCms `
                    -Message "Malformed RFC 3161 TSTInfo: $Path")
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
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory = $true)]
        [int] $SignerIndex,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $counterSignatureAttributes = @(
        $Signer.UnsignedAttributes |
            Where-Object { $_.Oid.Value -eq $script:Pkcs9CounterSignatureOid }
    )
    $encodedCounterSignatures = @(
        foreach ($attribute in $counterSignatureAttributes) {
            foreach ($value in $attribute.Values) {
                $value
            }
        }
    )
    if ($encodedCounterSignatures.Count -ne $Signer.CounterSignerInfos.Count) {
        throw (New-AuthenticodeInspectionException `
            -Code MalformedCms `
            -Message "PKCS#9 countersignature attributes do not match decoded countersigners: $Path")
    }

    $timestamps = [Collections.Generic.List[string]]::new()
    for (
        $counterSignerIndex = 0;
        $counterSignerIndex -lt $Signer.CounterSignerInfos.Count;
        $counterSignerIndex++
    ) {
        $counterSigner = $Signer.CounterSignerInfos[$counterSignerIndex]
        if ($null -eq $counterSigner.Certificate) {
            throw (New-AuthenticodeInspectionException `
                -Code SignerMismatch `
                -Message "Authenticode countersigner certificate is missing: $Path")
        }
        try {
            [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9Countersignature(
                $Cms.Encode(),
                $SignerIndex,
                $counterSignerIndex,
                $counterSigner.Certificate
            )
        }
        catch {
            $typed = Find-AuthenticodeInspectionException -Exception $_.Exception
            if ($null -ne $typed) {
                throw $typed
            }
            throw (New-AuthenticodeInspectionException `
                -Code InvalidPkcs9 `
                -Message "Invalid Authenticode PKCS#9 countersignature: $Path" `
                -InnerException $_.Exception)
        }

        $signingTimeAttributes = @(
            $counterSigner.SignedAttributes |
                Where-Object { $_.Oid.Value -eq $script:Pkcs9SigningTimeOid }
        )
        if ($signingTimeAttributes.Count -ne 1 -or
            $signingTimeAttributes[0].Values.Count -ne 1) {
            throw (New-AuthenticodeInspectionException `
                -Code UnsupportedStructure `
                -Message "Authenticode countersignature must contain exactly one signingTime: $Path")
        }

        $signingTime = [Security.Cryptography.Pkcs.Pkcs9SigningTime]::new()
        try {
            $signingTime.CopyFrom($signingTimeAttributes[0].Values[0])
        }
        catch {
            throw (New-AuthenticodeInspectionException `
                -Code MalformedCms `
                -Message "Malformed Authenticode PKCS#9 signingTime: $Path" `
                -InnerException $_.Exception)
        }

        $timestamp = [DateTimeOffset]$signingTime.SigningTime
        $notBefore = [DateTimeOffset]$counterSigner.Certificate.NotBefore
        $notAfter = [DateTimeOffset]$counterSigner.Certificate.NotAfter
        if ($timestamp -lt $notBefore -or $timestamp -gt $notAfter) {
            throw (New-AuthenticodeInspectionException `
                -Code InvalidPkcs9 `
                -Message "Authenticode PKCS#9 signingTime is outside the countersigner certificate validity: $Path")
        }
        $timestamps.Add((Format-UtcTimestamp -Timestamp $timestamp))
    }
    return @($timestamps)
}

function Get-VerifiedSignerTimestamp {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory = $true)]
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory = $true)]
        [int] $SignerIndex,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $timestamps = @(
        Get-VerifiedRfc3161Timestamps -Signer $Signer -Path $Path
        Get-VerifiedLegacyTimestamps `
            -Signer $Signer `
            -Cms $Cms `
            -SignerIndex $SignerIndex `
            -Path $Path
    )
    $distinct = @($timestamps | Sort-Object -Unique)
    if ($distinct.Count -gt 1) {
        throw (New-AuthenticodeInspectionException `
            -Code ConflictingTimestamps `
            -Message "Authenticode signer has conflicting verified timestamps: $Path")
    }
    if ($distinct.Count -eq 1) {
        return $distinct[0]
    }
    return $null
}

function Get-MatchingSignerRecords {
    param(
        [Parameter(Mandatory = $true)]
        [object[]] $Records,

        [Parameter(Mandatory = $true)]
        [string] $Thumbprint,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $matching = @(
        $Records | Where-Object {
            $null -ne $_.Signer.Certificate -and
            $_.Signer.Certificate.Thumbprint.ToUpperInvariant() -eq $Thumbprint
        }
    )
    if ($matching.Count -eq 0) {
        throw (New-AuthenticodeInspectionException `
            -Code SignerMismatch `
            -Message "Windows signer certificate is absent from embedded Authenticode CMS: $Path")
    }
    return $matching
}

function Get-AuthenticodeMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [ValidateSet('Strict', 'OpenVr')]
        [string] $Policy
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -eq [Management.Automation.SignatureStatus]::NotSigned) {
        if ($Policy -eq 'OpenVr') {
            return [ordered]@{ status = 'unsigned' }
        }
        throw (New-AuthenticodeInspectionException `
            -Code UnsignedNotAllowed `
            -Message "Unsigned PE is forbidden by the Strict policy: $resolved")
    }
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw (New-AuthenticodeInspectionException `
            -Code InvalidSignature `
            -Message "Invalid Authenticode signature ($($signature.Status)): $resolved")
    }
    if ($null -eq $signature.SignerCertificate) {
        throw (New-AuthenticodeInspectionException `
            -Code SignerMismatch `
            -Message "Valid Authenticode signature has no signer certificate: $resolved")
    }

    $thumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    $records = [Collections.Generic.List[object]]::new()
    try {
        foreach ($cms in @(Read-EmbeddedAuthenticodeCms -Path $resolved)) {
            Add-CmsSignerRecords -Cms $cms -Records $records -Depth 0 -Path $resolved
        }
    }
    catch {
        $typed = Find-AuthenticodeInspectionException -Exception $_.Exception
        if ($null -ne $typed) {
            throw $typed
        }
        throw (New-AuthenticodeInspectionException `
            -Code MalformedCms `
            -Message "Unable to decode embedded Authenticode CMS: $resolved" `
            -InnerException $_.Exception)
    }

    $matching = @(
        Get-MatchingSignerRecords `
            -Records @($records) `
            -Thumbprint $thumbprint `
            -Path $resolved
    )

    $timestampStates = @(
        @(
            foreach ($record in $matching) {
                $timestamp = Get-VerifiedSignerTimestamp `
                    -Signer $record.Signer `
                    -Cms $record.Cms `
                    -SignerIndex $record.SignerIndex `
                    -Path $resolved
                if ($null -eq $timestamp) { '<none>' } else { $timestamp }
            }
        ) | Sort-Object -Unique
    )
    if ($timestampStates.Count -ne 1) {
        throw (New-AuthenticodeInspectionException `
            -Code ConflictingTimestamps `
            -Message "Matching Authenticode signatures disagree about timestamp presence or value: $resolved")
    }
    $signedAt = if ($timestampStates[0] -eq '<none>') {
        $null
    }
    else {
        $timestampStates[0]
    }

    return [ordered]@{
        status = 'signed'
        subject = $signature.SignerCertificate.Subject
        thumbprint = $thumbprint
        signed_at = $signedAt
    }
}

Export-ModuleMember -Function Get-AuthenticodeMetadata

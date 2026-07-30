Set-StrictMode -Version Latest

function Initialize-AuthenticodeTimestampNative {
    $typeName = 'RenderPilot.Tooling.AuthenticodeTimestampNative'
    if ($null -ne ($typeName -as [type])) {
        return
    }

    $sourcePath = Join-Path $PSScriptRoot 'authenticode-timestamp-native.cs'
    if (-not [IO.File]::Exists($sourcePath)) {
        throw [IO.FileNotFoundException]::new(
            'Authenticode timestamp native source was not found.',
            $sourcePath
        )
    }

    Add-Type -Path $sourcePath -ErrorAction Stop
}

Initialize-AuthenticodeTimestampNative

$script:Rfc3161TimestampOid = '1.3.6.1.4.1.311.3.3.1'
$script:Rfc3161TstInfoOid = '1.2.840.113549.1.9.16.1.4'
$script:Pkcs9CounterSignatureOid = '1.2.840.113549.1.9.6'
$script:Pkcs9SigningTimeOid = '1.2.840.113549.1.9.5'
$script:NestedAuthenticodeSignatureOid = '1.3.6.1.4.1.311.2.4.1'
$script:PkcsSignedDataCertificateType = 0x0002
$script:WinCertificateHeaderSize = 8L
$script:WinCertificateAlignment = 8L
$script:MaximumNestedSignatureDepth = 4
$script:MaximumCertificateTableBytes = 16MB
$script:MaximumWinCertificateEntries = 32
$script:MaximumSignerRecords = 64
$script:MaximumTimestampRecordsPerSigner = 16
$script:UtcTimestampFormat = "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'"

function New-AuthenticodeInspectionException {
    param(
        [Parameter(Mandatory)]
        [RenderPilot.Tooling.AuthenticodeInspectionError] $Code,

        [Parameter(Mandatory)]
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

function Get-InnerAuthenticodeInspectionException {
    param(
        [Parameter(Mandatory)]
        [Exception] $Exception
    )

    for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
        if ($current -is [RenderPilot.Tooling.AuthenticodeInspectionException]) {
            return $current
        }
    }

    return $null
}

function Format-UtcTimestamp {
    param(
        [Parameter(Mandatory)]
        [DateTimeOffset] $Timestamp
    )

    return $Timestamp.ToUniversalTime().ToString(
        $script:UtcTimestampFormat,
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Get-CmsAttributesByOid {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [Security.Cryptography.CryptographicAttributeObjectCollection] $Attributes,

        [Parameter(Mandatory)]
        [string] $Oid
    )

    foreach ($attribute in $Attributes) {
        if ($attribute.Oid.Value -eq $Oid) {
            $attribute
        }
    }
}

function ConvertFrom-EncodedCms {
    param(
        [Parameter(Mandatory)]
        [byte[]] $EncodedMessage,

        [Parameter(Mandatory)]
        [string] $ErrorMessage
    )

    $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
    try {
        $cms.Decode($EncodedMessage)
    }
    catch {
        throw (New-AuthenticodeInspectionException -Code MalformedCms -Message $ErrorMessage -InnerException $_.Exception)
    }

    return $cms
}

function Get-PeCertificateTableRange {
    param(
        [Parameter(Mandatory)]
        [IO.Stream] $Stream,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $peReader = [Reflection.PortableExecutable.PEReader]::new(
        $Stream,
        [Reflection.PortableExecutable.PEStreamOptions]::LeaveOpen
    )

    try {
        $peHeader = $peReader.PEHeaders.PEHeader
        if ($null -eq $peHeader) {
            throw "Missing PE optional header: $Path"
        }

        $directory = $peHeader.CertificateTableDirectory
        $offset = [long] $directory.RelativeVirtualAddress
        $size = [long] $directory.Size
    }
    finally {
        $peReader.Dispose()
    }

    if ($offset -le 0 -or $size -lt $script:WinCertificateHeaderSize) {
        throw "Missing embedded Authenticode certificate table: $Path"
    }

    if ($offset -gt $Stream.Length -or $size -gt ($Stream.Length - $offset)) {
        throw "Authenticode certificate table is outside the file: $Path"
    }

    if ($size -gt $script:MaximumCertificateTableBytes) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode certificate table exceeds $($script:MaximumCertificateTableBytes) bytes: $Path")
    }

    return [pscustomobject]@{
        Offset = $offset
        End    = $offset + $size
    }
}

function Get-AlignedWinCertificateLength {
    param(
        [Parameter(Mandatory)]
        [long] $Length
    )

    $remainder = $Length % $script:WinCertificateAlignment
    if ($remainder -eq 0) {
        return $Length
    }

    return $Length + ($script:WinCertificateAlignment - $remainder)
}

function Get-EmbeddedAuthenticodeCms {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $stream = [IO.File]::OpenRead($Path)
    try {
        $table = Get-PeCertificateTableRange -Stream $stream -Path $Path
        $cmsDocuments = [Collections.Generic.List[Security.Cryptography.Pkcs.SignedCms]]::new()
        $reader = [IO.BinaryReader]::new($stream, [Text.Encoding]::UTF8, $true)

        try {
            $entryOffset = $table.Offset
            $entryCount = 0
            while ($entryOffset -lt $table.End) {
                $entryCount++
                if ($entryCount -gt $script:MaximumWinCertificateEntries) {
                    throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode certificate table contains more than $($script:MaximumWinCertificateEntries) entries: $Path")
                }

                if (($table.End - $entryOffset) -lt $script:WinCertificateHeaderSize) {
                    throw "Truncated WIN_CERTIFICATE header at offset ${entryOffset}: $Path"
                }

                $stream.Position = $entryOffset
                $entryLength = [long] $reader.ReadUInt32()
                $revision = $reader.ReadUInt16()
                $certificateType = $reader.ReadUInt16()

                if ($entryLength -lt $script:WinCertificateHeaderSize) {
                    throw "Invalid WIN_CERTIFICATE length $entryLength at offset ${entryOffset}: $Path"
                }

                if ($entryLength -gt ($table.End - $entryOffset)) {
                    throw "WIN_CERTIFICATE at offset $entryOffset exceeds its PE table: $Path"
                }

                if ($certificateType -eq $script:PkcsSignedDataCertificateType) {
                    if ($revision -notin 0x0100, 0x0200) {
                        $revisionHex = $revision.ToString('X4')
                        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Unsupported WIN_CERTIFICATE revision 0x${revisionHex}: $Path")
                    }

                    $payloadLength = $entryLength - $script:WinCertificateHeaderSize
                    if ($payloadLength -gt [int]::MaxValue) {
                        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode PKCS#7 payload is too large to decode at offset ${entryOffset}: $Path")
                    }

                    $encodedCms = $reader.ReadBytes([int] $payloadLength)
                    if ($encodedCms.Length -ne $payloadLength) {
                        throw "Truncated Authenticode PKCS#7 payload at offset ${entryOffset}: $Path"
                    }

                    $cms = ConvertFrom-EncodedCms -EncodedMessage $encodedCms -ErrorMessage "Invalid Authenticode PKCS#7 payload at offset ${entryOffset}: $Path"
                    $cmsDocuments.Add($cms)
                }

                $alignedLength = Get-AlignedWinCertificateLength -Length $entryLength
                $nextOffset = $entryOffset + $alignedLength
                if ($nextOffset -le $entryOffset -or $nextOffset -gt $table.End) {
                    throw "Invalid WIN_CERTIFICATE alignment at offset ${entryOffset}: $Path"
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

        return $cmsDocuments.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Add-AuthenticodeSignerRecords {
    param(
        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [Collections.Generic.List[object]] $Records,

        [Parameter(Mandatory)]
        [int] $Depth,

        [Parameter(Mandatory)]
        [string] $Path
    )

    if ($Depth -gt $script:MaximumNestedSignatureDepth) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode nested-signature depth exceeds $($script:MaximumNestedSignatureDepth): $Path")
    }

    for ($signerIndex = 0; $signerIndex -lt $Cms.SignerInfos.Count; $signerIndex++) {
        if ($Records.Count -ge $script:MaximumSignerRecords) {
            throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode CMS contains more than $($script:MaximumSignerRecords) signer records: $Path")
        }

        $signer = $Cms.SignerInfos[$signerIndex]
        $Records.Add([pscustomobject]@{
                Signer      = $signer
                Cms         = $Cms
                SignerIndex = $signerIndex
            })

        $nestedAttributes = @(
            Get-CmsAttributesByOid -Attributes $signer.UnsignedAttributes -Oid $script:NestedAuthenticodeSignatureOid
        )

        foreach ($attribute in $nestedAttributes) {
            if ($attribute.Values.Count -eq 0) {
                throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "Empty nested Authenticode signature attribute: $Path")
            }

            foreach ($value in $attribute.Values) {
                $nestedCms = ConvertFrom-EncodedCms -EncodedMessage $value.RawData -ErrorMessage "Malformed nested Authenticode signature: $Path"

                Add-AuthenticodeSignerRecords -Cms $nestedCms -Records $Records -Depth ($Depth + 1) -Path $Path
            }
        }
    }
}

function Get-VerifiedRfc3161Timestamps {
    param(
        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $timestamps = [Collections.Generic.List[object]]::new()
    $timestampAttributes = @(
        Get-CmsAttributesByOid -Attributes $Signer.UnsignedAttributes -Oid $script:Rfc3161TimestampOid
    )
    $signerSignature = if ($timestampAttributes.Count -eq 0) {
        $null
    }
    else {
        $Signer.GetSignature()
    }

    foreach ($attribute in $timestampAttributes) {
        if ($attribute.Values.Count -eq 0) {
            throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "Empty RFC 3161 timestamp attribute: $Path")
        }

        foreach ($value in $attribute.Values) {
            if ($timestamps.Count -ge $script:MaximumTimestampRecordsPerSigner) {
                throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode signer contains more than $($script:MaximumTimestampRecordsPerSigner) RFC 3161 timestamp records: $Path")
            }

            $timestampCms = ConvertFrom-EncodedCms -EncodedMessage $value.RawData -ErrorMessage "Malformed RFC 3161 timestamp CMS: $Path"

            try {
                $timestampSignerThumbprint = [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyRfc3161AndGetSignerThumbprint(
                    $value.RawData,
                    $signerSignature
                )
            }
            catch {
                throw (New-AuthenticodeInspectionException -Code InvalidRfc3161 -Message "RFC 3161 token does not verify the Authenticode signer: $Path" -InnerException $_.Exception)
            }

            if ($timestampCms.ContentInfo.ContentType.Value -ne $script:Rfc3161TstInfoOid) {
                throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "RFC 3161 timestamp CMS has unexpected content type: $Path")
            }

            $tokenInfo = $null
            $bytesConsumed = 0
            $encodedInfo = [ReadOnlyMemory[byte]]::new($timestampCms.ContentInfo.Content)
            $decoded = [Security.Cryptography.Pkcs.Rfc3161TimestampTokenInfo]::TryDecode(
                $encodedInfo,
                [ref] $tokenInfo,
                [ref] $bytesConsumed
            )

            if (-not $decoded -or $bytesConsumed -ne $timestampCms.ContentInfo.Content.Length) {
                throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "Malformed RFC 3161 TSTInfo: $Path")
            }

            # CryptoAPI verified the CMS signature and message imprint above.
            # Trust is established later by correlating this signer certificate
            # with the timestamp certificate selected by Windows WinTrust.
            $timestamps.Add([pscustomobject]@{
                Timestamp        = Format-UtcTimestamp -Timestamp $tokenInfo.Timestamp
                SignerThumbprint = $timestampSignerThumbprint
            })
        }
    }

    return $timestamps.ToArray()
}

function Get-CmsAttributeValueCount {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [Security.Cryptography.CryptographicAttributeObjectCollection] $Attributes,

        [Parameter(Mandatory)]
        [string] $Oid
    )

    $count = 0
    foreach ($attribute in @(Get-CmsAttributesByOid -Attributes $Attributes -Oid $Oid)) {
        $count += $attribute.Values.Count
    }

    return $count
}

function Get-SingleCmsAttributeValue {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [Security.Cryptography.CryptographicAttributeObjectCollection] $Attributes,

        [Parameter(Mandatory)]
        [string] $Oid,

        [Parameter(Mandatory)]
        [string] $ErrorMessage
    )

    $matchingAttributes = @(
        Get-CmsAttributesByOid -Attributes $Attributes -Oid $Oid
    )

    if ($matchingAttributes.Count -ne 1 -or $matchingAttributes[0].Values.Count -ne 1) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message $ErrorMessage)
    }

    return $matchingAttributes[0].Values[0]
}

function Get-VerifiedLegacyTimestamps {
    param(
        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory)]
        [int] $SignerIndex,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $encodedCounterSignatureCount = Get-CmsAttributeValueCount -Attributes $Signer.UnsignedAttributes -Oid $script:Pkcs9CounterSignatureOid

    if ($encodedCounterSignatureCount -ne $Signer.CounterSignerInfos.Count) {
        throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "PKCS#9 countersignature attributes do not match decoded countersigners: $Path")
    }

    $encodedCms = $null
    if ($Signer.CounterSignerInfos.Count -gt 0) {
        $encodedCms = $Cms.Encode()
    }

    $timestamps = [Collections.Generic.List[object]]::new()
    if ($Signer.CounterSignerInfos.Count -gt $script:MaximumTimestampRecordsPerSigner) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode signer contains more than $($script:MaximumTimestampRecordsPerSigner) PKCS#9 countersignatures: $Path")
    }

    for (
        $counterSignerIndex = 0;
        $counterSignerIndex -lt $Signer.CounterSignerInfos.Count;
        $counterSignerIndex++
    ) {
        $counterSigner = $Signer.CounterSignerInfos[$counterSignerIndex]
        if ($null -eq $counterSigner.Certificate) {
            throw (New-AuthenticodeInspectionException -Code SignerMismatch -Message "Authenticode countersigner certificate is missing: $Path")
        }

        try {
            [RenderPilot.Tooling.AuthenticodeTimestampNative]::VerifyPkcs9Countersignature(
                $encodedCms,
                $SignerIndex,
                $counterSignerIndex,
                $counterSigner.Certificate
            )
        }
        catch {
            $inspectionException = Get-InnerAuthenticodeInspectionException -Exception $_.Exception
            if ($null -ne $inspectionException) {
                throw $inspectionException
            }

            throw (New-AuthenticodeInspectionException -Code InvalidPkcs9 -Message "Invalid Authenticode PKCS#9 countersignature: $Path" -InnerException $_.Exception)
        }

        $encodedSigningTime = Get-SingleCmsAttributeValue -Attributes $counterSigner.SignedAttributes -Oid $script:Pkcs9SigningTimeOid -ErrorMessage "Authenticode countersignature must contain exactly one signingTime: $Path"

        $signingTime = [Security.Cryptography.Pkcs.Pkcs9SigningTime]::new()
        try {
            $signingTime.CopyFrom($encodedSigningTime)
        }
        catch {
            throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "Malformed Authenticode PKCS#9 signingTime: $Path" -InnerException $_.Exception)
        }

        $timestamp = ([DateTimeOffset] $signingTime.SigningTime).ToUniversalTime()
        $notBefore = ([DateTimeOffset] $counterSigner.Certificate.NotBefore).ToUniversalTime()
        $notAfter = ([DateTimeOffset] $counterSigner.Certificate.NotAfter).ToUniversalTime()
        if ($timestamp -lt $notBefore -or $timestamp -gt $notAfter) {
            throw (New-AuthenticodeInspectionException -Code InvalidPkcs9 -Message "Authenticode PKCS#9 signingTime is outside the countersigner certificate validity: $Path")
        }

        $counterSignerThumbprint = $counterSigner.Certificate.Thumbprint
        if ([string]::IsNullOrWhiteSpace($counterSignerThumbprint)) {
            throw (New-AuthenticodeInspectionException -Code SignerMismatch -Message "Authenticode countersigner certificate has no thumbprint: $Path")
        }

        $timestamps.Add([pscustomobject]@{
                Timestamp        = Format-UtcTimestamp -Timestamp $timestamp
                SignerThumbprint = $counterSignerThumbprint.ToUpperInvariant()
            })
    }

    return $timestamps.ToArray()
}

function Get-VerifiedSignerTimestamp {
    param(
        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignerInfo] $Signer,

        [Parameter(Mandatory)]
        [Security.Cryptography.Pkcs.SignedCms] $Cms,

        [Parameter(Mandatory)]
        [int] $SignerIndex,

        [AllowNull()]
        [string] $TrustedTimestampSignerThumbprint,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $timestampRecords = @(
        Get-VerifiedRfc3161Timestamps -Signer $Signer -Path $Path
        Get-VerifiedLegacyTimestamps -Signer $Signer -Cms $Cms -SignerIndex $SignerIndex -Path $Path
    )

    if ($timestampRecords.Count -gt $script:MaximumTimestampRecordsPerSigner) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedStructure -Message "Authenticode signer contains more than $($script:MaximumTimestampRecordsPerSigner) timestamp records: $Path")
    }

    if ($timestampRecords.Count -eq 0) {
        return $null
    }

    if ([string]::IsNullOrWhiteSpace($TrustedTimestampSignerThumbprint)) {
        throw (New-AuthenticodeInspectionException -Code UntrustedTimestamp -Message "Authenticode timestamp is not trusted by Windows: $Path")
    }

    foreach ($timestampRecord in $timestampRecords) {
        if (
            [string]::IsNullOrWhiteSpace($timestampRecord.SignerThumbprint) -or
            -not [StringComparer]::OrdinalIgnoreCase.Equals(
                $timestampRecord.SignerThumbprint,
                $TrustedTimestampSignerThumbprint
            )
        ) {
            throw (New-AuthenticodeInspectionException -Code UntrustedTimestamp -Message "Authenticode timestamp signer differs from the certificate trusted by Windows: $Path")
        }
    }

    $distinctTimestamps = @(
        $timestampRecords.Timestamp | Sort-Object -Unique
    )

    if ($distinctTimestamps.Count -gt 1) {
        throw (New-AuthenticodeInspectionException -Code ConflictingTimestamps -Message "Authenticode signer has conflicting verified timestamps: $Path")
    }

    return $distinctTimestamps[0]
}

function Get-MatchingSignerRecords {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]] $Records,

        [Parameter(Mandatory)]
        [string] $Thumbprint,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $matchingRecords = @(
        foreach ($record in $Records) {
            $certificate = $record.Signer.Certificate
            if (
                $null -ne $certificate -and
                [StringComparer]::OrdinalIgnoreCase.Equals($certificate.Thumbprint, $Thumbprint)
            ) {
                $record
            }
        }
    )

    if ($matchingRecords.Count -eq 0) {
        throw (New-AuthenticodeInspectionException -Code SignerMismatch -Message "Windows signer certificate is absent from embedded Authenticode CMS: $Path")
    }

    return $matchingRecords
}

function Get-ConsistentSignerTimestamp {
    param(
        [Parameter(Mandatory)]
        [object[]] $Records,

        [AllowNull()]
        [string] $TrustedTimestampSignerThumbprint,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $isFirstRecord = $true
    $hasTimestamp = $false
    $signedAt = $null

    foreach ($record in $Records) {
        $currentTimestamp = Get-VerifiedSignerTimestamp `
            -Signer $record.Signer `
            -Cms $record.Cms `
            -SignerIndex $record.SignerIndex `
            -TrustedTimestampSignerThumbprint $TrustedTimestampSignerThumbprint `
            -Path $Path
        $currentHasTimestamp = $null -ne $currentTimestamp

        if ($isFirstRecord) {
            $hasTimestamp = $currentHasTimestamp
            $signedAt = $currentTimestamp
            $isFirstRecord = $false
            continue
        }

        if (
            $currentHasTimestamp -ne $hasTimestamp -or
            ($currentHasTimestamp -and $currentTimestamp -cne $signedAt)
        ) {
            throw (New-AuthenticodeInspectionException -Code ConflictingTimestamps -Message "Matching Authenticode signatures disagree about timestamp presence or value: $Path")
        }
    }

    return $signedAt
}

function Get-EmbeddedSignerRecords {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $records = [Collections.Generic.List[object]]::new()
    try {
        foreach ($cms in @(Get-EmbeddedAuthenticodeCms -Path $Path)) {
            Add-AuthenticodeSignerRecords -Cms $cms -Records $records -Depth 0 -Path $Path
        }
    }
    catch {
        $inspectionException = Get-InnerAuthenticodeInspectionException -Exception $_.Exception
        if ($null -ne $inspectionException) {
            throw $inspectionException
        }

        throw (New-AuthenticodeInspectionException -Code MalformedCms -Message "Unable to decode embedded Authenticode CMS: $Path" -InnerException $_.Exception)
    }

    return $records.ToArray()
}

function Get-AuthenticodeMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [ValidateSet('RequireSigned', 'AllowUnsigned')]
        [string] $Mode
    )

    $resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath

    if ($signature.Status -eq [Management.Automation.SignatureStatus]::NotSigned) {
        if ($Mode -eq 'AllowUnsigned') {
            return [ordered]@{
                status = 'unsigned'
            }
        }

        throw (New-AuthenticodeInspectionException -Code UnsignedNotAllowed -Message "Unsigned PE is forbidden when a signature is required: $resolvedPath")
    }

    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw (New-AuthenticodeInspectionException -Code InvalidSignature -Message "Invalid Authenticode signature ($($signature.Status)): $resolvedPath")
    }

    if ($signature.SignatureType -ne [Management.Automation.SignatureType]::Authenticode) {
        throw (New-AuthenticodeInspectionException -Code UnsupportedSignatureSource -Message "Only embedded Authenticode signatures are supported; Windows selected $($signature.SignatureType): $resolvedPath")
    }

    $signerCertificate = $signature.SignerCertificate
    if ($null -eq $signerCertificate) {
        throw (New-AuthenticodeInspectionException -Code SignerMismatch -Message "Valid Authenticode signature has no signer certificate: $resolvedPath")
    }

    $timestampSignerCertificate = $signature.TimeStamperCertificate
    $trustedTimestampSignerThumbprint = if ($null -eq $timestampSignerCertificate) {
        $null
    }
    else {
        if ([string]::IsNullOrWhiteSpace($timestampSignerCertificate.Thumbprint)) {
            throw (New-AuthenticodeInspectionException -Code UntrustedTimestamp -Message "Windows timestamp certificate has no thumbprint: $resolvedPath")
        }

        $timestampSignerCertificate.Thumbprint.ToUpperInvariant()
    }

    if ([string]::IsNullOrWhiteSpace($signerCertificate.Thumbprint)) {
        throw (New-AuthenticodeInspectionException -Code SignerMismatch -Message "Valid Authenticode signer certificate has no thumbprint: $resolvedPath")
    }

    $thumbprint = $signerCertificate.Thumbprint.ToUpperInvariant()
    $records = @(Get-EmbeddedSignerRecords -Path $resolvedPath)
    $matchingRecords = @(
        Get-MatchingSignerRecords -Records $records -Thumbprint $thumbprint -Path $resolvedPath
    )
    $signedAt = Get-ConsistentSignerTimestamp `
        -Records $matchingRecords `
        -TrustedTimestampSignerThumbprint $trustedTimestampSignerThumbprint `
        -Path $resolvedPath

    if ($null -ne $timestampSignerCertificate -and $null -eq $signedAt) {
        throw (New-AuthenticodeInspectionException -Code UntrustedTimestamp -Message "Windows reports a trusted timestamp that is absent from the embedded Authenticode CMS: $resolvedPath")
    }

    return [ordered]@{
        status     = 'signed'
        subject    = $signerCertificate.Subject
        thumbprint = $thumbprint
        signed_at  = $signedAt
    }
}

Export-ModuleMember -Function Get-AuthenticodeMetadata

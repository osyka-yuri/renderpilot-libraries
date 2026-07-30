#nullable enable

using System;
using System.ComponentModel;
using System.Formats.Asn1;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32.SafeHandles;

namespace RenderPilot.Tooling;

public enum AuthenticodeInspectionError
{
    MalformedCms,
    UnsupportedStructure,
    SignerMismatch,
    InvalidRfc3161,
    InvalidPkcs9,
    UntrustedTimestamp,
    ConflictingTimestamps,
    UnsupportedSignatureSource,
    InvalidSignature,
    UnsignedNotAllowed,
}

public sealed class AuthenticodeInspectionException : CryptographicException
{
    public AuthenticodeInspectionException(
        AuthenticodeInspectionError code,
        string message)
        : base(message)
    {
        Code = code;
    }

    public AuthenticodeInspectionException(
        AuthenticodeInspectionError code,
        string message,
        Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public AuthenticodeInspectionError Code { get; }
}

[SupportedOSPlatform("windows")]
public static class AuthenticodeTimestampNative
{
    private const string Pkcs9CounterSignatureOid = "1.2.840.113549.1.9.6";
    private const string Pkcs7SignedDataOid = "1.2.840.113549.1.7.2";

    private static readonly Asn1Tag ExplicitContentTag =
        new(TagClass.ContextSpecific, 0, isConstructed: true);

    private static readonly Asn1Tag CertificatesTag =
        new(TagClass.ContextSpecific, 0, isConstructed: true);

    private static readonly Asn1Tag RevocationInfoTag =
        new(TagClass.ContextSpecific, 1, isConstructed: true);

    private static readonly Asn1Tag SignedAttributesTag =
        new(TagClass.ContextSpecific, 0, isConstructed: true);

    private static readonly Asn1Tag UnsignedAttributesTag =
        new(TagClass.ContextSpecific, 1, isConstructed: true);

    public static string VerifyRfc3161AndGetSignerThumbprint(
        byte[] encodedToken,
        byte[] signedValue)
    {
        ArgumentNullException.ThrowIfNull(encodedToken);
        ArgumentNullException.ThrowIfNull(signedValue);
        ThrowIfEmpty(encodedToken, nameof(encodedToken), "RFC 3161 token must be non-empty.");
        ThrowIfEmpty(signedValue, nameof(signedValue), "Signed value must be non-empty.");

        bool isValid = NativeMethods.CryptVerifyTimeStampSignature(
            encodedToken,
            encodedToken.Length,
            signedValue,
            signedValue.Length,
            IntPtr.Zero,
            out CryptMemHandle timestampContext,
            out CertContextHandle timestampSigner,
            out CertStoreHandle openedStore);

        using (timestampContext)
        using (timestampSigner)
        using (openedStore)
        {
            if (!isValid)
            {
                throw CreateLastWin32Exception();
            }

            if (timestampContext is null || timestampContext.IsInvalid)
            {
                throw new InvalidOperationException(
                    "CryptVerifyTimeStampSignature returned no context.");
            }

            if (timestampSigner is null || timestampSigner.IsInvalid)
            {
                throw new InvalidOperationException(
                    "CryptVerifyTimeStampSignature returned no signer certificate.");
            }

            using X509Certificate2 certificate = new(
                timestampSigner.DangerousGetHandle());

            string? thumbprint = certificate.Thumbprint;
            if (string.IsNullOrWhiteSpace(thumbprint))
            {
                throw new CryptographicException(
                    "RFC 3161 signer certificate has no thumbprint.");
            }

            return thumbprint.ToUpperInvariant();
        }
    }

    public static void VerifyPkcs9Countersignature(
        byte[] encodedCms,
        int signerIndex,
        int counterSignerIndex,
        X509Certificate2 counterSignerCertificate)
    {
        ArgumentNullException.ThrowIfNull(encodedCms);
        ArgumentNullException.ThrowIfNull(counterSignerCertificate);
        ThrowIfEmpty(encodedCms, nameof(encodedCms), "CMS payload must be non-empty.");
        ThrowIfNegative(signerIndex, nameof(signerIndex));
        ThrowIfNegative(counterSignerIndex, nameof(counterSignerIndex));

        byte[] signerInfo;
        byte[] counterSignerInfo;

        try
        {
            signerInfo = ExtractSignerInfo(encodedCms, signerIndex);
            counterSignerInfo = ExtractCounterSignerInfo(signerInfo, counterSignerIndex);
        }
        catch (Exception exception) when (
            exception is AsnContentException or
            ArgumentOutOfRangeException or
            CryptographicException)
        {
            throw new AuthenticodeInspectionException(
                AuthenticodeInspectionError.MalformedCms,
                "Malformed CMS SignerInfo or PKCS#9 countersignature.",
                exception);
        }

        VerifyPkcs9CountersignatureEncoded(
            signerInfo,
            counterSignerInfo,
            counterSignerCertificate);
    }

    public static void VerifyPkcs9CountersignatureEncoded(
        byte[] encodedSignerInfo,
        byte[] encodedCounterSignerInfo,
        X509Certificate2 counterSignerCertificate)
    {
        ArgumentNullException.ThrowIfNull(encodedSignerInfo);
        ArgumentNullException.ThrowIfNull(encodedCounterSignerInfo);
        ArgumentNullException.ThrowIfNull(counterSignerCertificate);
        ThrowIfEmpty(
            encodedSignerInfo,
            nameof(encodedSignerInfo),
            "Encoded signer record must be non-empty.");
        ThrowIfEmpty(
            encodedCounterSignerInfo,
            nameof(encodedCounterSignerInfo),
            "Encoded countersigner record must be non-empty.");

        bool isValid = NativeMethods.CryptMsgVerifyCountersignatureEncodedEx(
            IntPtr.Zero,
            NativeMethods.CombinedAsnEncoding,
            encodedSignerInfo,
            encodedSignerInfo.Length,
            encodedCounterSignerInfo,
            encodedCounterSignerInfo.Length,
            NativeMethods.VerifySignerCertificate,
            counterSignerCertificate.Handle,
            0,
            IntPtr.Zero);

        if (!isValid)
        {
            throw CreateLastWin32Exception();
        }
    }

    private static byte[] ExtractSignerInfo(byte[] encodedCms, int signerIndex)
    {
        AsnReader contentInfoReader = new(encodedCms, AsnEncodingRules.BER);
        AsnReader contentInfo = contentInfoReader.ReadSequence();

        string contentType = contentInfo.ReadObjectIdentifier();
        if (contentType != Pkcs7SignedDataOid)
        {
            throw new CryptographicException(
                $"CMS content type {contentType} is not signedData.");
        }
        AsnReader explicitContent = contentInfo.ReadSequence(ExplicitContentTag);
        AsnReader signedData = explicitContent.ReadSequence();

        _ = signedData.ReadInteger();
        _ = signedData.ReadSetOf(skipSortOrderValidation: true, expectedTag: null);
        _ = signedData.ReadSequence();

        ReadOptionalEncodedValue(signedData, CertificatesTag);
        ReadOptionalEncodedValue(signedData, RevocationInfoTag);

        AsnReader signerInfos = signedData.ReadSetOf(
            skipSortOrderValidation: true,
            expectedTag: null);

        byte[] result = ReadEncodedValueAt(
            signerInfos,
            signerIndex,
            nameof(signerIndex),
            "signer");

        signedData.ThrowIfNotEmpty();
        explicitContent.ThrowIfNotEmpty();
        contentInfo.ThrowIfNotEmpty();
        contentInfoReader.ThrowIfNotEmpty();

        return result;
    }

    private static byte[] ExtractCounterSignerInfo(
        byte[] encodedSignerInfo,
        int counterSignerIndex)
    {
        AsnReader signerInfoReader = new(encodedSignerInfo, AsnEncodingRules.BER);
        AsnReader signerInfo = signerInfoReader.ReadSequence();

        _ = signerInfo.ReadInteger();
        _ = signerInfo.ReadEncodedValue();
        _ = signerInfo.ReadSequence();
        ReadOptionalEncodedValue(signerInfo, SignedAttributesTag);
        _ = signerInfo.ReadSequence();
        _ = signerInfo.ReadOctetString();

        if (!HasTag(signerInfo, UnsignedAttributesTag))
        {
            throw new CryptographicException(
                "SignerInfo has no unauthenticated attributes.");
        }

        AsnReader unsignedAttributes = signerInfo.ReadSetOf(
            skipSortOrderValidation: true,
            expectedTag: UnsignedAttributesTag);

        byte[]? result = null;
        int countersignatureCount = 0;

        while (unsignedAttributes.HasData)
        {
            AsnReader attribute = unsignedAttributes.ReadSequence();
            string oid = attribute.ReadObjectIdentifier();
            AsnReader values = attribute.ReadSetOf(
                skipSortOrderValidation: true,
                expectedTag: null);

            while (values.HasData)
            {
                ReadOnlyMemory<byte> encodedValue = values.ReadEncodedValue();
                if (oid != Pkcs9CounterSignatureOid)
                {
                    continue;
                }

                if (countersignatureCount == counterSignerIndex)
                {
                    result = encodedValue.ToArray();
                }

                countersignatureCount++;
            }

            attribute.ThrowIfNotEmpty();
        }

        signerInfo.ThrowIfNotEmpty();
        signerInfoReader.ThrowIfNotEmpty();

        return result ?? throw new ArgumentOutOfRangeException(
            nameof(counterSignerIndex),
            $"CMS contains only {countersignatureCount} PKCS#9 countersignatures.");
    }

    private static byte[] ReadEncodedValueAt(
        AsnReader values,
        int requestedIndex,
        string parameterName,
        string label)
    {
        byte[]? result = null;
        int valueCount = 0;

        while (values.HasData)
        {
            ReadOnlyMemory<byte> encodedValue = values.ReadEncodedValue();
            if (valueCount == requestedIndex)
            {
                result = encodedValue.ToArray();
            }

            valueCount++;
        }

        return result ?? throw new ArgumentOutOfRangeException(
            parameterName,
            $"CMS contains only {valueCount} {label} records.");
    }

    private static void ReadOptionalEncodedValue(AsnReader reader, Asn1Tag expectedTag)
    {
        if (HasTag(reader, expectedTag))
        {
            _ = reader.ReadEncodedValue();
        }
    }

    private static bool HasTag(AsnReader reader, Asn1Tag expectedTag) =>
        reader.HasData && reader.PeekTag() == expectedTag;

    private static void ThrowIfEmpty(byte[] value, string parameterName, string message)
    {
        if (value.Length == 0)
        {
            throw new ArgumentException(message, parameterName);
        }
    }

    private static void ThrowIfNegative(int value, string parameterName)
    {
        if (value < 0)
        {
            throw new ArgumentOutOfRangeException(parameterName, value, "Value must be non-negative.");
        }
    }

    private static Win32Exception CreateLastWin32Exception() =>
        new(Marshal.GetLastPInvokeError());

    private sealed class CryptMemHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public CryptMemHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle()
        {
            NativeMethods.CryptMemFree(handle);
            return true;
        }
    }

    private sealed class CertContextHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public CertContextHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle() =>
            NativeMethods.CertFreeCertificateContext(handle);
    }

    private sealed class CertStoreHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public CertStoreHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle() =>
            NativeMethods.CertCloseStore(handle, 0);
    }

    private static class NativeMethods
    {
        private const string Crypt32Library = "crypt32.dll";
        private const uint X509AsnEncoding = 0x00000001;
        private const uint Pkcs7AsnEncoding = 0x00010000;

        internal const uint CombinedAsnEncoding = X509AsnEncoding | Pkcs7AsnEncoding;
        internal const uint VerifySignerCertificate = 2;

        [DllImport(Crypt32Library, ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CryptVerifyTimeStampSignature(
            byte[] timestampContentInfo,
            int timestampContentInfoLength,
            byte[] data,
            int dataLength,
            IntPtr additionalStore,
            out CryptMemHandle timestampContext,
            out CertContextHandle timestampSigner,
            out CertStoreHandle openedStore);

        [DllImport(Crypt32Library, ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CryptMsgVerifyCountersignatureEncodedEx(
            IntPtr cryptographicProvider,
            uint encodingType,
            byte[] signerInfo,
            int signerInfoLength,
            byte[] counterSignerInfo,
            int counterSignerInfoLength,
            uint signerType,
            IntPtr signer,
            uint flags,
            IntPtr extra);

        [DllImport(Crypt32Library, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern void CryptMemFree(IntPtr buffer);

        [DllImport(Crypt32Library, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CertFreeCertificateContext(IntPtr certificateContext);

        [DllImport(Crypt32Library, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CertCloseStore(IntPtr certificateStore, uint flags);
    }
}

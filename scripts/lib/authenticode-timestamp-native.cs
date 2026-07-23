using System;
using System.ComponentModel;
using System.Formats.Asn1;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace RenderPilot.Tooling;

public enum AuthenticodeInspectionError
{
    MalformedCms,
    UnsupportedStructure,
    SignerMismatch,
    InvalidRfc3161,
    InvalidPkcs9,
    ConflictingTimestamps,
    InvalidSignature,
    UnsignedNotAllowed,
}

public sealed class AuthenticodeInspectionException : CryptographicException
{
    public AuthenticodeInspectionError Code { get; }

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
}

public static class AuthenticodeTimestampNative
{
    private const uint X509_ASN_ENCODING = 0x00000001;
    private const uint PKCS_7_ASN_ENCODING = 0x00010000;
    private const uint CMSG_VERIFY_SIGNER_CERT = 2;
    private const string Pkcs9CounterSignatureOid = "1.2.840.113549.1.9.6";

    public static void VerifyRfc3161(byte[] encodedToken, byte[] signedValue)
    {
        ArgumentNullException.ThrowIfNull(encodedToken);
        ArgumentNullException.ThrowIfNull(signedValue);
        if (encodedToken.Length == 0 || signedValue.Length == 0)
        {
            throw new ArgumentException("RFC 3161 token and signed value must be non-empty.");
        }

        IntPtr contextPointer = IntPtr.Zero;
        try
        {
            if (!CryptVerifyTimeStampSignature(
                    encodedToken,
                    encodedToken.Length,
                    signedValue,
                    signedValue.Length,
                    IntPtr.Zero,
                    out contextPointer,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (contextPointer == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "CryptVerifyTimeStampSignature returned no context.");
            }
        }
        finally
        {
            if (contextPointer != IntPtr.Zero)
            {
                CryptMemFree(contextPointer);
            }
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
        if (encodedCms.Length == 0)
        {
            throw new ArgumentException("CMS payload must be non-empty.", nameof(encodedCms));
        }

        byte[] signerInfo;
        byte[] counterSignerInfo;
        try
        {
            signerInfo = ExtractSignerInfo(encodedCms, signerIndex);
            counterSignerInfo = ExtractCounterSignerInfo(
                signerInfo,
                counterSignerIndex);
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
        if (encodedSignerInfo.Length == 0 || encodedCounterSignerInfo.Length == 0)
        {
            throw new ArgumentException(
                "Encoded signer and countersigner records must be non-empty.");
        }

        if (!CryptMsgVerifyCountersignatureEncodedEx(
                IntPtr.Zero,
                X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                encodedSignerInfo,
                encodedSignerInfo.Length,
                encodedCounterSignerInfo,
                encodedCounterSignerInfo.Length,
                CMSG_VERIFY_SIGNER_CERT,
                counterSignerCertificate.Handle,
                0,
                IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static byte[] ExtractSignerInfo(byte[] encodedCms, int signerIndex)
    {
        if (signerIndex < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(signerIndex));
        }

        AsnReader contentInfo = new(encodedCms, AsnEncodingRules.BER);
        AsnReader contentSequence = contentInfo.ReadSequence();
        contentSequence.ReadObjectIdentifier();
        AsnReader explicitContent = contentSequence.ReadSequence(
            new Asn1Tag(TagClass.ContextSpecific, 0, isConstructed: true));
        AsnReader signedData = explicitContent.ReadSequence();
        signedData.ReadInteger();
        signedData.ReadSetOf(skipSortOrderValidation: true, expectedTag: null);
        signedData.ReadSequence();
        while (signedData.HasData &&
               signedData.PeekTag().TagClass == TagClass.ContextSpecific)
        {
            signedData.ReadEncodedValue();
        }

        AsnReader signerInfos = signedData.ReadSetOf(
            skipSortOrderValidation: true,
            expectedTag: null);
        byte[] result = ReadEncodedValueAt(signerInfos, signerIndex, "signer");
        signerInfos.ThrowIfNotEmpty();
        signedData.ThrowIfNotEmpty();
        explicitContent.ThrowIfNotEmpty();
        contentSequence.ThrowIfNotEmpty();
        contentInfo.ThrowIfNotEmpty();
        return result;
    }

    private static byte[] ExtractCounterSignerInfo(
        byte[] encodedSignerInfo,
        int counterSignerIndex)
    {
        if (counterSignerIndex < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(counterSignerIndex));
        }

        AsnReader signerInfo = new(encodedSignerInfo, AsnEncodingRules.BER);
        AsnReader sequence = signerInfo.ReadSequence();
        sequence.ReadInteger();
        sequence.ReadEncodedValue();
        sequence.ReadSequence();
        if (sequence.HasData &&
            sequence.PeekTag().HasSameClassAndValue(
                new Asn1Tag(TagClass.ContextSpecific, 0)))
        {
            sequence.ReadEncodedValue();
        }
        sequence.ReadSequence();
        sequence.ReadOctetString();

        if (!sequence.HasData ||
            !sequence.PeekTag().HasSameClassAndValue(
                new Asn1Tag(TagClass.ContextSpecific, 1)))
        {
            throw new CryptographicException(
                "SignerInfo has no unauthenticated attributes.");
        }

        AsnReader unsignedAttributes = sequence.ReadSetOf(
            skipSortOrderValidation: true,
            expectedTag: new Asn1Tag(
                TagClass.ContextSpecific,
                1,
                isConstructed: true));
        int currentIndex = 0;
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
                if (oid == Pkcs9CounterSignatureOid)
                {
                    if (currentIndex == counterSignerIndex)
                    {
                        attribute.ThrowIfNotEmpty();
                        return encodedValue.ToArray();
                    }
                    currentIndex++;
                }
            }
            attribute.ThrowIfNotEmpty();
        }

        throw new ArgumentOutOfRangeException(
            nameof(counterSignerIndex),
            $"CMS contains only {currentIndex} PKCS#9 countersignatures.");
    }

    private static byte[] ReadEncodedValueAt(
        AsnReader values,
        int requestedIndex,
        string label)
    {
        int currentIndex = 0;
        while (values.HasData)
        {
            ReadOnlyMemory<byte> encoded = values.ReadEncodedValue();
            if (currentIndex == requestedIndex)
            {
                return encoded.ToArray();
            }
            currentIndex++;
        }

        throw new ArgumentOutOfRangeException(
            nameof(requestedIndex),
            $"CMS contains only {currentIndex} {label} records.");
    }

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptVerifyTimeStampSignature(
        byte[] timestampContentInfo,
        int timestampContentInfoLength,
        byte[] data,
        int dataLength,
        IntPtr additionalStore,
        out IntPtr timestampContext,
        IntPtr timestampSigner,
        IntPtr openedStore);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptMsgVerifyCountersignatureEncodedEx(
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

    [DllImport("crypt32.dll")]
    private static extern void CryptMemFree(IntPtr buffer);
}

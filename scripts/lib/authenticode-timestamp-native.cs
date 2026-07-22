using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace RenderPilot.Tooling;

public static class AuthenticodeTimestampNative
{
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
                throw new InvalidOperationException("CryptVerifyTimeStampSignature returned no context.");
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

    [DllImport("crypt32.dll")]
    private static extern void CryptMemFree(IntPtr buffer);

}

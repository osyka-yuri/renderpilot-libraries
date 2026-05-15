#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content $manifestPath | ConvertFrom-Json

Add-Type -Assembly System.IO.Compression.FileSystem

function Get-FileHashMd5($path) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $hash = $md5.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace("-", "").ToLower()
    } finally {
        $stream.Dispose()
        $md5.Dispose()
    }
}

$updated = 0
$total = $manifest.entries.Count

for ($i = 0; $i -lt $total; $i++) {
    $entry = $manifest.entries[$i]
    $zipName = Split-Path $entry.files.zip.download_url -Leaf
    $zipPath = Get-ChildItem -Path $root -Recurse -Filter $zipName | Select-Object -First 1 -ExpandProperty FullName

    if (-not $zipPath) {
        Write-Host "[$($i+1)/$total] ZIP not found: $zipName" -ForegroundColor Red
        continue
    }

    # Extract DLL to temp
    $tempDir = Join-Path $env:TEMP "manifest-update-$([Guid]::NewGuid())"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        $dllEntry = $zip.Entries | Where-Object { $_.FullName -eq $entry.library.file_name } | Select-Object -First 1
        if (-not $dllEntry) {
            $dllEntry = $zip.Entries | Where-Object { $_.FullName -like "*.dll" } | Select-Object -First 1
        }

        if (-not $dllEntry) {
            Write-Host "[$($i+1)/$total] No DLL in $zipName" -ForegroundColor Red
            continue
        }

        $dllPath = Join-Path $tempDir $dllEntry.FullName
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($dllEntry, $dllPath, $true)
        $zip.Dispose()

        # Update sizes
        $entry.files.dll.size_bytes = (Get-Item $dllPath).Length
        $entry.files.zip.size_bytes = (Get-Item $zipPath).Length

        # Update hash
        $entry.files.dll.hashes.md5 = Get-FileHashMd5 $dllPath

        # Check signature
        $sig = Get-AuthenticodeSignature -FilePath $dllPath
        if ($sig.Status -eq 'Valid') {
            $signedAt = $sig.SignerCertificate.NotBefore.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            $entry.signature = @{
                status = "signed"
                signed_at = $signedAt
            }
        } else {
            $entry.signature = @{
                status = "unsigned"
            }
        }

        $updated++
        if (($i + 1) % 20 -eq 0 -or $i -eq $total - 1) {
            Write-Host "[$($i+1)/$total] Processed" -ForegroundColor Cyan
        }
    } finally {
        Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    }
}

# Update debug labels
$debugCount = 0
foreach ($entry in $manifest.entries) {
    if ($entry.build.type -eq 'debug' -and $entry.build.label -eq $null) {
        $entry.build.label = 'Debug'
        $debugCount++
    }
}

$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath

$signed = ($manifest.entries | Where-Object { $_.signature.status -eq 'signed' }).Count
$unsigned = ($manifest.entries | Where-Object { $_.signature.status -eq 'unsigned' }).Count

Write-Host "`nDone! Updated $updated entries" -ForegroundColor Green
Write-Host "Debug labels fixed: $debugCount" -ForegroundColor Green
Write-Host "Signed: $signed, Unsigned: $unsigned" -ForegroundColor Green

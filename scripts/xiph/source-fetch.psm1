Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module `
    -Name (Join-Path -Path $PSScriptRoot -ChildPath 'source-archive.psm1') `
    -Force `
    -ErrorAction Stop

$script:XiphMaximumArchiveBytes = 64MB
$script:XiphDownloadBufferBytes = 128KB
$script:XiphRequestTimeout = [TimeSpan]::FromMinutes(2)
$script:XiphUserAgent = 'renderpilot-libraries'


function Get-XiphSourceProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Source,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name
    )

    $property = $Source.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Xiph source metadata is missing property '$Name'"
    }

    return $property.Value
}


function Get-TrustedXiphArchiveUris {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Uri
    )

    [Uri] $sourceUri = $null

    if (-not [Uri]::TryCreate(
            $Uri,
            [UriKind]::Absolute,
            [ref] $sourceUri
        )) {
        throw "invalid Xiph archive URI: $Uri"
    }

    $hasTrustedOrigin = (
        [string]::Equals(
            $sourceUri.Scheme,
            [Uri]::UriSchemeHttps,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            $sourceUri.DnsSafeHost,
            'downloads.xiph.org',
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        $sourceUri.Port -eq 443 -and
        [string]::IsNullOrEmpty($sourceUri.UserInfo)
    )

    $hasTrustedPath = $sourceUri.AbsolutePath.StartsWith(
        '/releases/',
        [StringComparison]::Ordinal
    )

    $hasNoAdditionalComponents = (
        [string]::IsNullOrEmpty($sourceUri.Query) -and
        [string]::IsNullOrEmpty($sourceUri.Fragment)
    )

    if (-not (
            $hasTrustedOrigin -and
            $hasTrustedPath -and
            $hasNoAdditionalComponents
        )) {
        throw "untrusted Xiph archive URI: $Uri"
    }

    [Uri] $mirrorUri = [Uri]::new(
        "https://ftp.osuosl.org/pub/xiph$($sourceUri.AbsolutePath)",
        [UriKind]::Absolute
    )

    return [pscustomobject]@{
        Source = $sourceUri
        Mirror = $mirrorUri
    }
}


function Test-XiphRedirectTarget {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [Uri] $Actual,

        [Parameter(Mandatory)]
        [Uri] $Expected
    )

    return (
        [string]::Equals(
            $Actual.Scheme,
            $Expected.Scheme,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            $Actual.DnsSafeHost,
            $Expected.DnsSafeHost,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        $Actual.Port -eq $Expected.Port -and
        [string]::Equals(
            $Actual.UserInfo,
            $Expected.UserInfo,
            [StringComparison]::Ordinal
        ) -and
        [string]::Equals(
            $Actual.AbsolutePath,
            $Expected.AbsolutePath,
            [StringComparison]::Ordinal
        ) -and
        [string]::Equals(
            $Actual.Query,
            $Expected.Query,
            [StringComparison]::Ordinal
        ) -and
        [string]::Equals(
            $Actual.Fragment,
            $Expected.Fragment,
            [StringComparison]::Ordinal
        )
    )
}


function Get-XiphDownloadResponse {
    [CmdletBinding()]
    [OutputType([Net.Http.HttpResponseMessage])]
    param(
        [Parameter(Mandatory)]
        [Net.Http.HttpClient] $Client,

        [Parameter(Mandatory)]
        [Uri] $SourceUri,

        [Parameter(Mandatory)]
        [Uri] $MirrorUri,

        [Parameter(Mandatory)]
        [Threading.CancellationToken] $CancellationToken
    )

    $currentUri = $SourceUri

    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $request = [Net.Http.HttpRequestMessage]::new(
            [Net.Http.HttpMethod]::Get,
            $currentUri
        )

        $response = $null
        $keepResponse = $false

        try {
            $null = $request.Headers.UserAgent.ParseAdd($script:XiphUserAgent)

            $response = $Client.SendAsync(
                $request,
                [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
                $CancellationToken
            ).GetAwaiter().GetResult()

            $statusCode = [int] $response.StatusCode

            if ($statusCode -eq 200) {
                $keepResponse = $true
                return $response
            }

            $isRedirect = $statusCode -in @(301, 302, 307, 308)
            [Uri] $redirectUri = $null

            if ($isRedirect -and $null -ne $response.Headers.Location) {
                $location = $response.Headers.Location

                $redirectUri = if ($location.IsAbsoluteUri) {
                    $location
                }
                else {
                    [Uri]::new($currentUri, $location)
                }
            }

            $isTrustedRedirect = (
                $attempt -eq 0 -and
                $null -ne $redirectUri -and
                (Test-XiphRedirectTarget `
                    -Actual $redirectUri `
                    -Expected $MirrorUri)
            )

            if (-not $isTrustedRedirect) {
                throw (
                    '{0}: HTTP {1}' -f
                    $currentUri.AbsoluteUri,
                    $statusCode
                )
            }

            $currentUri = $redirectUri
        }
        finally {
            $request.Dispose()

            if (-not $keepResponse -and $null -ne $response) {
                $response.Dispose()
            }
        }
    }

    throw 'Xiph archive download did not produce a response'
}


function Save-XiphArchiveBounded {
    [CmdletBinding()]
    [OutputType([long])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Uri,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Destination,

        [long] $MaximumBytes = $script:XiphMaximumArchiveBytes
    )

    if ($MaximumBytes -le 0) {
        throw 'maximum Xiph archive size must be positive'
    }

    $archiveUris = Get-TrustedXiphArchiveUris -Uri $Uri

    $handler = [Net.Http.HttpClientHandler]::new()
    $client = $null
    $response = $null
    $inputStream = $null
    $outputStream = $null
    $cancellationSource = $null

    $destinationCreated = $false
    $downloadCompleted = $false

    try {
        $handler.AllowAutoRedirect = $false
        $handler.AutomaticDecompression = [Net.DecompressionMethods]::None

        $client = [Net.Http.HttpClient]::new($handler, $true)
        $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
        $cancellationSource = [Threading.CancellationTokenSource]::new(
            $script:XiphRequestTimeout
        )

        $response = Get-XiphDownloadResponse `
            -Client $client `
            -SourceUri $archiveUris.Source `
            -MirrorUri $archiveUris.Mirror `
            -CancellationToken $cancellationSource.Token

        $declaredSize = $response.Content.Headers.ContentLength
        if ($null -ne $declaredSize) {
            [long] $declaredBytes = $declaredSize

            if ($declaredBytes -gt $MaximumBytes) {
                throw "Xiph source archive exceeds $MaximumBytes bytes"
            }
        }

        $streamTask = $response.Content.ReadAsStreamAsync(
            $cancellationSource.Token
        )
        $inputStream = $streamTask.GetAwaiter().GetResult()

        $outputStream = [IO.File]::Open(
            $Destination,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $destinationCreated = $true

        $buffer = [byte[]]::new($script:XiphDownloadBufferBytes)
        [long] $totalBytes = 0

        while (
            ($readBytes = $inputStream.ReadAsync(
                $buffer,
                0,
                $buffer.Length,
                $cancellationSource.Token
            ).GetAwaiter().GetResult()) -gt 0
        ) {
            if ([long] $readBytes -gt $MaximumBytes - $totalBytes) {
                throw "Xiph source archive exceeds $MaximumBytes bytes"
            }

            $outputStream.Write($buffer, 0, $readBytes)
            $totalBytes += $readBytes
        }

        if ($totalBytes -eq 0) {
            throw 'Xiph source archive is empty'
        }

        $outputStream.Flush($true)

        try {
            $outputStream.Dispose()
        }
        finally {
            $outputStream = $null
        }

        $downloadCompleted = $true

        return $totalBytes
    }
    catch [OperationCanceledException] {
        throw [TimeoutException]::new(
            "Xiph archive download timed out after $($script:XiphRequestTimeout)",
            $_.Exception
        )
    }
    finally {
        if ($null -ne $outputStream) {
            $outputStream.Dispose()
        }

        if ($null -ne $inputStream) {
            $inputStream.Dispose()
        }

        if ($null -ne $response) {
            $response.Dispose()
        }

        if ($null -ne $client) {
            $client.Dispose()
        }
        else {
            $handler.Dispose()
        }

        if ($null -ne $cancellationSource) {
            $cancellationSource.Dispose()
        }

        # Delete only a file created by this invocation.
        if ($destinationCreated -and -not $downloadCompleted) {
            Remove-Item `
                -LiteralPath $Destination `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }
}


function Assert-XiphGitPin {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Source
    )

    $repository = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'repository'

    $tag = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'tag'

    $tagObjectSha = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'tag_object_sha'

    $commitSha = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'commit_sha'

    if (
        $repository -isnot [string] -or
        [string]::IsNullOrWhiteSpace($repository)
    ) {
        throw 'Xiph source repository must be a non-empty string'
    }

    if (
        $repository -cnotmatch
        '\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\z'
    ) {
        throw "invalid GitHub repository name: $repository"
    }

    if ($null -eq $tag) {
        if ($null -ne $tagObjectSha -or $null -ne $commitSha) {
            throw (
                'archive-only source pin has partial Git provenance for {0}' -f
                $repository
            )
        }

        return
    }

    if (
        $tag -isnot [string] -or
        [string]::IsNullOrWhiteSpace($tag)
    ) {
        throw "Git tag for $repository must be null or a non-empty string"
    }

    $gitHashPattern = '\A[0-9a-fA-F]{40}\z'

    if (
        $tagObjectSha -isnot [string] -or
        $tagObjectSha -notmatch $gitHashPattern
    ) {
        throw "invalid tag-object SHA for $repository $tag"
    }

    if (
        $commitSha -isnot [string] -or
        $commitSha -notmatch $gitHashPattern
    ) {
        throw "invalid commit SHA for $repository $tag"
    }

    $tagRef = "refs/tags/$tag"

    $null = & git check-ref-format $tagRef
    if ($LASTEXITCODE -ne 0) {
        throw "invalid Git tag reference for $repository`: $tag"
    }

    $repositoryUri = "https://github.com/$repository.git"

    $lines = @(
        & git ls-remote `
            --exit-code `
            $repositoryUri `
            $tagRef `
            "$tagRef^{}"
    )

    if ($LASTEXITCODE -ne 0) {
        throw "git ls-remote failed for $repository"
    }

    $resolvedRefs =
    [Collections.Generic.Dictionary[string, string]]::new(
        [StringComparer]::Ordinal
    )

    foreach ($line in $lines) {
        $parts = [string] $line -split "`t", 2

        if (
            $parts.Count -ne 2 -or
            $parts[0] -notmatch $gitHashPattern
        ) {
            throw "unexpected git ls-remote output for $repository"
        }

        $resolvedRefs[$parts[1]] = $parts[0]
    }

    [string] $remoteTagObject = $null

    if (-not $resolvedRefs.TryGetValue(
            $tagRef,
            [ref] $remoteTagObject
        )) {
        throw "Git tag does not exist for $repository`: $tag"
    }

    [string] $remoteCommit = $null

    if (-not $resolvedRefs.TryGetValue(
            "$tagRef^{}",
            [ref] $remoteCommit
        )) {
        # Lightweight tags point directly to the commit.
        $remoteCommit = $remoteTagObject
    }

    $tagObjectMatches = [StringComparer]::OrdinalIgnoreCase.Equals(
        $remoteTagObject,
        $tagObjectSha
    )

    $commitMatches = [StringComparer]::OrdinalIgnoreCase.Equals(
        $remoteCommit,
        $commitSha
    )

    if (-not ($tagObjectMatches -and $commitMatches)) {
        throw (
            'tag-object or peeled commit drift for {0} {1}' -f
            $repository,
            $tag
        )
    }
}


function Get-XiphSource {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Name,

        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object] $Source,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $DownloadsDirectory,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $SourcesDirectory
    )

    if ($Name -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z') {
        throw "invalid Xiph source name: $Name"
    }

    $downloadsRoot = [IO.Path]::GetFullPath($DownloadsDirectory)
    $sourcesRoot = [IO.Path]::GetFullPath($SourcesDirectory)

    if (-not [IO.Directory]::Exists($downloadsRoot)) {
        throw "downloads directory does not exist: $downloadsRoot"
    }

    if (-not [IO.Directory]::Exists($sourcesRoot)) {
        throw "sources directory does not exist: $sourcesRoot"
    }

    Assert-XiphGitPin -Source $Source

    $archiveUrl = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'archive_url'

    $expectedArchiveSha256 = Get-XiphSourceProperty `
        -Source $Source `
        -Name 'archive_sha256'

    if (
        $archiveUrl -isnot [string] -or
        [string]::IsNullOrWhiteSpace($archiveUrl)
    ) {
        throw "$Name archive URL must be a non-empty string"
    }

    if (
        $expectedArchiveSha256 -isnot [string] -or
        $expectedArchiveSha256 -notmatch '\A[0-9a-fA-F]{64}\z'
    ) {
        throw "$Name archive SHA-256 pin is invalid"
    }

    $archiveUris = Get-TrustedXiphArchiveUris -Uri $archiveUrl

    $extensionMatch = [regex]::Match(
        $archiveUris.Source.AbsolutePath,
        '\.tar\.(xz|bz2|gz)\z',
        (
            [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
            [Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
    )

    if (-not $extensionMatch.Success) {
        throw "unsupported Xiph source archive format: $archiveUrl"
    }

    $compressionExtension =
    $extensionMatch.Groups[1].Value.ToLowerInvariant()

    $archivePath = Join-Path `
        -Path $downloadsRoot `
        -ChildPath "$Name.tar.$compressionExtension"

    $destination = Join-Path `
        -Path $sourcesRoot `
        -ChildPath $Name

    $null = Save-XiphArchiveBounded `
        -Uri $archiveUrl `
        -Destination $archivePath `
        -MaximumBytes $script:XiphMaximumArchiveBytes

    $actualArchiveSha256 = (
        Get-FileHash `
            -LiteralPath $archivePath `
            -Algorithm SHA256
    ).Hash

    if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
            $actualArchiveSha256,
            $expectedArchiveSha256
        )) {
        throw "$Name source archive SHA-256 mismatch"
    }

    $null = Expand-SafeXiphTar `
        -Archive $archivePath `
        -Destination $destination

    $rootEntries = @(
        [IO.Directory]::EnumerateFileSystemEntries($destination)
    )

    if (
        $rootEntries.Count -ne 1 -or
        -not [IO.Directory]::Exists($rootEntries[0])
    ) {
        throw (
            "$Name archive must contain exactly one root directory " +
            'and no other root entries'
        )
    }

    return [IO.Path]::GetFullPath($rootEntries[0])
}


Export-ModuleMember -Function @(
    'Get-XiphSource'
    'Save-XiphArchiveBounded'
)

#*******************************************************************************
#
#     uBlock Plus+
#     Copyright (C) 2026-present uBlock Plus+ contributors
#
#     This program is free software: you can redistribute it and/or modify
#     it under the terms of the GNU General Public License as published by
#     the Free Software Foundation, either version 3 of the License, or
#     (at your option) any later version.
#
#     This program is distributed in the hope that it will be useful,
#     but WITHOUT ANY WARRANTY; without even the implied warranty of
#     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#     GNU General Public License for more details.
#
#     You should have received a copy of the GNU General Public License
#     along with this program.  If not, see {http://www.gnu.org/licenses/}.
#
#     Home: https://github.com/kayurachann/uBlock-Plus
#
#*******************************************************************************

#Requires -Version 5.1

<#
.SYNOPSIS
Builds the Chromium Manifest V3 extension on Windows.

.DESCRIPTION
This is the PowerShell counterpart of tools/make-mv3.sh for Chromium. It uses
PowerShell and the Node.js ruleset generator already shipped in the repository;
GNU make, jq, a Unix shell, and an external zip executable are not required.

.PARAMETER Full
Also creates dist/build/uBlock-Plus_<version>.chromium.zip.

.PARAMETER Version
Overrides the manifest version and creates a release-style zip. When omitted,
declarativeNetRequestFeedback is enabled for local development builds.

.PARAMETER Before
Path containing a previous chromium build whose rule IDs should be salvaged.

.PARAMETER ExperimentalWebRequest
Builds the separate experimental synchronous webRequest firewall supplement.
Chrome must grant webRequestBlocking through policy or a launch allowlist.
The normal Chromium package and its permissions are not changed.

.EXAMPLE
pwsh -File tools/make-mv3.ps1

.EXAMPLE
pwsh -File tools/make-mv3.ps1 -Full

.EXAMPLE
pwsh -File tools/make-mv3.ps1 -Version 2026.901.0
#>

[CmdletBinding()]
param(
    [ValidateSet('chromium')]
    [string] $Platform = 'chromium',

    [switch] $Full,

    [switch] $ExperimentalWebRequest,

    [Alias('TagName')]
    [string] $Version = '',

    [string] $Before = '',

    [string] $UboVersion = $env:UBO_VERSION
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-Directory {
    param([Parameter(Mandatory)][string] $Path)

    if ( Test-Path -LiteralPath $Path -PathType Container ) { return }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Assert-Path {
    param([Parameter(Mandatory)][string] $Path)

    if ( Test-Path -LiteralPath $Path ) { return }
    throw "Required build input is missing: $Path"
}

function Copy-RequiredFile {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )

    if ( (Test-Path -LiteralPath $Source -PathType Leaf) -eq $false ) {
        throw "Required build input is missing: $Source"
    }
    New-Directory (Split-Path -Parent $Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-OptionalFile {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )

    if ( (Test-Path -LiteralPath $Source -PathType Leaf) -eq $false ) { return }
    Copy-RequiredFile $Source $Destination
}

function Copy-TreeContents {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )

    if ( (Test-Path -LiteralPath $Source -PathType Container) -eq $false ) {
        throw "Required build input is missing: $Source"
    }
    New-Directory $Destination
    foreach ( $item in Get-ChildItem -Force -LiteralPath $Source ) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
}

function Copy-MatchingFiles {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Pattern,
        [Parameter(Mandatory)][string] $Destination,
        [switch] $Optional
    )

    if ( (Test-Path -LiteralPath $Source -PathType Container) -eq $false ) {
        throw "Required build input is missing: $Source"
    }
    $files = @(Get-ChildItem -LiteralPath $Source -File -Filter $Pattern)
    if ( $files.Count -eq 0 -and $Optional.IsPresent -eq $false ) {
        throw "No files matching '$Pattern' were found in $Source"
    }
    New-Directory $Destination
    foreach ( $file in $files ) {
        Copy-Item -LiteralPath $file.FullName -Destination $Destination -Force
    }
}

function New-BuildTempDirectory {
    $path = Join-Path ([IO.Path]::GetTempPath()) (
        'ublock-plus-mv3-{0}' -f [Guid]::NewGuid().ToString('N')
    )
    New-Directory $path
    return $path
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string] $Command,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ( $exitCode -ne 0 ) {
        throw "$Command exited with code $exitCode"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Content
    )

    [IO.File]::WriteAllText(
        $Path,
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function Convert-WasmToJson {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )

    $bytes = [IO.File]::ReadAllBytes($Source)
    Write-Utf8NoBom $Destination ('[' + ($bytes -join ',') + "]`n")
}

function New-ZipFromDirectory {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $sourceRoot = [IO.Path]::GetFullPath($Source)
    if ( $sourceRoot.EndsWith([IO.Path]::DirectorySeparatorChar) -eq $false ) {
        $sourceRoot += [IO.Path]::DirectorySeparatorChar
    }
    $archive = [IO.Compression.ZipFile]::Open(
        $Destination,
        [IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ( $file in Get-ChildItem -LiteralPath $Source -File -Recurse |
            Sort-Object FullName ) {
            $entryName = $file.FullName.Substring($sourceRoot.Length).Replace(
                [IO.Path]::DirectorySeparatorChar,
                [char] '/'
            )
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $file.FullName,
                $entryName,
                [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
}

function Test-ChromiumExtensionVersion {
    param([Parameter(Mandatory)][string] $Value)

    $parts = $Value.Split('.')
    if ( $parts.Count -lt 1 -or $parts.Count -gt 4 ) { return $false }
    $hasNonZeroPart = $false
    foreach ( $part in $parts ) {
        if ( $part -notmatch '^(?:0|[1-9][0-9]*)$' ) { return $false }
        if ( $part.Length -gt 5 ) { return $false }
        $number = [uint32] $part
        if ( $number -gt 65535 ) { return $false }
        if ( $number -ne 0 ) { $hasNonZeroPart = $true }
    }
    return $hasNonZeroPart
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $projectRoot 'dist/build'
$editionSuffix = if ( $ExperimentalWebRequest ) { '.experimental' } else { '' }
$outputDirectory = [IO.Path]::GetFullPath((Join-Path $buildRoot "uBlockPlus$editionSuffix.$Platform"))
if ( $outputDirectory.StartsWith(
    [IO.Path]::GetFullPath($buildRoot) + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
) -eq $false ) {
    throw 'The build output directory escaped dist/build.'
}
$nodeCommand = @(Get-Command node -CommandType Application `
    -ErrorAction SilentlyContinue)[0]
if ( $null -eq $nodeCommand ) {
    throw 'Node.js is required to generate MV3 rulesets.'
}
$node = [string] $nodeCommand.Source
$temporaryDirectories = [Collections.Generic.List[string]]::new()

$experimentalMetadata = $null
if ( $ExperimentalWebRequest ) {
    $metadataPath = Join-Path $projectRoot 'platform/mv3/chromium-experimental/metadata.json'
    Assert-Path $metadataPath
    $identityCheck = @'
import fs from 'node:fs';
import { experimentalIdentityErrors } from './tools/experimental-build-config.mjs';
const errors = experimentalIdentityErrors(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));
if ( errors.length ) { throw new Error(errors.join('\n')); }
'@
    Invoke-NativeCommand $node @(
        '--input-type=module', '--eval', $identityCheck, $metadataPath
    ) $projectRoot
    $experimentalMetadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
}

if ( $Version -ne '' -and (Test-ChromiumExtensionVersion $Version) -eq $false ) {
    throw "Invalid Chromium extension version: $Version"
}

$beforeDirectory = ''
if ( $Before -ne '' ) {
    if ( [IO.Path]::IsPathRooted($Before) ) {
        $beforeDirectory = [IO.Path]::GetFullPath($Before)
    } else {
        $beforeDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot $Before))
    }
    Assert-Path (Join-Path $beforeDirectory $Platform)
}

Write-Host '*** uBlock Plus+ MV3: Creating extension'
Write-Host "PLATFORM=$Platform"
Write-Host "VERSION=$Version"
Write-Host "BEFORE=$beforeDirectory"

try {
    New-Directory $buildRoot
    if ( Test-Path -LiteralPath $outputDirectory ) {
        Remove-Item -LiteralPath $outputDirectory -Recurse -Force
    }
    New-Directory (Join-Path $outputDirectory 'css/fonts')
    New-Directory (Join-Path $outputDirectory 'js/offscreen')
    New-Directory (Join-Path $outputDirectory 'img')
    New-Directory (Join-Path $outputDirectory 'lib')

    $uboRoot = $projectRoot
    if ( $UboVersion -ne '' ) {
        $gitCommand = @(Get-Command git -CommandType Application `
            -ErrorAction Stop)[0]
        $git = [string] $gitCommand.Source
        $uboRoot = New-BuildTempDirectory
        $temporaryDirectories.Add($uboRoot)
        Write-Host "*** uBlock Plus+ MV3: Fetching uBO $UboVersion into $uboRoot"
        Invoke-NativeCommand $git @('init', '-q') $uboRoot
        Invoke-NativeCommand $git @(
            'remote', 'add', 'origin', 'https://github.com/gorhill/uBlock.git'
        ) $uboRoot
        Invoke-NativeCommand $git @(
            'fetch', '--depth', '1', 'origin', $UboVersion
        ) $uboRoot
        Invoke-NativeCommand $git @('checkout', '-q', 'FETCH_HEAD') $uboRoot
    }

    Write-Host '*** uBlock Plus+ MV3: Copying common files'
    Copy-TreeContents (Join-Path $uboRoot 'src/css/fonts/Inter') `
        (Join-Path $outputDirectory 'css/fonts/Inter')
    foreach ( $file in @(
        'default.css',
        'common.css',
        'dashboard-common.css',
        'fa-icons.css'
    ) ) {
        $source = if ( $file -eq 'default.css' ) {
            Join-Path $uboRoot 'src/css/themes/default.css'
        } else {
            Join-Path $uboRoot "src/css/$file"
        }
        Copy-RequiredFile $source (Join-Path $outputDirectory "css/$file")
    }

    foreach ( $file in @(
        'arglist-parser.js',
        'dom.js',
        'fa-icons.js',
        'i18n.js',
        'jsonpath.js',
        'redirect-resources.js',
        'static-filtering-parser.js',
        'urlskip.js'
    ) ) {
        Copy-RequiredFile (Join-Path $uboRoot "src/js/$file") `
            (Join-Path $outputDirectory "js/$file")
    }
    Copy-RequiredFile (Join-Path $uboRoot 'src/js/regex-analyzer.js') `
        (Join-Path $outputDirectory 'js/offscreen/regex-analyzer.js')
    Copy-TreeContents (Join-Path $uboRoot 'src/js/resources') `
        (Join-Path $outputDirectory 'js/resources')
    Copy-RequiredFile (Join-Path $uboRoot 'src/lib/punycode.js') `
        (Join-Path $outputDirectory 'js/punycode.js')
    Copy-RequiredFile (Join-Path $uboRoot 'src/lib/publicsuffixlist/publicsuffixlist.js') `
        (Join-Path $outputDirectory 'lib/publicsuffixlist.js')
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/regexanalyzer') `
        (Join-Path $outputDirectory 'lib/regexanalyzer')
    Copy-TreeContents (Join-Path $uboRoot 'src/img/flags-of-the-world') `
        (Join-Path $outputDirectory 'img/flags-of-the-world')
    Copy-RequiredFile (Join-Path $projectRoot 'LICENSE.txt') `
        (Join-Path $outputDirectory 'LICENSE.txt')
    Copy-RequiredFile (Join-Path $projectRoot 'NOTICE.md') `
        (Join-Path $outputDirectory 'NOTICE.md')

    Write-Host '*** uBlock Plus+ MV3: Copying MV3-specific files'
    $mv3Root = Join-Path $projectRoot 'platform/mv3'
    $extensionRoot = Join-Path $mv3Root 'extension'
    Copy-RequiredFile (Join-Path $mv3Root 'chromium/manifest.json') `
        (Join-Path $outputDirectory 'manifest.json')
    Copy-MatchingFiles $extensionRoot '*.html' $outputDirectory
    Copy-MatchingFiles $extensionRoot '*.json' $outputDirectory
    Copy-TreeContents (Join-Path $extensionRoot 'filter-store') `
        (Join-Path $outputDirectory 'filter-store')
    Copy-TreeContents (Join-Path $extensionRoot 'css') `
        (Join-Path $outputDirectory 'css')
    Copy-TreeContents (Join-Path $extensionRoot 'js') `
        (Join-Path $outputDirectory 'js')
    Copy-OptionalFile (Join-Path $mv3Root 'chromium/ext-compat.js') `
        (Join-Path $outputDirectory 'js/ext-compat.js')
    Copy-OptionalFile (Join-Path $mv3Root 'chromium/ext-offscreen.js') `
        (Join-Path $outputDirectory 'js/ext-offscreen.js')
    Copy-OptionalFile (Join-Path $mv3Root 'chromium/css-api.js') `
        (Join-Path $outputDirectory 'js/scripting/css-api.js')
    Copy-OptionalFile (Join-Path $mv3Root 'chromium/css-user.js') `
        (Join-Path $outputDirectory 'js/scripting/css-user.js')
    Copy-TreeContents (Join-Path $extensionRoot 'img') `
        (Join-Path $outputDirectory 'img')
    if ( Test-Path -LiteralPath (Join-Path $mv3Root 'chromium/img') ) {
        Copy-TreeContents (Join-Path $mv3Root 'chromium/img') `
            (Join-Path $outputDirectory 'img')
    }
    Copy-TreeContents (Join-Path $extensionRoot '_locales') `
        (Join-Path $outputDirectory '_locales')
    Invoke-NativeCommand $node @(
        'tools/merge-mv3-locale-fallbacks.mjs',
        $outputDirectory
    ) $projectRoot
    Copy-RequiredFile (Join-Path $mv3Root 'README.md') `
        (Join-Path $outputDirectory 'README.md')

    $codeMirrorRoot = Join-Path $extensionRoot 'lib/codemirror'
    Copy-MatchingFiles $codeMirrorRoot '*' `
        (Join-Path $outputDirectory 'lib/codemirror')
    Copy-RequiredFile (
        Join-Path $codeMirrorRoot 'codemirror-ubol/dist/cm6.bundle.ubol.min.js'
    ) (Join-Path $outputDirectory 'lib/codemirror/cm6.bundle.ublock-plus.min.js')
    Copy-RequiredFile (Join-Path $codeMirrorRoot 'codemirror.LICENSE') `
        (Join-Path $outputDirectory 'lib/codemirror/codemirror.LICENSE')
    Copy-RequiredFile (Join-Path $codeMirrorRoot 'codemirror-ubol/LICENSE') `
        (Join-Path $outputDirectory 'lib/codemirror/codemirror-quickstart.LICENSE')
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/csstree') `
        (Join-Path $outputDirectory 'lib/csstree')
    Copy-RequiredFile (
        Join-Path $extensionRoot 'lib/s14e-serializer/s14e-serializer.js'
    ) (Join-Path $outputDirectory 'lib/s14e-serializer.js')
    Copy-RequiredFile (
        Join-Path $extensionRoot 'lib/s14e-serializer/LICENSE'
    ) (Join-Path $outputDirectory 'lib/s14e-serializer.LICENSE')

    Write-Host '*** uBlock Plus+ MV3: Generating rulesets'
    $rulesetBuildDirectory = New-BuildTempDirectory
    $temporaryDirectories.Add($rulesetBuildDirectory)

    New-Directory (Join-Path $rulesetBuildDirectory 'js')
    foreach ( $file in @(
        'arglist-parser.js',
        'base64-custom.js',
        'biditrie.js',
        'dynamic-net-filtering.js',
        'filtering-context.js',
        'hnswitches.js',
        'hntrie.js',
        'jsonpath.js',
        'redirect-resources.js',
        'regex-analyzer.js',
        's14e-serializer.js',
        'static-dnr-filtering.js',
        'static-filtering-parser.js',
        'static-net-filtering.js',
        'static-filtering-io.js',
        'tasks.js',
        'text-utils.js',
        'urlskip.js',
        'uri-utils.js',
        'url-net-filtering.js'
    ) ) {
        Copy-RequiredFile (Join-Path $uboRoot "src/js/$file") `
            (Join-Path $rulesetBuildDirectory "js/$file")
    }
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/csstree') `
        (Join-Path $rulesetBuildDirectory 'lib/csstree')
    Copy-RequiredFile (Join-Path $uboRoot 'src/lib/punycode.js') `
        (Join-Path $rulesetBuildDirectory 'lib/punycode.js')
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/regexanalyzer') `
        (Join-Path $rulesetBuildDirectory 'lib/regexanalyzer')
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/publicsuffixlist') `
        (Join-Path $rulesetBuildDirectory 'lib/publicsuffixlist')
    Copy-TreeContents (Join-Path $uboRoot 'src/js/wasm') `
        (Join-Path $rulesetBuildDirectory 'js/wasm')
    Convert-WasmToJson (Join-Path $uboRoot 'src/js/wasm/hntrie.wasm') `
        (Join-Path $rulesetBuildDirectory 'js/wasm/hntrie.wasm.json')
    Convert-WasmToJson (Join-Path $uboRoot 'src/js/wasm/biditrie.wasm') `
        (Join-Path $rulesetBuildDirectory 'js/wasm/biditrie.wasm.json')
    Convert-WasmToJson (
        Join-Path $uboRoot 'src/lib/publicsuffixlist/wasm/publicsuffixlist.wasm'
    ) (
        Join-Path $rulesetBuildDirectory `
            'lib/publicsuffixlist/wasm/publicsuffixlist.wasm.json'
    )
    Copy-MatchingFiles (Join-Path $projectRoot 'platform/nodejs') '*.js' `
        $rulesetBuildDirectory
    Copy-RequiredFile (Join-Path $projectRoot 'LICENSE.txt') `
        (Join-Path $rulesetBuildDirectory 'LICENSE.txt')

    Copy-MatchingFiles $mv3Root '*.json' $rulesetBuildDirectory
    Copy-MatchingFiles $mv3Root '*.js' $rulesetBuildDirectory
    Copy-MatchingFiles $mv3Root '*.mjs' $rulesetBuildDirectory
    Copy-RequiredFile (Join-Path $extensionRoot 'js/ubo-parser.js') `
        (Join-Path $rulesetBuildDirectory 'js/ubo-parser.js')
    Copy-RequiredFile (Join-Path $extensionRoot 'js/compiled-popup-matcher.js') `
        (Join-Path $rulesetBuildDirectory 'js/compiled-popup-matcher.js')
    Copy-RequiredFile (Join-Path $extensionRoot 'js/utils.js') `
        (Join-Path $rulesetBuildDirectory 'js/utils.js')
    # make-rulesets imports offscreen/fetch-list.js, whose fetch-policy module
    # lives one directory above the copied offscreen tree.
    Copy-RequiredFile (Join-Path $extensionRoot 'js/imported-fetch-policy.js') `
        (Join-Path $rulesetBuildDirectory 'js/imported-fetch-policy.js')
    Copy-RequiredFile (Join-Path $uboRoot 'src/lib/punycode.js') `
        (Join-Path $rulesetBuildDirectory 'js/punycode.js')
    Copy-TreeContents (Join-Path $uboRoot 'src/lib/regexanalyzer') `
        (Join-Path $rulesetBuildDirectory 'js/regexanalyzer')
    Copy-TreeContents (Join-Path $uboRoot 'src/js/resources') `
        (Join-Path $rulesetBuildDirectory 'js/resources')
    Copy-TreeContents (Join-Path $mv3Root 'scriptlets') `
        (Join-Path $rulesetBuildDirectory 'scriptlets')
    Copy-TreeContents (Join-Path $extensionRoot 'js/offscreen') `
        (Join-Path $rulesetBuildDirectory 'js/offscreen')
    Copy-RequiredFile (Join-Path $uboRoot 'src/js/regex-analyzer.js') `
        (Join-Path $rulesetBuildDirectory 'js/offscreen/regex-analyzer.js')
    Copy-TreeContents (Join-Path $uboRoot 'src/web_accessible_resources') `
        (Join-Path $rulesetBuildDirectory 'web_accessible_resources')
    Copy-TreeContents (Join-Path $mv3Root 'chromium') `
        (Join-Path $rulesetBuildDirectory 'chromium')

    $rulesetArguments = @(
        '--no-warnings',
        'make-rulesets.js',
        "output=$outputDirectory",
        "platform=$Platform"
    )
    $maximumAttempts = 3
    for ( $attempt = 1; $attempt -le $maximumAttempts; $attempt += 1 ) {
        try {
            Invoke-NativeCommand $node $rulesetArguments $rulesetBuildDirectory
            break
        } catch {
            if ( $attempt -eq $maximumAttempts ) { throw }
            Write-Warning (
                "Ruleset generation failed on attempt $attempt; retrying " +
                'with the downloaded-list cache.'
            )
            Copy-RequiredFile (Join-Path $mv3Root 'chromium/manifest.json') `
                (Join-Path $outputDirectory 'manifest.json')
            Start-Sleep -Seconds (2 * $attempt)
        }
    }

    if ( $beforeDirectory -ne '' ) {
        Write-Host '*** uBlock Plus+ MV3: Salvaging rule IDs to minimize diff size'
        Invoke-NativeCommand $node @(
            'salvage-ruleids.mjs',
            ('before=' + (Join-Path $beforeDirectory $Platform)),
            "after=$outputDirectory"
        ) $rulesetBuildDirectory
    }

    $manifestPath = Join-Path $outputDirectory 'manifest.json'
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ( $Version -eq '' ) {
        $packageVersion = [string] $manifest.version
        $permissions = @($manifest.permissions)
        if ( $permissions -notcontains 'declarativeNetRequestFeedback' ) {
            $manifest.permissions = @(
                $permissions + 'declarativeNetRequestFeedback'
            )
        }
    } else {
        $packageVersion = $Version
        $manifest.version = $Version
        $debugRules = Join-Path $outputDirectory 'rulesets/debug'
        if ( Test-Path -LiteralPath $debugRules ) {
            Remove-Item -LiteralPath $debugRules -Recurse -Force
        }
    }
    if ( $ExperimentalWebRequest ) {
        # Apply after ruleset generation, which can restore the standard manifest
        # when retrying. The baseline DNR engine remains in this separate build.
        $manifest.permissions = @(
            @($manifest.permissions) + @('webRequest', 'webRequestBlocking') |
                Select-Object -Unique
        )
        $manifest.optional_permissions = @(
            $manifest.optional_permissions | Where-Object { $_ -ne 'webRequest' }
        )
        $manifest.name = 'uBlock Plus+ Experimental'
        $manifest | Add-Member -MemberType NoteProperty -Name key `
            -Value $experimentalMetadata.publicKey -Force
        Write-Utf8NoBom (Join-Path $outputDirectory 'experimental-webrequest.json') (
            ($experimentalMetadata | ConvertTo-Json -Depth 10) + "`n"
        )
        Copy-RequiredFile (Join-Path $projectRoot 'tools/start-experimental-chrome.ps1') `
            (Join-Path $outputDirectory 'start-experimental-chrome.ps1')
        Copy-RequiredFile (Join-Path $projectRoot 'tools/start-experimental-chrome.cmd') `
            (Join-Path $outputDirectory 'start-experimental-chrome.cmd')
    }
    Write-Utf8NoBom $manifestPath (
        ($manifest | ConvertTo-Json -Depth 100) + "`n"
    )

    Write-Host "*** uBlock Plus+ ${Platform}: Extension ready"
    Write-Host "Extension location: $outputDirectory"

    $createPackage = $Full.IsPresent -or $Version -ne ''
    if ( $createPackage ) {
        if ( $ExperimentalWebRequest ) {
            Write-Host '*** uBlock Plus+ MV3: Creating experimental package'
        } else {
            Write-Host '*** uBlock Plus+ MV3: Creating publishable package'
        }
        $packageDirectory = New-BuildTempDirectory
        $temporaryDirectories.Add($packageDirectory)
        Copy-TreeContents $outputDirectory $packageDirectory
        $logFile = Join-Path $packageDirectory 'log.txt'
        if ( Test-Path -LiteralPath $logFile ) {
            Remove-Item -LiteralPath $logFile -Force
        }

        $packageName = "uBlock-Plus_$packageVersion$editionSuffix.$Platform.zip"
        $packagePath = Join-Path $buildRoot $packageName
        if ( Test-Path -LiteralPath $packagePath ) {
            Remove-Item -LiteralPath $packagePath -Force
        }
        New-ZipFromDirectory $packageDirectory $packagePath
        $checksumPath = "$packagePath.sha256"
        $checksum = (Get-FileHash -LiteralPath $packagePath `
            -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Utf8NoBom $checksumPath "$checksum  $packageName`n"
        Write-Host "Package location: $packagePath"
        Write-Host "Checksum location: $checksumPath"
    }
} finally {
    foreach ( $directory in $temporaryDirectories ) {
        if ( Test-Path -LiteralPath $directory ) {
            Remove-Item -LiteralPath $directory -Recurse -Force
        }
    }
}

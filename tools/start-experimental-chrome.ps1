# uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
#Requires -Version 5.1

<#
.SYNOPSIS
Opens a dedicated Chrome profile for the experimental webRequest supplement.
.DESCRIPTION
Run this launcher on every start of the experimental profile. On the first run,
enable Developer mode at chrome://extensions, select Load unpacked, and choose
the extension directory printed below. Chrome's unsupported-flag warning remains
visible. The launcher does not install a policy, alter shortcuts, or use your
personal Chrome profile. The extension still uses its DNR baseline.
The included start-experimental-chrome.cmd supports double-click launch. Its
ExecutionPolicy Bypass applies only to that PowerShell process and does not
change any saved Windows or Chrome policy.
.PARAMETER ExtensionDirectory
The unpacked experimental build. Defaults to the directory containing this
packaged launcher, or the experimental build directory when run from tools/.
.PARAMETER ChromePath
Explicit path to chrome.exe. Otherwise the installed Google Chrome is located.
.PARAMETER PrintCommand
Validate the build and print a JSON launch specification without starting Chrome
or creating a profile. Useful for inspecting the exact executable and arguments.
#>
[CmdletBinding()]
param(
    [string] $ExtensionDirectory = '',
    [string] $ChromePath = '',
    [switch] $PrintCommand
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ( [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT ) {
    throw 'This launcher supports Windows only.'
}

function Read-JsonFile {
    param([Parameter(Mandatory)][string] $Path)
    if ( (Test-Path -LiteralPath $Path -PathType Leaf) -eq $false ) {
        throw "Required experimental build file is missing: $Path"
    }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Assert-NoReparsePoint {
    param([Parameter(Mandatory)][string] $Path)
    $probe = [IO.Path]::GetFullPath($Path)
    while ( $probe -ne '' ) {
        if ( Test-Path -LiteralPath $probe ) {
            $item = Get-Item -LiteralPath $probe -Force
            if ( ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 ) {
                throw "The isolated profile path must not use junctions or symbolic links: $probe"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if ( $null -eq $parent -or $parent -eq $probe ) { break }
        $probe = $parent
    }
}

if ( $ExtensionDirectory -eq '' ) {
    $ExtensionDirectory = if ( Test-Path -LiteralPath (
        Join-Path $PSScriptRoot 'experimental-webrequest.json'
    ) ) {
        $PSScriptRoot
    } else {
        Join-Path $PSScriptRoot '../dist/build/uBlockPlus.experimental.chromium'
    }
}
$extensionRoot = [IO.Path]::GetFullPath($ExtensionDirectory)
$metadata = Read-JsonFile (Join-Path $extensionRoot 'experimental-webrequest.json')
$manifest = Read-JsonFile (Join-Path $extensionRoot 'manifest.json')
$expectedId = 'fokcgioblkdjdajdeifgfjgmnejmgggg'
if ( $metadata.schemaVersion -ne 1 -or
    $metadata.edition -ne 'experimental-webrequest' -or
    $metadata.extensionId -cne $expectedId ) {
    throw 'This is not the supported uBlock Plus+ experimental build identity.'
}
try {
    $publicKeyBytes = [Convert]::FromBase64String($metadata.publicKey)
    if ( [Convert]::ToBase64String($publicKeyBytes) -cne $metadata.publicKey ) {
        throw 'Non-canonical public key'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($publicKeyBytes) } finally { $sha.Dispose() }
    $hex = -join ($digest[0..15] | ForEach-Object { $_.ToString('x2') })
    $derivedId = -join ($hex.ToCharArray() | ForEach-Object {
        [char](97 + [Convert]::ToInt32([string] $_, 16))
    })
} catch {
    throw 'The experimental build contains an invalid public key.'
}
if ( $derivedId -cne $expectedId -or
    $manifest.key -cne $metadata.publicKey -or
    $manifest.manifest_version -ne 3 -or
    $manifest.name -cne 'uBlock Plus+ Experimental' ) {
    throw 'The experimental manifest, public key, and extension ID do not match.'
}
foreach ( $permission in @('webRequest', 'webRequestBlocking', 'declarativeNetRequest') ) {
    if ( @($manifest.permissions) -notcontains $permission -or
        @($manifest.optional_permissions) -contains $permission ) {
        throw "Experimental manifest must require $permission without an optional duplicate."
    }
}
if ( (Test-Path -LiteralPath (Join-Path $extensionRoot 'js/webrequest-firewall.js') `
    -PathType Leaf) -eq $false ) {
    throw 'The experimental firewall runtime is missing. Rebuild the extension.'
}

if ( $ChromePath -eq '' ) {
    $candidates = @(
        (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Google/Chrome/Application/chrome.exe'),
        (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Google/Chrome/Application/chrome.exe'),
        (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Google/Chrome/Application/chrome.exe')
    )
    $ChromePath = [string]($candidates | Where-Object {
        Test-Path -LiteralPath $_ -PathType Leaf
    } | Select-Object -First 1)
}
if ( $ChromePath -eq '' -or
    (Test-Path -LiteralPath $ChromePath -PathType Leaf) -eq $false -or
    [IO.Path]::GetFileName($ChromePath) -ine 'chrome.exe' ) {
    throw 'Google Chrome was not found. Pass -ChromePath with the path to chrome.exe.'
}
$chromeExecutable = [IO.Path]::GetFullPath($ChromePath)
$localData = [Environment]::GetFolderPath('LocalApplicationData')
if ( $localData -eq '' ) { throw 'Windows LocalApplicationData directory is unavailable.' }
$profileBase = [IO.Path]::GetFullPath((Join-Path $localData 'uBlockPlus/ExperimentalChrome'))
$profileDirectory = [IO.Path]::GetFullPath((Join-Path $profileBase $expectedId))
if ( $profileDirectory.StartsWith(
    $profileBase + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
) -eq $false ) {
    throw 'The experimental profile path escaped its dedicated directory.'
}
Assert-NoReparsePoint $profileDirectory
$profileMarkerPath = Join-Path $profileDirectory '.ublock-plus-profile.json'
if ( Test-Path -LiteralPath $profileDirectory ) {
    if ( (Test-Path -LiteralPath $profileDirectory -PathType Container) -eq $false ) {
        throw 'The experimental profile path is not a directory.'
    }
    if ( Test-Path -LiteralPath $profileMarkerPath ) {
        $profileMarker = Read-JsonFile $profileMarkerPath
        if ( $profileMarker.edition -ne 'experimental-webrequest' -or
            $profileMarker.extensionId -cne $expectedId ) {
            throw 'The existing profile does not belong to this experimental build.'
        }
    } elseif ( @(Get-ChildItem -LiteralPath $profileDirectory -Force).Count -ne 0 ) {
        throw 'Refusing to reuse an existing profile without an experimental ownership marker.'
    }
}
$launchArguments = @(
    "--user-data-dir=$profileDirectory",
    "--allowlisted-extension-id=$expectedId",
    '--no-first-run',
    '--no-default-browser-check',
    'chrome://extensions/'
)
if ( $PrintCommand ) {
    [ordered]@{
        executable = $chromeExecutable
        arguments = $launchArguments
        extensionDirectory = $extensionRoot
        extensionId = $expectedId
        profileDirectory = $profileDirectory
        firstRun = 'Enable Developer mode, choose Load unpacked, and select extensionDirectory.'
    } | ConvertTo-Json -Depth 5
    return
}

New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
if ( (Test-Path -LiteralPath $profileMarkerPath) -eq $false ) {
    [IO.File]::WriteAllText($profileMarkerPath, (
        [ordered]@{ edition = 'experimental-webrequest'; extensionId = $expectedId } |
            ConvertTo-Json
    ), [Text.UTF8Encoding]::new($false))
}
Write-Host "Experimental extension: $extensionRoot"
Write-Host 'First run: enable Developer mode, choose Load unpacked, and select that directory.'
Write-Host 'Use this launcher every time. DNR remains the baseline; this is not an unlimited MV3 engine.'
# Windows paths cannot contain quotes. Quote every argument so paths with spaces
# remain a single argument; none of these arguments ends in a backslash.
$nativeArguments = ($launchArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
Start-Process -FilePath $chromeExecutable -ArgumentList $nativeArguments -WindowStyle Normal

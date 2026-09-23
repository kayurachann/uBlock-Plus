# uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
#Requires -Version 5.1

<#
.SYNOPSIS
Installs the uBlock Plus+ automatic updater for the current Windows user.
.DESCRIPTION
Run this once from the updater folder of an unpacked uBlock Plus+ build, for
example by double-clicking install-updater.cmd. Later releases then install
from the extension's Settings > Updates, or automatically when that option is
enabled.

The script copies the updater to %LOCALAPPDATA%\uBlockPlus\Updater and
registers it as a Chrome native messaging host under HKCU for Google Chrome,
Microsoft Edge, Chromium and Brave. It does not require administrator rights
and does not add a service, scheduled task, startup entry or browser policy.
Only the extension ID(s) registered here may start the updater.

When the target folder is empty or missing, the newest verified release is
downloaded into it first. Load that folder once with Load unpacked.

The updater replaces files only in a folder that other users of this PC
cannot change, such as one under your user profile, and the script refuses
other folders.
.PARAMETER ExtensionDirectory
The unpacked extension folder, the one containing manifest.json. Defaults to
the parent of this updater folder, or %LOCALAPPDATA%\uBlockPlus\Extension.
.PARAMETER ExtensionId
Extra extension ID(s) to trust. The dashboard shows the exact command when
the browser reports an ID that this script could not derive from the path.
.PARAMETER StableOnly
Ignore pre-releases when the updater looks for new versions.
.PARAMETER IncludePrerelease
Consider pre-releases again (the default). Options passed on the command line
replace stored ones; options not passed keep their stored values.
.PARAMETER Replace
Move a registration to this folder when another registered folder uses the
same extension ID (experimental builds share one ID).
.PARAMETER ResetKeys
Replace the trusted release signing keys with the set this folder ships, even
when it is an older set or lacks keys that are trusted now. Use only for
deliberate recovery.
.PARAMETER Force
Install the updater from this folder even when an installed one is newer.
.PARAMETER Uninstall
Remove the registration for ExtensionDirectory and the updater's backup,
download and state for it. When no installation remains, remove the updater
files and registry entries. The extension is not removed.
#>
[CmdletBinding()]
param(
    [string] $ExtensionDirectory = '',
    [string[]] $ExtensionId = @(),
    [switch] $StableOnly,
    [switch] $IncludePrerelease,
    [switch] $Replace,
    [switch] $ResetKeys,
    [switch] $Force,
    [switch] $Uninstall,
    [string] $Repository = 'kayurachann/uBlock-Plus',
    [string] $ReleaseBaseUrl = '',
    [string] $ApiBaseUrl = 'https://api.github.com',
    [string] $InstallRoot = '',
    [switch] $NoRegistry
)

# Windows PowerShell started from PowerShell 7 (a PowerShell 7 terminal, a
# GitHub Actions step) inherits PowerShell 7's module path, from which it
# cannot load its own modules: Get-FileHash, Get-Acl and others go missing.
# Its own modules come first. No cmdlet may run before this line.
if ( $PSVersionTable.PSEdition -ne 'Core' ) {
    $env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath"
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HostName = 'io.github.kayurachann.ublock_plus.updater'
$Utf8 = New-Object Text.UTF8Encoding $false
$RegistryRoots = @(
    @{ Browser = 'Google Chrome'; Path = 'HKCU:\Software\Google\Chrome'; Always = $true },
    @{ Browser = 'Microsoft Edge'; Path = 'HKCU:\Software\Microsoft\Edge'; Always = $false },
    @{ Browser = 'Chromium'; Path = 'HKCU:\Software\Chromium'; Always = $false },
    @{ Browser = 'Brave'; Path = 'HKCU:\Software\BraveSoftware\Brave-Browser'; Always = $false }
)

if ( [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT ) {
    throw 'The uBlock Plus+ updater supports Windows only.'
}
if ( $Repository -notmatch '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' ) {
    throw "Invalid repository: $Repository"
}
if ( $StableOnly -and $IncludePrerelease ) {
    throw 'Pass either -StableOnly or -IncludePrerelease, not both.'
}
if ( $ReleaseBaseUrl -eq '' ) { $ReleaseBaseUrl = "https://github.com/$Repository/releases/download" }
if ( $InstallRoot -eq '' ) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'uBlockPlus\Updater' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')

function Get-CanonicalPath {
    param([Parameter(Mandatory)][string] $Path)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($full)
    if ( $root -match '^[a-zA-Z]:\\$' ) { $root = $root.ToUpperInvariant() }
    $current = $root.TrimEnd('\')
    foreach ( $part in $full.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries) ) {
        $parent = if ( $current.EndsWith(':') ) { "$current\" } else { $current }
        $match = $null
        if ( Test-Path -LiteralPath $parent -PathType Container ) {
            $match = [IO.Directory]::GetFileSystemEntries($parent, $part) | Select-Object -First 1
        }
        if ( $null -eq $match ) { return $full }
        $current = $match.TrimEnd('\')
    }
    return $current
}

function Get-IdFromBytes {
    param([Parameter(Mandatory)][byte[]] $Bytes)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($Bytes)
    return -join ($hash[0..15] | ForEach-Object {
        [char] (97 + ($_ -shr 4))
        [char] (97 + ($_ -band 15))
    })
}

# Chromium derives an unpacked extension's ID from its absolute path: SHA-256
# of the UTF-16LE path (drive letter upper-cased), first 128 bits mapped to a-p.
function Get-UnpackedExtensionId {
    param([Parameter(Mandatory)][string] $Path)
    $normalized = $Path.TrimEnd('\')
    if ( $normalized -match '^[a-z]:' ) {
        $normalized = $normalized.Substring(0, 1).ToUpperInvariant() + $normalized.Substring(1)
    }
    return Get-IdFromBytes ([Text.Encoding]::Unicode.GetBytes($normalized))
}

function Read-Json {
    param([Parameter(Mandatory)][string] $Path)
    return [IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json
}

function Write-Json {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)] $Value)
    [IO.File]::WriteAllText("$Path.tmp", ($Value | ConvertTo-Json -Depth 8), $Utf8)
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}

function Get-ExtensionIdentity {
    param([Parameter(Mandatory)][string] $Directory)
    $manifestPath = Join-Path $Directory 'manifest.json'
    if ( (Test-Path -LiteralPath $manifestPath -PathType Leaf) -eq $false ) { return $null }
    $manifest = Read-Json $manifestPath
    if ( $manifest.manifest_version -ne 3 -or $manifest.short_name -cne 'uBlock Plus+' ) {
        throw "$Directory does not contain a uBlock Plus+ extension."
    }
    $experimental = Test-Path -LiteralPath (Join-Path $Directory 'experimental-webrequest.json') -PathType Leaf
    $key = $manifest.PSObject.Properties['key']
    return [pscustomobject] @{
        Version = [string] $manifest.version
        Edition = if ( $experimental ) { 'experimental' } else { 'standard' }
        Key = if ( $null -ne $key ) { [string] $key.Value } else { '' }
    }
}

function Get-UpdaterConfig {
    $path = Join-Path $InstallRoot 'config.json'
    if ( Test-Path -LiteralPath $path -PathType Leaf ) {
        try {
            $existing = Read-Json $path
            if ( $existing.schemaVersion -eq 1 ) {
                return [ordered] @{
                    schemaVersion = 1
                    repository = [string] $existing.repository
                    releaseBaseUrl = [string] $existing.releaseBaseUrl
                    apiBaseUrl = [string] $existing.apiBaseUrl
                    includePrerelease = $existing.includePrerelease -ne $false
                    installations = @($existing.installations | Where-Object { $null -ne $_ })
                }
            }
        } catch {
            Write-Warning "Replacing an unreadable updater configuration: $($_.Exception.Message)"
        }
    }
    return [ordered] @{
        schemaVersion = 1; repository = $Repository; releaseBaseUrl = $ReleaseBaseUrl
        apiBaseUrl = $ApiBaseUrl; includePrerelease = $true; installations = @()
    }
}

function Get-AllowedOrigins {
    param([Parameter(Mandatory)] $Installations)
    $ids = @($Installations | ForEach-Object { $_.extensionIds } | Sort-Object -Unique)
    return @($ids | ForEach-Object { "chrome-extension://$_/" })
}

function Set-HostRegistration {
    param([Parameter(Mandatory)][string] $ManifestPath)
    $registered = @()
    if ( $NoRegistry ) { return $registered }
    foreach ( $root in $RegistryRoots ) {
        if ( -not $root.Always -and -not (Test-Path -LiteralPath $root.Path) ) { continue }
        $key = "$($root.Path)\NativeMessagingHosts\$HostName"
        New-Item -Path $key -Force | Out-Null
        Set-Item -LiteralPath $key -Value $ManifestPath
        $registered += $root.Browser
    }
    return $registered
}

function Remove-HostRegistration {
    if ( $NoRegistry ) { return }
    foreach ( $root in $RegistryRoots ) {
        $key = "$($root.Path)\NativeMessagingHosts\$HostName"
        if ( Test-Path -LiteralPath $key ) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
}

function Get-UpdaterSource {
    # Prefer the updater that ships next to this script (package or source
    # tree). A standalone copy of this script fetches it from the repository.
    $local = Join-Path $PSScriptRoot 'ublock-plus-updater.ps1'
    if ( $PSScriptRoot -ne '' -and (Test-Path -LiteralPath $local -PathType Leaf) ) { return $PSScriptRoot }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("ubp-updater-" + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
        [Net.SecurityProtocolType]::Tls12
    foreach ( $name in 'ublock-plus-updater.ps1', 'ublock-plus-updater.cmd', 'release-signing-keys.json' ) {
        $url = "https://raw.githubusercontent.com/$Repository/main/platform/mv3/updater/$name"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $temporary $name)
    }
    return $temporary
}

function Get-KeyIdentities {
    param([Parameter(Mandatory)][string] $Path)
    # "id n e" for every key of a release key file; empty when there is none.
    if ( (Test-Path -LiteralPath $Path -PathType Leaf) -eq $false ) { return ,@() }
    $document = Read-Json $Path
    if ( $document.schemaVersion -ne 1 ) { throw "Unsupported release key file: $Path" }
    return ,@($document.keys | Where-Object { $null -ne $_ } | ForEach-Object { '{0} {1} {2}' -f $_.id, $_.n, $_.e })
}

function Get-KeyGeneration {
    param([Parameter(Mandatory)][string] $Path)
    # The generation of a release key file: tools/release-signing.mjs raises
    # it whenever it adds or retires a key. 0 when there is none.
    if ( (Test-Path -LiteralPath $Path -PathType Leaf) -eq $false ) { return 0 }
    $property = (Read-Json $Path).PSObject.Properties['generation']
    if ( $null -eq $property ) { return 0 }
    if ( ($property.Value -isnot [int] -and $property.Value -isnot [long]) -or $property.Value -lt 0 ) {
        throw "Unsupported release key file: $Path"
    }
    return [long] $property.Value
}

function Assert-UpdatableFolder {
    param([Parameter(Mandatory)][string] $Updater, [Parameter(Mandatory)][string] $Directory)
    # Runs the updater's own folder check (links, system and profile folders,
    # folders that other users of this PC may change) in a separate process,
    # so that the installer and the updater always agree.
    $literal = { param([string] $Value) "'{0}'" -f $Value.Replace("'", "''") }
    $command = ('try {{ . {0}; $script:DataRoot = {1}; $null = Assert-SafeExtensionDirectory {2}; exit 0 }} ' +
        'catch {{ [Console]::Out.WriteLine($_.Exception.Message); exit 1 }}') -f
        (& $literal $Updater), (& $literal $InstallRoot), (& $literal $Directory)
    $message = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command
    if ( $LASTEXITCODE -ne 0 ) {
        throw "The updater cannot manage this folder. $(@($message) -join ' ')"
    }
}

function Get-UpdaterScriptVersion {
    param([Parameter(Mandatory)][string] $Path)
    # The version an updater script declares ($script:UpdaterVersion), or $null.
    if ( (Test-Path -LiteralPath $Path -PathType Leaf) -eq $false ) { return $null }
    $text = [IO.File]::ReadAllText($Path, $Utf8)
    if ( $text -cnotmatch "(?m)^\`$script:UpdaterVersion = '((?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,3})'\r?$" ) {
        return $null
    }
    return $Matches[1]
}

function Compare-UpdaterVersion {
    param([Parameter(Mandatory)][string] $Left, [Parameter(Mandatory)][string] $Right)
    $a = @($Left.Split('.') | ForEach-Object { [int] $_ })
    $b = @($Right.Split('.') | ForEach-Object { [int] $_ })
    for ( $i = 0; $i -lt 4; $i++ ) {
        $x = if ( $i -lt $a.Count ) { $a[$i] } else { 0 }
        $y = if ( $i -lt $b.Count ) { $b[$i] } else { 0 }
        if ( $x -ne $y ) { return [Math]::Sign($x - $y) }
    }
    return 0
}

function Enter-UpdaterLock {
    # The updater holds this lock while it stages, applies or rolls back.
    $path = Join-Path $InstallRoot 'updater.lock'
    try {
        return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw 'An update is running; try again in a minute.'
    }
}

function Remove-InstallationData {
    param([Parameter(Mandatory)][string] $Directory)
    # The download, backup and state the updater keeps for one folder, named
    # like its Get-InstallationPaths does.
    $bytes = $Utf8.GetBytes([IO.Path]::GetFullPath($Directory).TrimEnd('\').ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    $key = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    foreach ( $path in (Join-Path $InstallRoot "staging\$key"), (Join-Path $InstallRoot "backup\$key"),
        (Join-Path $InstallRoot "state-$key.json") ) {
        if ( Test-Path -LiteralPath $path ) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}

function Test-StableReleasePublished {
    param([Parameter(Mandatory)] $Config)
    # $true or $false from the release list; $null when it cannot be read.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
        [Net.SecurityProtocolType]::Tls12
    try {
        $url = '{0}/repos/{1}/releases?per_page=30' -f $Config.apiBaseUrl.TrimEnd('/'), $Config.repository
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 30 -Headers @{ Accept = 'application/vnd.github+json' }
        $releases = $response.Content | ConvertFrom-Json
    } catch {
        return $null
    }
    foreach ( $release in @($releases) ) {
        $draft = $release.PSObject.Properties['draft']
        $prerelease = $release.PSObject.Properties['prerelease']
        if ( ($null -eq $draft -or $draft.Value -ne $true) -and $null -ne $prerelease -and $prerelease.Value -eq $false ) {
            return $true
        }
    }
    return $false
}

# ---------------------------------------------------------------------------

if ( $ExtensionDirectory -eq '' ) {
    $parent = if ( $PSScriptRoot -ne '' ) { Split-Path -Parent $PSScriptRoot } else { '' }
    if ( $parent -ne '' -and (Test-Path -LiteralPath (Join-Path $parent 'manifest.json') -PathType Leaf) ) {
        $ExtensionDirectory = $parent
    } else {
        $ExtensionDirectory = Join-Path $env:LOCALAPPDATA 'uBlockPlus\Extension'
    }
}
$extensionRoot = [IO.Path]::GetFullPath($ExtensionDirectory).TrimEnd('\')
$canonicalRoot = Get-CanonicalPath $extensionRoot
$configPath = Join-Path $InstallRoot 'config.json'
$hostManifestPath = Join-Path $InstallRoot "$HostName.json"
$config = Get-UpdaterConfig
$others = @($config.installations | Where-Object {
    -not [string]::Equals(([string] $_.extensionDir).TrimEnd('\'), $canonicalRoot, [StringComparison]::OrdinalIgnoreCase)
})

$previous = @($config.installations | Where-Object {
    [string]::Equals(([string] $_.extensionDir).TrimEnd('\'), $canonicalRoot, [StringComparison]::OrdinalIgnoreCase)
})

if ( $Uninstall ) {
    # Wait for a running update: removing its download or backup mid-copy
    # would leave the extension folder half replaced.
    $lock = $null
    if ( Test-Path -LiteralPath $InstallRoot -PathType Container ) { $lock = Enter-UpdaterLock }
    try {
        $config.installations = $others
        foreach ( $entry in $previous ) { Remove-InstallationData ([string] $entry.extensionDir) }
        if ( $others.Count -eq 0 ) {
            Remove-HostRegistration
            if ( $null -ne $lock ) {
                Get-ChildItem -LiteralPath $InstallRoot -Force | Where-Object { $_.Name -ne 'updater.lock' } |
                    Remove-Item -Recurse -Force
            }
        } else {
            Write-Json $configPath $config
            $hostManifest = Read-Json $hostManifestPath
            # @() keeps a one-element list an array: Chrome requires a JSON array.
            $hostManifest.allowed_origins = @(Get-AllowedOrigins $others)
            Write-Json $hostManifestPath $hostManifest
        }
    } finally {
        if ( $null -ne $lock ) { $lock.Dispose() }
    }
    if ( $others.Count -eq 0 ) {
        if ( Test-Path -LiteralPath $InstallRoot ) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
        Write-Host 'The uBlock Plus+ updater was removed. The extension folder was not changed.'
    } else {
        Write-Host "Stopped updating $canonicalRoot. Other installations remain registered."
    }
    return
}

foreach ( $id in $ExtensionId ) {
    if ( $id -cnotmatch '^[a-p]{32}$' ) { throw "Invalid extension ID: $id" }
}

$source = Get-UpdaterSource
# Refuse a folder that the updater would refuse to update before anything is
# registered. A missing folder is created first, so that the permissions it
# inherits are checked.
$created = $false
if ( (Test-Path -LiteralPath $canonicalRoot) -eq $false ) {
    [IO.Directory]::CreateDirectory($canonicalRoot) | Out-Null
    $created = $true
}
try {
    Assert-UpdatableFolder (Join-Path $source 'ublock-plus-updater.ps1') $canonicalRoot
} catch {
    if ( $created ) { Remove-Item -LiteralPath $canonicalRoot -Force -ErrorAction SilentlyContinue }
    throw
}

$identity = $null
if ( Test-Path -LiteralPath $canonicalRoot ) { $identity = Get-ExtensionIdentity $canonicalRoot }
$edition = if ( $null -ne $identity ) { $identity.Edition } else { 'standard' }
$ids = New-Object Collections.Generic.List[string]
if ( $null -ne $identity -and $identity.Key -ne '' ) {
    $ids.Add((Get-IdFromBytes ([Convert]::FromBase64String($identity.Key))))
} else {
    $ids.Add((Get-UnpackedExtensionId $canonicalRoot))
    $ids.Add((Get-UnpackedExtensionId $extensionRoot))
}
foreach ( $id in $ExtensionId ) { $ids.Add($id) }
foreach ( $entry in $previous ) { foreach ( $id in @($entry.extensionIds) ) { $ids.Add([string] $id) } }
$installation = [ordered] @{
    extensionDir = $canonicalRoot
    edition = $edition
    extensionIds = @($ids | Sort-Object -Unique)
}
# The updater cannot tell two folders with the same extension ID apart.
$clashing = @($others | Where-Object {
    @(@($_.extensionIds) | Where-Object { $installation.extensionIds -ccontains $_ }).Count -ne 0
})
if ( $clashing.Count -ne 0 -and -not $Replace ) {
    $shared = @(@($clashing[0].extensionIds) | Where-Object { $installation.extensionIds -ccontains $_ })[0]
    throw "$($clashing[0].extensionDir) is already registered for extension ID $shared. Pass -Replace to update this folder instead, or uninstall the other one first."
}
if ( $clashing.Count -ne 0 ) {
    $lock = Enter-UpdaterLock
    try {
        foreach ( $entry in $clashing ) { Remove-InstallationData ([string] $entry.extensionDir) }
    } finally {
        $lock.Dispose()
    }
    $others = @($others | Where-Object { $clashing -notcontains $_ })
    Write-Host "Stopped updating $(@($clashing | ForEach-Object { $_.extensionDir }) -join ', ')."
}

# Options passed on this command line replace the stored ones.
if ( $PSBoundParameters.ContainsKey('Repository') ) { $config.repository = $Repository }
if ( $PSBoundParameters.ContainsKey('Repository') -or $PSBoundParameters.ContainsKey('ReleaseBaseUrl') ) {
    $config.releaseBaseUrl = $ReleaseBaseUrl
}
if ( $PSBoundParameters.ContainsKey('ApiBaseUrl') ) { $config.apiBaseUrl = $ApiBaseUrl }
if ( $StableOnly ) { $config.includePrerelease = $false }
if ( $IncludePrerelease ) { $config.includePrerelease = $true }

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
# Never downgrade an updater that updated itself from a signed package.
$sourceVersion = Get-UpdaterScriptVersion (Join-Path $source 'ublock-plus-updater.ps1')
$installedVersion = Get-UpdaterScriptVersion (Join-Path $InstallRoot 'ublock-plus-updater.ps1')
if ( $Force -or $null -eq $installedVersion -or
    ($null -ne $sourceVersion -and (Compare-UpdaterVersion $sourceVersion $installedVersion) -ge 0) ) {
    foreach ( $name in 'ublock-plus-updater.ps1', 'ublock-plus-updater.cmd' ) {
        $target = Join-Path $InstallRoot $name
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Force
        Unblock-File -LiteralPath $target
    }
} else {
    Write-Host "Kept the installed updater $installedVersion, which is newer than $sourceVersion in this folder. Pass -Force to replace it."
}
# Pin the release signing keys that ship with this updater. A trusted key set
# is replaced by a non-empty set of a later generation, or by a set of the
# same generation that contains all of it, so that neither an older package
# nor an empty set brings back retired keys or unpins them.
$sourceKeys = Join-Path $source 'release-signing-keys.json'
$trustedKeys = Join-Path $InstallRoot 'release-signing-keys.json'
if ( Test-Path -LiteralPath $sourceKeys -PathType Leaf ) {
    $shipped = Get-KeyIdentities $sourceKeys
    $trusted = Get-KeyIdentities $trustedKeys
    $missing = @($trusted | Where-Object { $shipped -cnotcontains $_ })
    $shippedGeneration = Get-KeyGeneration $sourceKeys
    $trustedGeneration = Get-KeyGeneration $trustedKeys
    if ( $ResetKeys -or $trusted.Count -eq 0 -or
        ($shipped.Count -ne 0 -and $shippedGeneration -gt $trustedGeneration) -or
        ($shippedGeneration -eq $trustedGeneration -and $missing.Count -eq 0) ) {
        Copy-Item -LiteralPath $sourceKeys -Destination $trustedKeys -Force
    } else {
        Write-Host 'Kept the trusted release signing keys: this folder ships an older key set, or one without all of them. Pass -ResetKeys to replace them.'
    }
}
$signing = if ( (Get-KeyIdentities $trustedKeys).Count -gt 0 ) { 'required' } else { 'not configured (checksum only)' }

$config.installations = @($others) + @([pscustomobject] $installation)
Write-Json $configPath $config
Write-Json $hostManifestPath ([ordered] @{
    name = $HostName
    description = 'uBlock Plus+ updater'
    path = Join-Path $InstallRoot 'ublock-plus-updater.cmd'
    type = 'stdio'
    # @() keeps a one-element list an array: Chrome requires a JSON array.
    allowed_origins = @(Get-AllowedOrigins $config.installations)
})
$browsers = Set-HostRegistration $hostManifestPath

if ( $StableOnly -and (Test-StableReleasePublished $config) -eq $false ) {
    Write-Warning 'No stable release is published yet, so the updater finds no update until one is. Run this script with -IncludePrerelease to follow pre-releases.'
}

if ( $null -eq $identity ) {
    Write-Host "Downloading uBlock Plus+ into $canonicalRoot ..."
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'ublock-plus-updater.ps1') -Install -ExtensionDirectory $canonicalRoot
    if ( $LASTEXITCODE -ne 0 ) { throw 'The first download failed; the updater registration was kept. Run this script again.' }
}

Write-Host ''
Write-Host 'uBlock Plus+ updater installed.'
Write-Host "  Extension folder : $canonicalRoot"
Write-Host "  Edition          : $edition"
Write-Host "  Signed releases  : $signing"
Write-Host "  Extension ID(s)  : $($installation.extensionIds -join ', ')"
if ( $NoRegistry ) {
    Write-Host '  Browsers         : (registry skipped)'
} else {
    Write-Host "  Browsers         : $($browsers -join ', ')"
}
Write-Host ''
if ( $null -eq $identity ) {
    Write-Host 'Next: open chrome://extensions, enable Developer mode, choose Load unpacked and select the folder above.'
    Write-Host 'Then open the uBlock Plus+ dashboard > Settings > Updates, select Allow the updater, then Check now.'
} else {
    Write-Host 'Next: open the uBlock Plus+ dashboard > Settings > Updates, select Allow the updater (if shown), then Check now.'
}

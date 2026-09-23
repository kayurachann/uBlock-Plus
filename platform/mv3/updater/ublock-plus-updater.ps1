# uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
#Requires -Version 5.1

<#
.SYNOPSIS
uBlock Plus+ updater: native messaging host and command-line tool.
.DESCRIPTION
The installed copy lives in %LOCALAPPDATA%\uBlockPlus\Updater next to its
config.json, which install-updater.ps1 writes. It updates only the unpacked
extension folders recorded in that configuration.

The extension talks to this script through Chrome native messaging. Accepted
commands are hello, stage, apply and rollback (protocol version 1). The
extension supplies a release version only. Download URLs, folders and the
repository come from config.json. Packages must match the release checksum and
the installed identity and edition, and must be newer than the installed
version.

Before replacing files, apply copies the current folder to a backup. It
restores that backup if replacement fails, or at the next run when an apply
was interrupted. It refuses folders that other users of this PC can change,
and folders that contain junctions, symbolic links or files that no uBlock
Plus+ package listed (updater\package-files.json).
Nothing runs in the background: the script starts only when the extension or
the user calls it.
.PARAMETER NativeHost
Run as a Chrome native messaging host. Used by ublock-plus-updater.cmd.
.PARAMETER CallerOrigin
The chrome-extension:// origin Chrome passes to the host.
.PARAMETER Update
Download, verify and install the newest release (or -Version) now.
.PARAMETER Install
Populate an empty or missing extension folder with a verified release.
.PARAMETER Rollback
Restore the folder saved before the most recent update.
.PARAMETER Status
Print the configured installations as JSON.
.PARAMETER ExtensionDirectory
Select one configured installation. Required when several are configured.
.PARAMETER IncludePrerelease
Consider pre-releases when choosing the newest release. Defaults to the
configuration value.
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'NativeHost', Mandatory)]
    [switch] $NativeHost,
    [Parameter(ParameterSetName = 'NativeHost')]
    [string] $CallerOrigin = '',

    [Parameter(ParameterSetName = 'Update', Mandatory)]
    [switch] $Update,
    [Parameter(ParameterSetName = 'Install', Mandatory)]
    [switch] $Install,
    [Parameter(ParameterSetName = 'Update')]
    [Parameter(ParameterSetName = 'Install')]
    [string] $Version = '',

    [Parameter(ParameterSetName = 'Rollback', Mandatory)]
    [switch] $Rollback,

    [Parameter(ParameterSetName = 'Status')]
    [switch] $Status,

    [Parameter(ParameterSetName = 'Update')]
    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Rollback')]
    [Parameter(ParameterSetName = 'Status')]
    [string] $ExtensionDirectory = '',

    [Parameter(ParameterSetName = 'Update')]
    [Parameter(ParameterSetName = 'Install')]
    [ValidateSet('config', 'yes', 'no')]
    [string] $IncludePrerelease = 'config'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:UpdaterVersion = '1.0.0'
$script:ProtocolVersion = 1
$script:ProductShortName = 'uBlock Plus+'
$script:ExperimentalName = 'uBlock Plus+ Experimental'
$script:MaxPackageBytes = 256MB
$script:MaxExtractedBytes = 768MB
$script:MaxEntries = 20000
$script:MaxSignatures = 8
# Folder files that Windows or macOS may add to any folder. robocopy neither
# copies nor purges them in folders that the source also has.
$script:UnmanagedFileNames = @('Thumbs.db', 'desktop.ini', '.DS_Store')
# Groups that every other account of this PC belongs to (Everyone, Local,
# Console Logon, Network, Interactive, Anonymous, Authenticated Users, Users,
# Guests; Domain Users and Domain Guests are matched by pattern). If they may
# change the extension folder, another user could swap a folder for a
# junction while robocopy runs, however often the folder is checked for links.
$script:SharedSids = @('S-1-1-0', 'S-1-2-0', 'S-1-2-1', 'S-1-5-2', 'S-1-5-4', 'S-1-5-7', 'S-1-5-11',
    'S-1-5-32-545', 'S-1-5-32-546')
# WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete,
# ChangePermissions, TakeOwnership, GenericAll and GenericWrite: rights that
# let someone add, remove or replace entries of a folder.
$script:FolderWriteRights = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
# Rights on a parent folder that let someone rename one of its entries
# (DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership, GenericAll).
$script:ParentRenameRights = 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
$script:DataRoot = $PSScriptRoot
$script:Utf8 = New-Object Text.UTF8Encoding $false
$script:ProgressSink = $null
# Set when an interrupted apply was undone during this run, for reporting.
$script:Recovered = $null

class UpdaterError : Exception {
    [string] $Code
    UpdaterError([string] $code, [string] $message) : base($message) {
        $this.Code = $code
    }
}

function Stop-Updater {
    param([Parameter(Mandatory)][string] $Code, [Parameter(Mandatory)][string] $Message)
    throw [UpdaterError]::new($Code, $Message)
}

function Write-UpdaterLog {
    param([Parameter(Mandatory)][string] $Message)
    try {
        $path = Join-Path $script:DataRoot 'updater.log'
        if ( (Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 256KB ) {
            Move-Item -LiteralPath $path -Destination "$path.1" -Force
        }
        $line = '{0} {1}{2}' -f ([DateTime]::UtcNow.ToString('o')), $Message, [Environment]::NewLine
        [IO.File]::AppendAllText($path, $line, $script:Utf8)
    } catch {
        # Logging must never break the protocol.
    }
}

function Read-JsonFile {
    param([Parameter(Mandatory)][string] $Path)
    return [IO.File]::ReadAllText($Path, $script:Utf8) | ConvertFrom-Json
}

function Write-JsonFile {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)] $Value)
    $temporary = "$Path.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $script:Utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-Property {
    param($Object, [Parameter(Mandatory)][string] $Name)
    if ( $null -eq $Object ) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ( $null -eq $property ) { return $null }
    return $property.Value
}

function Test-ReleaseVersion {
    param([string] $Value)
    return $Value -cmatch '^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,3}$'
}

function Compare-ReleaseVersion {
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

function Get-AssetName {
    param([Parameter(Mandatory)][string] $Version, [Parameter(Mandatory)][string] $Edition)
    if ( $Edition -eq 'experimental' ) { return "uBlock-Plus_$Version.experimental.chromium.zip" }
    return "uBlock-Plus_$Version.chromium.zip"
}

function Get-PathKey {
    param([Parameter(Mandatory)][string] $Path)
    $bytes = $script:Utf8.GetBytes($Path.ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return (-join ($hash[0..7] | ForEach-Object { $_.ToString('x2') }))
}

function Test-AllowedUrl {
    param([string] $Value)
    if ( [string]::IsNullOrEmpty($Value) ) { return $false }
    $uri = $null
    if ( [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -eq $false ) { return $false }
    if ( $uri.Scheme -eq 'https' ) { return $true }
    # Plain HTTP is accepted only for loopback test servers.
    return $uri.Scheme -eq 'http' -and ($uri.Host -eq '127.0.0.1' -or $uri.Host -eq 'localhost')
}

function Get-UpdaterConfig {
    $path = Join-Path $script:DataRoot 'config.json'
    if ( (Test-Path -LiteralPath $path -PathType Leaf) -eq $false ) {
        Stop-Updater 'not-installed' 'The updater is not installed. Run updater\install-updater.cmd from the extension folder.'
    }
    $config = Read-JsonFile $path
    if ( (Get-Property $config 'schemaVersion') -ne 1 ) {
        Stop-Updater 'invalid-config' 'Unsupported updater configuration version.'
    }
    $repository = [string] (Get-Property $config 'repository')
    if ( $repository -notmatch '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' ) {
        Stop-Updater 'invalid-config' 'The configured repository is invalid.'
    }
    foreach ( $name in 'releaseBaseUrl', 'apiBaseUrl' ) {
        if ( (Test-AllowedUrl ([string] (Get-Property $config $name))) -eq $false ) {
            Stop-Updater 'invalid-config' "The configured $name must use HTTPS."
        }
    }
    $installations = @(Get-Property $config 'installations')
    foreach ( $installation in $installations ) {
        $edition = Get-Property $installation 'edition'
        if ( $edition -ne 'standard' -and $edition -ne 'experimental' ) {
            Stop-Updater 'invalid-config' 'An installation has an unknown edition.'
        }
        $ids = @(Get-Property $installation 'extensionIds')
        if ( $ids.Count -eq 0 -or @($ids | Where-Object { $_ -cnotmatch '^[a-p]{32}$' }).Count -ne 0 ) {
            Stop-Updater 'invalid-config' 'An installation has an invalid extension ID.'
        }
        $directory = [string] (Get-Property $installation 'extensionDir')
        if ( [IO.Path]::IsPathRooted($directory) -eq $false ) {
            Stop-Updater 'invalid-config' 'An installation folder must be an absolute path.'
        }
    }
    return $config
}

function Resolve-Installation {
    param($Config, [string] $Origin = '', [string] $Directory = '')
    $installations = @(Get-Property $Config 'installations')
    if ( $Origin -ne '' ) {
        if ( $Origin -cnotmatch '^chrome-extension://([a-p]{32})/$' ) {
            Stop-Updater 'forbidden-origin' 'The caller is not a Chromium extension.'
        }
        $id = $Matches[1]
        $matching = @($installations | Where-Object { @(Get-Property $_ 'extensionIds') -ccontains $id })
        if ( $matching.Count -eq 1 ) { return $matching[0] }
        if ( $matching.Count -gt 1 ) {
            # Experimental builds share one ID. Never guess which folder the
            # browser loaded.
            Stop-Updater 'ambiguous-installation' "Extension $id is registered for several folders. Run updater\install-updater.cmd -Replace from the folder the browser loads."
        }
        Stop-Updater 'forbidden-origin' "Extension $id is not registered with this updater."
    }
    if ( $Directory -ne '' ) {
        $wanted = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
        foreach ( $installation in $installations ) {
            if ( [string]::Equals($installation.extensionDir.TrimEnd('\'), $wanted, [StringComparison]::OrdinalIgnoreCase) ) {
                return $installation
            }
        }
        Stop-Updater 'unknown-installation' "No installation is configured for $wanted."
    }
    if ( $installations.Count -eq 1 ) { return $installations[0] }
    if ( $installations.Count -eq 0 ) { Stop-Updater 'not-installed' 'No extension folder is configured.' }
    Stop-Updater 'ambiguous-installation' 'Several installations are configured; pass -ExtensionDirectory.'
}

function Get-PackageIdentity {
    param([Parameter(Mandatory)][string] $Directory)
    $manifestPath = Join-Path $Directory 'manifest.json'
    if ( (Test-Path -LiteralPath $manifestPath -PathType Leaf) -eq $false ) { return $null }
    try {
        $manifest = Read-JsonFile $manifestPath
    } catch {
        return $null
    }
    $experimental = Test-Path -LiteralPath (Join-Path $Directory 'experimental-webrequest.json') -PathType Leaf
    return [pscustomobject] @{
        ManifestVersion = Get-Property $manifest 'manifest_version'
        Version = [string] (Get-Property $manifest 'version')
        Name = [string] (Get-Property $manifest 'name')
        ShortName = [string] (Get-Property $manifest 'short_name')
        Key = [string] (Get-Property $manifest 'key')
        Edition = if ( $experimental ) { 'experimental' } else { 'standard' }
    }
}

function Assert-PackageIdentity {
    param($Identity, [Parameter(Mandatory)][string] $Edition, [string] $Context = 'package')
    if ( $null -eq $Identity -or $Identity.ManifestVersion -ne 3 -or $Identity.ShortName -cne $script:ProductShortName ) {
        Stop-Updater 'identity-mismatch' "The $Context is not a uBlock Plus+ Manifest V3 extension."
    }
    if ( $Identity.Edition -ne $Edition ) {
        Stop-Updater 'identity-mismatch' "The $Context edition ($($Identity.Edition)) does not match $Edition."
    }
    if ( $Edition -eq 'experimental' -and $Identity.Name -cne $script:ExperimentalName ) {
        Stop-Updater 'identity-mismatch' "The $Context does not use the experimental identity."
    }
    if ( (Test-ReleaseVersion $Identity.Version) -eq $false ) {
        Stop-Updater 'identity-mismatch' "The $Context has an invalid version."
    }
}

function Test-LinkItem {
    param([Parameter(Mandatory)][IO.FileSystemInfo] $Item)
    # Junctions and symbolic links redirect a copy or a purge to another
    # place. Other reparse points, such as OneDrive placeholders, are ordinary
    # files and folders. An entry whose link type cannot be read counts as a
    # link.
    if ( ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 ) { return $false }
    try {
        $linkType = [string] (Get-Item -LiteralPath $Item.FullName -Force).LinkType
    } catch {
        return $true
    }
    return $linkType -eq 'Junction' -or $linkType -eq 'SymbolicLink'
}

function Get-SharedRights {
    param([Parameter(Mandatory)][string] $Path)
    # The rights that groups of every account of this PC hold on $Path itself.
    # Inherit-only entries apply to new children only, which then carry them.
    try {
        $rules = (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    } catch {
        Stop-Updater 'unsafe-extension-dir' "Could not read the permissions of $Path"
    }
    $rights = 0
    foreach ( $rule in $rules ) {
        if ( $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 ) { continue }
        $sid = $rule.IdentityReference.Value
        if ( $script:SharedSids -contains $sid -or $sid -match '^S-1-5-21-\d+-\d+-\d+-51[34]$' ) {
            $rights = $rights -bor [int] $rule.FileSystemRights
        }
    }
    return $rights
}

function Assert-SafeExtensionDirectory {
    param([Parameter(Mandatory)][string] $Directory)
    $full = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    $segments = @($full.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries))
    if ( $segments.Count -lt 1 -or $full.StartsWith('\\') ) {
        Stop-Updater 'unsafe-extension-dir' "Refusing to manage a drive root or network share root: $full"
    }
    $protected = @(
        $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData,
        $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP,
        [IO.Path]::GetDirectoryName($env:USERPROFILE),
        (Join-Path $env:LOCALAPPDATA 'uBlockPlus'),
        [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'),
        (Join-Path $env:USERPROFILE 'Downloads')
    ) | Where-Object { -not [string]::IsNullOrEmpty($_) } | ForEach-Object { $_.TrimEnd('\') }
    foreach ( $candidate in $protected ) {
        if ( [string]::Equals($candidate, $full, [StringComparison]::OrdinalIgnoreCase) ) {
            Stop-Updater 'unsafe-extension-dir' "Refusing to manage a system or profile folder: $full"
        }
    }
    $data = $script:DataRoot.TrimEnd('\')
    if ( $data.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith("$data\", [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($data, $full, [StringComparison]::OrdinalIgnoreCase) ) {
        Stop-Updater 'unsafe-extension-dir' 'The extension folder must not contain or be inside the updater folder.'
    }
    $probe = $full
    while ( $probe -ne '' -and $null -ne $probe ) {
        $parent = [IO.Path]::GetDirectoryName($probe)
        if ( Test-Path -LiteralPath $probe ) {
            if ( Test-LinkItem (Get-Item -LiteralPath $probe -Force) ) {
                Stop-Updater 'unsafe-extension-dir' "The extension folder must not use junctions or symbolic links: $probe"
            }
            # Links are checked at fixed moments, so no other user may be
            # able to rename a folder on the way (Delete on it, or rights on
            # its parent) and put a link in its place. A volume root cannot
            # be renamed.
            $mask = $script:ParentRenameRights
            if ( $null -ne $parent ) { $mask = $mask -bor 0x10000 }
            if ( $probe -ne $full -and ((Get-SharedRights $probe) -band $mask) -ne 0 ) {
                Stop-Updater 'unsafe-extension-dir' "Other users of this PC can rename or replace $probe. Keep the extension in a folder that only you can change, for example $env:LOCALAPPDATA\uBlockPlus\Extension."
            }
        }
        if ( $parent -eq $probe ) { break }
        $probe = $parent
    }
    # The folder and every folder in it: no other user may add, remove or
    # replace entries.
    if ( Test-Path -LiteralPath $full -PathType Container ) { $null = Get-TreeFiles $full -Private }
    return $full
}

function Get-TreeFiles {
    param([Parameter(Mandatory)][string] $Directory, [string] $Label = 'extension folder', [switch] $Private)
    # Every file below $Directory as a relative path with forward slashes.
    # Walks one level at a time and never enters a link: robocopy /MIR purges
    # and writes through junctions and symbolic links in the destination, even
    # with /XJ, so any link below the root is refused. With -Private, also
    # refuses folders that other users of this PC may change.
    $files = New-Object Collections.Generic.List[string]
    $root = New-Object IO.DirectoryInfo $Directory
    if ( $root.Exists -eq $false ) { return ,$files }
    $pending = New-Object Collections.Generic.Queue[object]
    $pending.Enqueue(@($root, ''))
    while ( $pending.Count -ne 0 ) {
        $current = $pending.Dequeue()
        if ( $Private -and ((Get-SharedRights $current[0].FullName) -band $script:FolderWriteRights) -ne 0 ) {
            Stop-Updater 'unsafe-extension-dir' "Other users of this PC can change $($current[0].FullName). Keep the extension in a folder that only you can change, for example $env:LOCALAPPDATA\uBlockPlus\Extension."
        }
        foreach ( $item in $current[0].GetFileSystemInfos() ) {
            $relative = $current[1] + $item.Name
            if ( Test-LinkItem $item ) {
                Stop-Updater 'unsafe-extension-dir' "The $Label must not contain junctions or symbolic links: $relative"
            }
            if ( $item -is [IO.DirectoryInfo] ) {
                $pending.Enqueue(@($item, "$relative/"))
            } else {
                $files.Add($relative)
            }
        }
    }
    return ,$files
}

function Get-TreeDirectories {
    param([Parameter(Mandatory)][AllowEmptyCollection()] $Files)
    # The folders that hold $Files (relative paths), the root ('') included.
    $directories = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $directories.Add('') | Out-Null
    foreach ( $file in $Files ) {
        $parts = $file.Split('/')
        for ( $i = 1; $i -lt $parts.Count; $i++ ) {
            $directories.Add(($parts[0..($i - 1)] -join '/')) | Out-Null
        }
    }
    return ,$directories
}

function Test-UnmanagedPath {
    param([Parameter(Mandatory)][string] $RelativePath, [Collections.Generic.HashSet[string]] $SourceDirectories)
    # Whether robocopy leaves this file of the destination alone: files in
    # _metadata folders (Chrome keeps indexed rulesets in the top one) and
    # Windows or macOS folder files (/XD and /XF), but only in a folder that
    # the source also has. A folder that the source lacks is purged with
    # everything in it.
    $parts = $RelativePath.Split('/')
    for ( $i = 0; $i -lt $parts.Count; $i++ ) {
        $last = $i -eq $parts.Count - 1
        if ( ($last -and $script:UnmanagedFileNames -contains $parts[$i]) -or (-not $last -and $parts[$i] -eq '_metadata') ) {
            $parent = if ( $i -eq 0 ) { '' } else { $parts[0..($i - 1)] -join '/' }
            return $SourceDirectories.Contains($parent)
        }
    }
    return $false
}

function Get-PackageFileList {
    param([Parameter(Mandatory)][string] $Directory)
    # The files a package declared in updater\package-files.json, as a
    # case-insensitive set, or $null when the list is missing or malformed.
    $path = Join-Path $Directory 'updater\package-files.json'
    if ( (Test-Path -LiteralPath $path -PathType Leaf) -eq $false ) { return $null }
    try {
        # Assigned first: Windows PowerShell returns a JSON array as one object.
        $document = Read-JsonFile $path
    } catch {
        return $null
    }
    $set = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    if ( $null -eq $document ) { return ,$set }
    foreach ( $entry in @($document) ) {
        if ( $entry -isnot [string] -or $entry -eq '' ) { return $null }
        $set.Add($entry) | Out-Null
    }
    return ,$set
}

function Assert-NoUnexpectedFiles {
    param(
        [Parameter(Mandatory)][string] $Directory,
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string[]] $Listed,
        [string[]] $Trees = @(),
        [string] $SourceLabel = 'package'
    )
    # robocopy /MIR deletes every file of $Directory that $Source lacks. Allow
    # that only for files that a uBlock Plus+ package listed (the
    # updater\package-files.json of each $Listed folder) or holds (each $Trees
    # folder), so that user files are never deleted.
    $sourceFiles = Get-TreeFiles $Source $SourceLabel
    $keep = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ( $file in $sourceFiles ) { $keep.Add($file) | Out-Null }
    $sourceDirectories = Get-TreeDirectories $sourceFiles
    $extras = @((Get-TreeFiles $Directory) | Where-Object {
        -not $keep.Contains($_) -and -not (Test-UnmanagedPath $_ $sourceDirectories)
    })
    if ( $extras.Count -eq 0 ) { return }
    $known = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ( $folder in $Listed ) {
        $list = Get-PackageFileList $folder
        if ( $null -ne $list ) { $known.UnionWith($list) }
    }
    foreach ( $folder in $Trees ) {
        foreach ( $file in (Get-TreeFiles $folder 'staged package') ) { $known.Add($file) | Out-Null }
    }
    $unexpected = @($extras | Where-Object { -not $known.Contains($_) } | Sort-Object)
    if ( $unexpected.Count -eq 0 ) { return }
    $names = ($unexpected | Select-Object -First 10) -join ', '
    if ( $unexpected.Count -gt 10 ) { $names += " and $($unexpected.Count - 10) more" }
    Stop-Updater 'unexpected-files' "The extension folder contains files that are not part of uBlock Plus+: $names. Move them out of the extension folder, then try again. Nothing was changed."
}

function Get-InstallationPaths {
    param([Parameter(Mandatory)] $Installation)
    $key = Get-PathKey ([IO.Path]::GetFullPath($Installation.extensionDir).TrimEnd('\'))
    return [pscustomobject] @{
        Staging = Join-Path $script:DataRoot "staging\$key"
        Backup = Join-Path $script:DataRoot "backup\$key"
        State = Join-Path $script:DataRoot "state-$key.json"
    }
}

function Send-Progress {
    param([Parameter(Mandatory)][hashtable] $Details)
    if ( $null -ne $script:ProgressSink ) { & $script:ProgressSink $Details }
}

function New-HttpClient {
    param([TimeSpan] $Timeout)
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
        [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    $client = New-Object Net.Http.HttpClient $handler
    $client.Timeout = $Timeout
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("uBlock-Plus-Updater/$script:UpdaterVersion")
    return $client
}

function Invoke-Download {
    param(
        [Parameter(Mandatory)][string] $Url,
        [Parameter(Mandatory)][string] $Destination,
        [Parameter(Mandatory)][long] $MaxBytes,
        [switch] $ReportProgress
    )
    if ( (Test-AllowedUrl $Url) -eq $false ) { Stop-Updater 'download-failed' "Refusing to download from $Url" }
    $client = New-HttpClient ([TimeSpan]::FromMinutes(15))
    $temporary = "$Destination.partial"
    try {
        $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ( $response.IsSuccessStatusCode -eq $false ) {
            Stop-Updater 'download-failed' ("Download failed with HTTP {0}: {1}" -f [int] $response.StatusCode, $Url)
        }
        if ( (Test-AllowedUrl $response.RequestMessage.RequestUri.AbsoluteUri) -eq $false ) {
            Stop-Updater 'download-failed' 'The download was redirected to an insecure location.'
        }
        $total = $response.Content.Headers.ContentLength
        if ( $null -ne $total -and $total -gt $MaxBytes ) {
            Stop-Updater 'package-too-large' "The download is larger than $MaxBytes bytes."
        }
        $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $target = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $buffer = New-Object byte[] 262144
            [long] $received = 0
            [long] $reported = 0
            while ( ($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0 ) {
                $received += $read
                if ( $received -gt $MaxBytes ) {
                    Stop-Updater 'package-too-large' "The download is larger than $MaxBytes bytes."
                }
                $target.Write($buffer, 0, $read)
                if ( $ReportProgress -and $received - $reported -ge 1MB ) {
                    $reported = $received
                    Send-Progress @{ phase = 'download'; received = $received; total = $total }
                }
            }
        } finally {
            $target.Dispose()
            $source.Dispose()
        }
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    } catch [UpdaterError] {
        throw
    } catch {
        Stop-Updater 'download-failed' ("Download failed: {0}" -f $_.Exception.GetBaseException().Message)
    } finally {
        $client.Dispose()
        if ( Test-Path -LiteralPath $temporary ) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-ExpectedChecksum {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $AssetName)
    # "<sha256>  <asset name>", as written by make-mv3 and sha256sum. The name
    # binds the checksum to this asset.
    $text = [IO.File]::ReadAllText($Path, $script:Utf8).Trim()
    if ( $text -notmatch '^([0-9A-Fa-f]{64})\s+\*?(\S+)$' ) {
        Stop-Updater 'checksum-invalid' 'The release checksum file is malformed.'
    }
    if ( $Matches[2] -cne $AssetName ) {
        Stop-Updater 'checksum-invalid' 'The release checksum file names a different package.'
    }
    return $Matches[1].ToLowerInvariant()
}

function ConvertFrom-Base64Url {
    param([Parameter(Mandatory)][string] $Value)
    $text = $Value.Replace('-', '+').Replace('_', '/')
    switch ( $text.Length % 4 ) {
        2 { $text += '==' }
        3 { $text += '=' }
    }
    return [Convert]::FromBase64String($text)
}

# Release signing keys (RSA, JWK form) pinned when the updater was installed,
# or adopted later from a package whose signature verified. An empty set means
# releases are not signed yet; then only the published checksum is enforced.
function Get-TrustedKeys {
    param([string] $Path = (Join-Path $script:DataRoot 'release-signing-keys.json'))
    if ( (Test-Path -LiteralPath $Path -PathType Leaf) -eq $false ) { return ,@() }
    $keys = ConvertFrom-KeyDocument (Read-JsonFile $Path)
    return ,$keys
}

function Get-KeyGeneration {
    param($Document)
    # tools/release-signing.mjs raises a key set's generation whenever it adds
    # or retires a key, so that a newer set can be told from an older one. A
    # set without one is generation 0.
    $generation = Get-Property $Document 'generation'
    if ( $null -eq $generation ) { return 0 }
    if ( ($generation -isnot [int] -and $generation -isnot [long]) -or $generation -lt 0 ) {
        Stop-Updater 'invalid-config' 'The release key set generation is malformed.'
    }
    return [long] $generation
}

function ConvertFrom-KeyDocument {
    param($Document)
    if ( (Get-Property $Document 'schemaVersion') -ne 1 ) {
        Stop-Updater 'invalid-config' 'Unsupported release key file.'
    }
    $null = Get-KeyGeneration $Document
    $keys = @()
    foreach ( $key in @(Get-Property $Document 'keys') ) {
        if ( $null -eq $key ) { continue }
        $id = [string] (Get-Property $key 'id')
        if ( $id -cnotmatch '^[A-Za-z0-9._-]{1,64}$' -or (Get-Property $key 'kty') -cne 'RSA' ) {
            Stop-Updater 'invalid-config' 'A release signing key is malformed.'
        }
        try {
            $modulus = ConvertFrom-Base64Url ([string] (Get-Property $key 'n'))
            $exponent = ConvertFrom-Base64Url ([string] (Get-Property $key 'e'))
        } catch {
            Stop-Updater 'invalid-config' 'A release signing key is malformed.'
        }
        if ( $modulus.Length -lt 256 -or $exponent.Length -lt 1 -or $exponent.Length -gt 8 ) {
            Stop-Updater 'invalid-config' 'A release signing key is too weak or malformed.'
        }
        $keys += [pscustomobject] @{ Id = $id; Modulus = $modulus; Exponent = $exponent }
    }
    return ,$keys
}

# RSA PKCS#1 v1.5 over the package's SHA-256 digest. Returns the ID of the key
# that verified the signature, or $null.
function Test-ReleaseSignature {
    param([Parameter(Mandatory)][byte[]] $Hash, [Parameter(Mandatory)][byte[]] $Signature, [Parameter(Mandatory)] $Keys)
    foreach ( $key in $Keys ) {
        $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
        try {
            $parameters = New-Object Security.Cryptography.RSAParameters
            $parameters.Modulus = $key.Modulus
            $parameters.Exponent = $key.Exponent
            $rsa.ImportParameters($parameters)
            if ( $rsa.VerifyHash($Hash, '2.16.840.1.101.3.4.2.1', $Signature) ) { return $key.Id }
        } catch {
            # A malformed signature simply does not verify.
        } finally {
            $rsa.Dispose()
        }
    }
    return $null
}

function Get-ReleaseSignatures {
    param([Parameter(Mandatory)][string] $Path)
    # One base64 signature per line, so that releases can carry the old and
    # the new key's signature while keys rotate. Blank lines are ignored;
    # lines that do not decode simply do not verify.
    $lines = @([IO.File]::ReadAllText($Path, $script:Utf8) -split '\r?\n' |
        ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ( $lines.Count -gt $script:MaxSignatures ) { return ,@() }
    $signatures = @()
    foreach ( $line in $lines ) {
        try {
            $bytes = [Convert]::FromBase64String($line)
        } catch {
            continue
        }
        if ( $bytes.Length -ne 0 ) { $signatures += ,$bytes }
    }
    return ,$signatures
}

function Expand-VerifiedPackage {
    param([Parameter(Mandatory)][string] $Archive, [Parameter(Mandatory)][string] $Destination)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ( Test-Path -LiteralPath $Destination ) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    $root = [IO.Directory]::CreateDirectory($Destination).FullName.TrimEnd('\') + '\'
    try {
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    } catch {
        Stop-Updater 'package-invalid' ("The package is not a valid ZIP archive: {0}" -f $_.Exception.GetBaseException().Message)
    }
    try {
        # The central directory is read on first access. PowerShell turns an
        # exception in the Entries property getter into $null, so call the
        # getter itself.
        try {
            $entries = $zip.get_Entries()
        } catch {
            Stop-Updater 'package-invalid' ("The package is not a valid ZIP archive: {0}" -f $_.Exception.GetBaseException().Message)
        }
        if ( $entries.Count -gt $script:MaxEntries ) {
            Stop-Updater 'package-invalid' 'The package contains too many files.'
        }
        [long] $declared = 0
        foreach ( $entry in $entries ) {
            $declared += $entry.Length
        }
        if ( $declared -gt $script:MaxExtractedBytes ) {
            Stop-Updater 'package-invalid' 'The package expands beyond the allowed size.'
        }
        $buffer = New-Object byte[] 262144
        [long] $expanded = 0
        foreach ( $entry in $entries ) {
            $name = $entry.FullName
            if ( $name -eq '' -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or
                @($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -ne 0 ) {
                Stop-Updater 'package-invalid' "The package contains an unsafe path: $name"
            }
            $target = [IO.Path]::GetFullPath((Join-Path $root $name.Replace('/', '\')))
            if ( $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -eq $false ) {
                Stop-Updater 'package-invalid' "The package contains an unsafe path: $name"
            }
            if ( $name.EndsWith('/') ) {
                [IO.Directory]::CreateDirectory($target) | Out-Null
                continue
            }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            if ( [IO.File]::Exists($target) ) {
                Stop-Updater 'package-invalid' "The package contains $name twice."
            }
            # .NET Framework does not enforce an entry's declared size, so
            # count the bytes actually written.
            $source = $null
            $output = $null
            try {
                $source = $entry.Open()
                $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                [long] $written = 0
                while ( ($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0 ) {
                    $written += $read
                    $expanded += $read
                    if ( $written -gt $entry.Length -or $expanded -gt $script:MaxExtractedBytes ) {
                        Stop-Updater 'package-invalid' "The package entry $name expands beyond its declared size."
                    }
                    $output.Write($buffer, 0, $read)
                }
            } catch {
                if ( $null -ne $output ) { $output.Dispose(); $output = $null }
                Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
                if ( $_.Exception -is [UpdaterError] ) { throw }
                Stop-Updater 'package-invalid' ("The package entry $name could not be extracted: {0}" -f $_.Exception.GetBaseException().Message)
            } finally {
                if ( $null -ne $output ) { $output.Dispose() }
                if ( $null -ne $source ) { $source.Dispose() }
            }
        }
    } finally {
        $zip.Dispose()
    }
    Set-FreshTimestamp $Destination
}

function Set-FreshTimestamp {
    param([Parameter(Mandatory)][string] $Directory)
    # Packages can carry fixed or reused timestamps, and robocopy skips files
    # whose size and times match. One fresh timestamp for every source file
    # guarantees that each file is copied.
    $now = [DateTime]::UtcNow
    foreach ( $file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force ) {
        $file.LastWriteTimeUtc = $now
    }
}

function Restore-Backup {
    param([Parameter(Mandatory)][string] $Backup, [Parameter(Mandatory)][string] $Directory)
    # Throws unsafe-extension-dir when either folder contains a link.
    $null = Get-TreeFiles $Backup 'backup folder'
    $null = Get-TreeFiles $Directory
    Set-FreshTimestamp $Backup
    return Copy-ExtensionTree $Backup $Directory
}

function Copy-ExtensionTree {
    param([Parameter(Mandatory)][string] $Source, [Parameter(Mandatory)][string] $Destination)
    # manifest.json is copied last: until then, an interrupted copy still
    # declares the version it started from.
    $manifest = Join-Path $Source 'manifest.json'
    if ( (Invoke-Robocopy $Source $Destination $manifest) -eq $false ) { return $false }
    try {
        Copy-Item -LiteralPath $manifest -Destination (Join-Path $Destination 'manifest.json') -Force
    } catch {
        Write-UpdaterLog "Copying $manifest failed: $($_.Exception.Message)"
        return $false
    }
    return $true
}

function Invoke-Robocopy {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination,
        [Parameter(Mandatory)][string] $ExcludedFile
    )
    $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $robocopy
    # /MIR makes the destination an exact copy. /IS /IT copy files even when
    # size and timestamp match. /XJ skips links in the source only, so callers
    # refuse folders that contain any. Chrome keeps indexed DNR rulesets in
    # _metadata inside an unpacked extension and rebuilds them on reload, so
    # that folder is neither copied nor purged, like the folder files that
    # Windows or macOS add. $ExcludedFile is a full source path.
    $unmanaged = ($script:UnmanagedFileNames | ForEach-Object { '"{0}"' -f $_ }) -join ' '
    $info.Arguments = ('"{0}" "{1}" /MIR /IS /IT /XJ /XD _metadata /XF "{2}" {3} /R:5 /W:1 /NP /NFL /NDL /NJH /NJS' -f
        $Source.TrimEnd('\'), $Destination.TrimEnd('\'), $ExcludedFile, $unmanaged)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $code = $process.ExitCode
    if ( $code -ge 8 ) {
        Write-UpdaterLog ("robocopy {0} -> {1} failed ({2}): {3} {4}" -f $Source, $Destination, $code, $stdout.Result.Trim(), $stderr.Result.Trim())
        return $false
    }
    return $true
}

function Enter-UpdaterLock {
    $path = Join-Path $script:DataRoot 'updater.lock'
    try {
        return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        Stop-Updater 'update-busy' 'Another update is already running.'
    }
}

function Enter-IdleLock {
    # The updater lock, or $null while another update holds it.
    try {
        return Enter-UpdaterLock
    } catch {
        return $null
    }
}

function Read-InstallationState {
    param([Parameter(Mandatory)] $Paths)
    if ( Test-Path -LiteralPath $Paths.State -PathType Leaf ) {
        try { return Read-JsonFile $Paths.State } catch { Write-UpdaterLog "Ignoring an unreadable $($Paths.State)" }
    }
    return $null
}

function Write-InstallationState {
    param([Parameter(Mandatory)] $Paths, $LastApplied = $null, $Applying = $null)
    # applying marks a replacement in progress; it is cleared once the folder
    # verifies, or once the backup is back in place.
    $state = [ordered] @{ lastApplied = $LastApplied }
    if ( $null -ne $Applying ) { $state.applying = $Applying }
    Write-JsonFile $Paths.State $state
}

function Undo-Replacement {
    param([Parameter(Mandatory)] $Paths, [Parameter(Mandatory)][string] $Directory, [Parameter(Mandatory)][string] $Version, $LastApplied = $null)
    # Puts the backup of $Version back after a failed or interrupted apply.
    # Returns whether the folder verifies as $Version again. Otherwise the
    # apply marker stays, so that the next run tries again.
    try {
        if ( (Restore-Backup $Paths.Backup $Directory) -eq $false ) { return $false }
    } catch {
        Write-UpdaterLog "Restoring the backup failed: $($_.Exception.Message)"
        return $false
    }
    $identity = Get-PackageIdentity $Directory
    if ( $null -eq $identity -or $identity.Version -cne $Version ) { return $false }
    Write-InstallationState $Paths $LastApplied
    return $true
}

function Get-RestoreOutcome {
    param([bool] $Restored)
    if ( $Restored ) { return 'the previous version was restored' }
    return 'the previous version was NOT fully restored - run the updater with -Rollback'
}

function Repair-InterruptedApply {
    param([Parameter(Mandatory)] $Installation)
    # Call with the updater lock held. An apply that stopped midway (logoff,
    # crash, a killed host) left its marker and a partly replaced folder:
    # restore the backup it made before anything else.
    $paths = Get-InstallationPaths $Installation
    $state = Read-InstallationState $paths
    $applying = Get-Property $state 'applying'
    if ( $null -eq $applying ) { return }
    $from = [string] (Get-Property $applying 'from')
    $to = [string] (Get-Property $applying 'to')
    $directory = Assert-SafeExtensionDirectory $Installation.extensionDir
    $backup = Get-PackageIdentity $paths.Backup
    if ( $null -eq $backup -or $backup.Version -cne $from ) {
        Stop-Updater 'rollback-failed' "The update to $to was interrupted and no backup of version $from is left. Run the updater with -Rollback."
    }
    # The folder mixes both packages; anything else was added since.
    Assert-NoUnexpectedInterruptedFiles $paths $directory
    if ( (Undo-Replacement $paths $directory $from (Get-Property $state 'lastApplied')) -eq $false ) {
        Stop-Updater 'rollback-failed' "The update to $to was interrupted and version $from could not be restored. Run the updater with -Rollback."
    }
    Write-UpdaterLog "Restored $from in $directory after the interrupted update to $to"
    $script:Recovered = [ordered] @{ restored = $from; interrupted = $to }
}

function Assert-NoUnexpectedInterruptedFiles {
    param([Parameter(Mandatory)] $Paths, [Parameter(Mandatory)][string] $Directory)
    # Before the backup replaces a folder that an interrupted apply left
    # half replaced: the files of both packages may go, nothing else. The
    # staged package stays until an apply succeeds.
    Assert-NoUnexpectedFiles $Directory $Paths.Backup @($Paths.Backup, $Directory) @(Join-Path $Paths.Staging 'package') 'backup folder'
}

function Invoke-PendingRepair {
    param([Parameter(Mandatory)] $Installation)
    # Undoes an interrupted apply unless an update is running. Takes the lock
    # only when there is something to undo, so that a status request never
    # makes an update that starts at the same moment fail with update-busy.
    if ( $null -eq (Get-Property (Read-InstallationState (Get-InstallationPaths $Installation)) 'applying') ) { return }
    $lock = Enter-IdleLock
    if ( $null -eq $lock ) { return }
    try {
        Repair-InterruptedApply $Installation
    } finally {
        $lock.Dispose()
    }
}

function Get-InstallationStatus {
    param([Parameter(Mandatory)] $Installation)
    $paths = Get-InstallationPaths $Installation
    $installed = Get-PackageIdentity $Installation.extensionDir
    $backup = Get-PackageIdentity $paths.Backup
    $staged = $null
    $marker = Join-Path $paths.Staging 'staged.json'
    if ( Test-Path -LiteralPath $marker -PathType Leaf ) {
        try { $staged = [string] (Get-Property (Read-JsonFile $marker) 'version') } catch { $staged = $null }
    }
    $state = Read-InstallationState $paths
    return [ordered] @{
        extensionDir = $Installation.extensionDir
        edition = $Installation.edition
        installedVersion = if ( $null -ne $installed ) { $installed.Version } else { $null }
        stagedVersion = $staged
        backupVersion = if ( $null -ne $backup ) { $backup.Version } else { $null }
        lastApplied = Get-Property $state 'lastApplied'
    }
}

function Invoke-Stage {
    param([Parameter(Mandatory)] $Config, [Parameter(Mandatory)] $Installation, [Parameter(Mandatory)][string] $TargetVersion, [switch] $AllowEmptyTarget)
    if ( (Test-ReleaseVersion $TargetVersion) -eq $false ) { Stop-Updater 'invalid-version' 'The requested version is invalid.' }
    Repair-InterruptedApply $Installation
    $edition = $Installation.edition
    $installed = Get-PackageIdentity $Installation.extensionDir
    if ( $null -ne $installed ) {
        Assert-PackageIdentity $installed $edition 'installed extension'
        if ( (Compare-ReleaseVersion $TargetVersion $installed.Version) -le 0 ) {
            Stop-Updater 'not-newer' "Version $TargetVersion is not newer than the installed $($installed.Version)."
        }
    } elseif ( -not $AllowEmptyTarget ) {
        Stop-Updater 'identity-mismatch' 'The configured folder does not contain uBlock Plus+.'
    }
    $paths = Get-InstallationPaths $Installation
    $marker = Join-Path $paths.Staging 'staged.json'
    $content = Join-Path $paths.Staging 'package'
    $keys = Get-TrustedKeys
    if ( Test-Path -LiteralPath $marker -PathType Leaf ) {
        $previous = Read-JsonFile $marker
        $identity = Get-PackageIdentity $content
        if ( (Get-Property $previous 'version') -ceq $TargetVersion -and $null -ne $identity -and $identity.Version -ceq $TargetVersion -and
            ($keys.Count -eq 0 -or -not [string]::IsNullOrEmpty([string] (Get-Property $previous 'signedBy'))) ) {
            return [ordered] @{ version = $TargetVersion; sha256 = Get-Property $previous 'sha256'; reused = $true }
        }
    }
    if ( Test-Path -LiteralPath $paths.Staging ) { Remove-Item -LiteralPath $paths.Staging -Recurse -Force }
    New-Item -ItemType Directory -Path $paths.Staging -Force | Out-Null
    $asset = Get-AssetName $TargetVersion $edition
    $base = "{0}/v{1}" -f $Config.releaseBaseUrl.TrimEnd('/'), $TargetVersion
    $archive = Join-Path $paths.Staging $asset
    $checksumFile = "$archive.sha256"
    Send-Progress @{ phase = 'checksum' }
    Invoke-Download "$base/$asset.sha256" $checksumFile 4KB
    $expected = Get-ExpectedChecksum $checksumFile $asset
    Send-Progress @{ phase = 'download'; received = 0 }
    Invoke-Download "$base/$asset" $archive $script:MaxPackageBytes -ReportProgress
    Send-Progress @{ phase = 'verify' }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ( $actual -cne $expected ) {
        Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
        Stop-Updater 'checksum-mismatch' 'The downloaded package does not match the release checksum.'
    }
    $signedBy = $null
    if ( $keys.Count -gt 0 ) {
        # A checksum published next to the package only proves integrity.
        # With pinned keys, authenticity comes from the release signature.
        Send-Progress @{ phase = 'signature' }
        $signatureFile = "$archive.sig"
        try {
            Invoke-Download "$base/$asset.sig" $signatureFile 8KB
        } catch [UpdaterError] {
            Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
            # Only a missing file means an unsigned release; other download
            # errors stay download-failed.
            if ( $_.Exception.Message -match '\bHTTP 404\b' ) {
                Stop-Updater 'signature-missing' 'This release has no valid signature from a trusted release key.'
            }
            if ( $_.Exception.Code -eq 'package-too-large' ) {
                Stop-Updater 'signature-invalid' 'The release signature file is too large.'
            }
            throw
        }
        $digest = [byte[]] ($actual -split '(..)' | Where-Object { $_ -ne '' } | ForEach-Object { [Convert]::ToByte($_, 16) })
        foreach ( $signature in (Get-ReleaseSignatures $signatureFile) ) {
            $signedBy = Test-ReleaseSignature $digest $signature $keys
            if ( $null -ne $signedBy ) { break }
        }
        if ( $null -eq $signedBy ) {
            Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
            Stop-Updater 'signature-invalid' 'The package signature does not match a trusted release key.'
        }
        Remove-Item -LiteralPath $signatureFile -Force
    }
    Send-Progress @{ phase = 'extract' }
    try {
        Expand-VerifiedPackage $archive $content
    } catch {
        Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    Remove-Item -LiteralPath $archive, $checksumFile -Force
    $identity = Get-PackageIdentity $content
    Assert-PackageIdentity $identity $edition 'downloaded package'
    if ( $identity.Version -cne $TargetVersion ) {
        Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
        Stop-Updater 'identity-mismatch' "The package declares version $($identity.Version), not $TargetVersion."
    }
    if ( $null -ne $installed -and $identity.Key -cne $installed.Key ) {
        Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
        Stop-Updater 'identity-mismatch' 'The package would change the extension ID.'
    }
    Write-JsonFile $marker ([ordered] @{
        version = $TargetVersion; sha256 = $expected; asset = $asset; signedBy = $signedBy
        stagedAt = [DateTime]::UtcNow.ToString('o')
    })
    Write-UpdaterLog "Staged $asset for $($Installation.extensionDir)$(if ( $signedBy ) { " (signed by $signedBy)" })"
    return [ordered] @{ version = $TargetVersion; sha256 = $expected; signedBy = $signedBy; reused = $false }
}

function ConvertFrom-Utf8Bytes {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes)
    return $script:Utf8.GetString($Bytes).TrimStart([char] 0xFEFF)
}

function Install-UpdaterFile {
    param([Parameter(Mandatory)][byte[]] $Bytes, [Parameter(Mandatory)][string] $Name)
    # Writes exactly the bytes that were checked, then swaps them in.
    $target = Join-Path $script:DataRoot $Name
    [IO.File]::WriteAllBytes("$target.new", $Bytes)
    Move-Item -LiteralPath "$target.new" -Destination $target -Force
}

function Get-UpdaterScriptVersion {
    param([Parameter(Mandatory)][string] $Text)
    # Returns the version of a well-formed updater script, otherwise $null.
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref] $tokens, [ref] $errors)
    if ( $null -eq $ast -or @($errors).Count -ne 0 ) { return $null }
    if ( $Text -cnotmatch "(?m)^\`$script:UpdaterVersion = '([0-9.]+)'\r?$" ) { return $null }
    if ( (Test-ReleaseVersion $Matches[1]) -eq $false ) { return $null }
    return $Matches[1]
}

# The two functions below run only for a package whose release signature
# verified, and read the verified staging copy in %LOCALAPPDATA%, never the
# extension folder. Without release signing, the updater never replaces its
# keys or itself; rerunning install-updater from a newer package does.

function Update-TrustedKeys {
    param([Parameter(Mandatory)][string] $PackageRoot)
    # A signed package can rotate the trusted key set, but never back to an
    # older generation, which may hold retired keys.
    $candidate = Join-Path $PackageRoot 'updater\release-signing-keys.json'
    $trusted = Join-Path $script:DataRoot 'release-signing-keys.json'
    if ( (Test-Path -LiteralPath $candidate -PathType Leaf) -eq $false ) { return }
    try {
        $bytes = [IO.File]::ReadAllBytes($candidate)
        $document = ConvertFrom-Utf8Bytes $bytes | ConvertFrom-Json
        $keys = ConvertFrom-KeyDocument $document
        if ( $keys.Count -eq 0 ) { return }
        if ( Test-Path -LiteralPath $trusted -PathType Leaf ) {
            $current = [IO.File]::ReadAllBytes($trusted)
            if ( [Convert]::ToBase64String($bytes) -ceq [Convert]::ToBase64String($current) ) { return }
            if ( (Get-KeyGeneration $document) -lt (Get-KeyGeneration (ConvertFrom-Utf8Bytes $current | ConvertFrom-Json)) ) {
                Write-UpdaterLog 'Kept the trusted release signing keys: the updated package ships an older key set'
                return
            }
        }
        Install-UpdaterFile $bytes 'release-signing-keys.json'
        Write-UpdaterLog 'Adopted the release signing keys shipped with the updated package'
    } catch {
        Write-UpdaterLog "Could not adopt release signing keys: $($_.Exception.Message)"
    }
}

function Update-UpdaterScripts {
    param([Parameter(Mandatory)][string] $PackageRoot)
    # A newer package can carry a newer updater. Only a script that parses and
    # declares a higher version replaces this one, so a damaged package cannot
    # disable future updates. The .cmd launcher parses its single command line
    # before running it, so replacing it while it runs is safe.
    $candidateScript = Join-Path $PackageRoot 'updater\ublock-plus-updater.ps1'
    $launcher = Join-Path $PackageRoot 'updater\ublock-plus-updater.cmd'
    if ( (Test-Path -LiteralPath $candidateScript -PathType Leaf) -eq $false -or
        (Test-Path -LiteralPath $launcher -PathType Leaf) -eq $false ) { return }
    try {
        $scriptBytes = [IO.File]::ReadAllBytes($candidateScript)
        $launcherBytes = [IO.File]::ReadAllBytes($launcher)
        $candidate = Get-UpdaterScriptVersion (ConvertFrom-Utf8Bytes $scriptBytes)
        if ( $null -eq $candidate -or (Compare-ReleaseVersion $candidate $script:UpdaterVersion) -le 0 ) { return }
        $launcherText = ConvertFrom-Utf8Bytes $launcherBytes
        if ( $launcherText.Contains('ublock-plus-updater.ps1') -eq $false -or $launcherText.Contains('-NativeHost') -eq $false ) {
            return
        }
        Install-UpdaterFile $scriptBytes 'ublock-plus-updater.ps1'
        Install-UpdaterFile $launcherBytes 'ublock-plus-updater.cmd'
        Write-UpdaterLog "Updated the updater from $script:UpdaterVersion to $candidate"
    } catch {
        Write-UpdaterLog "Could not refresh the updater: $($_.Exception.Message)"
    }
}

function Invoke-Apply {
    param([Parameter(Mandatory)] $Installation, [Parameter(Mandatory)][string] $TargetVersion, [switch] $AllowEmptyTarget)
    if ( (Test-ReleaseVersion $TargetVersion) -eq $false ) { Stop-Updater 'invalid-version' 'The requested version is invalid.' }
    Repair-InterruptedApply $Installation
    $edition = $Installation.edition
    $paths = Get-InstallationPaths $Installation
    $content = Join-Path $paths.Staging 'package'
    $marker = Join-Path $paths.Staging 'staged.json'
    $markerData = $null
    if ( Test-Path -LiteralPath $marker -PathType Leaf ) { $markerData = Read-JsonFile $marker }
    if ( [string] (Get-Property $markerData 'version') -cne $TargetVersion ) {
        Stop-Updater 'not-staged' "Version $TargetVersion has not been downloaded and verified."
    }
    $signedBy = [string] (Get-Property $markerData 'signedBy')
    if ( (Get-TrustedKeys).Count -ne 0 -and $signedBy -eq '' ) {
        # Staged before signing keys were trusted: download and verify again.
        Stop-Updater 'not-staged' "Version $TargetVersion has not been verified with a release signature."
    }
    $staged = Get-PackageIdentity $content
    Assert-PackageIdentity $staged $edition 'staged package'
    if ( $staged.Version -cne $TargetVersion ) { Stop-Updater 'not-staged' 'The staged package changed after verification.' }
    $directory = Assert-SafeExtensionDirectory $Installation.extensionDir
    $installed = Get-PackageIdentity $directory
    $empty = (Test-Path -LiteralPath $directory) -eq $false -or
        @(Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1).Count -eq 0
    $state = Read-InstallationState $paths
    $lastApplied = Get-Property $state 'lastApplied'
    if ( $null -eq $installed ) {
        if ( -not ($AllowEmptyTarget -and $empty) ) {
            Stop-Updater 'identity-mismatch' 'The configured folder does not contain uBlock Plus+; refusing to replace it.'
        }
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        # A new folder inherits the permissions of its parent.
        $null = Assert-SafeExtensionDirectory $directory
        if ( (Copy-ExtensionTree $content $directory) -eq $false ) {
            Stop-Updater 'apply-failed' 'Could not copy the package into the extension folder.'
        }
        $from = $null
    } else {
        Assert-PackageIdentity $installed $edition 'installed extension'
        if ( (Compare-ReleaseVersion $TargetVersion $installed.Version) -le 0 ) {
            Stop-Updater 'not-newer' "Version $TargetVersion is not newer than the installed $($installed.Version)."
        }
        if ( $staged.Key -cne $installed.Key ) { Stop-Updater 'identity-mismatch' 'The package would change the extension ID.' }
        $from = $installed.Version
        # Refuses links in the folder, and files that the replacement would
        # delete although the installed package did not list them.
        Assert-NoUnexpectedFiles $directory $content @($directory)
        # Start from an empty backup so that every file is copied exactly.
        if ( Test-Path -LiteralPath $paths.Backup ) { Remove-Item -LiteralPath $paths.Backup -Recurse -Force }
        New-Item -ItemType Directory -Path $paths.Backup -Force | Out-Null
        if ( (Copy-ExtensionTree $directory $paths.Backup) -eq $false ) {
            Stop-Updater 'backup-failed' 'Could not back up the installed extension; nothing was changed.'
        }
        $backup = Get-PackageIdentity $paths.Backup
        if ( $null -eq $backup -or $backup.Version -cne $installed.Version ) {
            Stop-Updater 'backup-failed' 'The backup could not be verified; nothing was changed.'
        }
        # Checked again right before robocopy: the backup took a while.
        $null = Get-TreeFiles $directory
        Write-InstallationState $paths $lastApplied ([ordered] @{
            from = $from; to = $TargetVersion; at = [DateTime]::UtcNow.ToString('o')
        })
        if ( (Copy-ExtensionTree $content $directory) -eq $false ) {
            $restored = Undo-Replacement $paths $directory $from $lastApplied
            Stop-Updater 'apply-failed' ("Could not replace the extension files; {0}." -f (Get-RestoreOutcome $restored))
        }
    }
    $result = Get-PackageIdentity $directory
    if ( $null -eq $result -or $result.Version -cne $TargetVersion ) {
        if ( $null -eq $from ) { Stop-Updater 'apply-failed' 'The extension folder did not verify after copying.' }
        $restored = Undo-Replacement $paths $directory $from $lastApplied
        Stop-Updater 'apply-failed' ("The extension folder did not verify after copying; {0}." -f (Get-RestoreOutcome $restored))
    }
    $applied = [ordered] @{ from = $from; to = $TargetVersion; at = [DateTime]::UtcNow.ToString('o') }
    Write-InstallationState $paths $applied
    Write-UpdaterLog "Applied $TargetVersion (from $from) to $directory"
    # Before the verified staging copy is removed.
    if ( $signedBy -ne '' ) {
        Update-TrustedKeys $content
        Update-UpdaterScripts $content
    }
    Remove-Item -LiteralPath $paths.Staging -Recurse -Force -ErrorAction SilentlyContinue
    return $applied
}

function Clear-InterruptedApply {
    param([Parameter(Mandatory)] $Installation, [Parameter(Mandatory)] $Paths, [Parameter(Mandatory)] $State)
    # No backup is left to undo an interrupted apply (it was deleted to free
    # space, for example). Keep the folder as it is when it declares one of
    # the two versions, and forget the interrupted apply.
    $applying = Get-Property $State 'applying'
    $from = [string] (Get-Property $applying 'from')
    $to = [string] (Get-Property $applying 'to')
    $installed = Get-PackageIdentity $Installation.extensionDir
    Assert-PackageIdentity $installed $Installation.edition 'installed extension'
    if ( $installed.Version -cne $from -and $installed.Version -cne $to ) {
        Stop-Updater 'rollback-failed' "The extension folder declares version $($installed.Version), neither $from nor $to."
    }
    Write-InstallationState $Paths (Get-Property $State 'lastApplied')
    Write-UpdaterLog "No backup of $from was left in $($Paths.Backup); kept $($installed.Version) in $($Installation.extensionDir) and cleared the interrupted update to $to"
    return [ordered] @{ cleared = $true; from = $from; to = $to; installed = $installed.Version }
}

function Invoke-RollbackInstallation {
    param([Parameter(Mandatory)] $Installation, [switch] $ClearInterrupted)
    $paths = Get-InstallationPaths $Installation
    $applying = Get-Property (Read-InstallationState $paths) 'applying'
    $backup = Get-PackageIdentity $paths.Backup
    if ( $null -eq $backup ) {
        if ( $ClearInterrupted -and $null -ne $applying ) {
            return Clear-InterruptedApply $Installation $paths (Read-InstallationState $paths)
        }
        Stop-Updater 'no-backup' 'There is no previous version to restore.'
    }
    Assert-PackageIdentity $backup $Installation.edition 'backup'
    $directory = Assert-SafeExtensionDirectory $Installation.extensionDir
    $installed = Get-PackageIdentity $directory
    if ( $null -ne $installed ) { Assert-PackageIdentity $installed $Installation.edition 'installed extension' }
    if ( $null -eq $applying ) {
        Assert-NoUnexpectedFiles $directory $paths.Backup @($directory) -SourceLabel 'backup folder'
    } else {
        Assert-NoUnexpectedInterruptedFiles $paths $directory
    }
    if ( (Restore-Backup $paths.Backup $directory) -eq $false ) {
        Stop-Updater 'rollback-failed' 'Could not restore the previous version.'
    }
    $result = Get-PackageIdentity $directory
    if ( $null -eq $result -or $result.Version -cne $backup.Version ) {
        Stop-Updater 'rollback-failed' 'The restored folder did not verify.'
    }
    $applied = [ordered] @{ from = if ( $null -ne $installed ) { $installed.Version } else { $null }; to = $backup.Version; at = [DateTime]::UtcNow.ToString('o'); rollback = $true }
    Write-InstallationState $paths $applied
    Write-UpdaterLog "Rolled back $directory to $($backup.Version)"
    return $applied
}

function Get-LatestReleaseVersion {
    param([Parameter(Mandatory)] $Config, [Parameter(Mandatory)][string] $Edition, [Parameter(Mandatory)][bool] $Prerelease)
    $client = New-HttpClient ([TimeSpan]::FromSeconds(60))
    try {
        $url = '{0}/repos/{1}/releases?per_page=30' -f $Config.apiBaseUrl.TrimEnd('/'), $Config.repository
        $request = New-Object Net.Http.HttpRequestMessage ([Net.Http.HttpMethod]::Get), $url
        $request.Headers.Accept.ParseAdd('application/vnd.github+json')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if ( $response.IsSuccessStatusCode -eq $false ) {
            Stop-Updater 'check-failed' ("The release list request failed with HTTP {0}." -f [int] $response.StatusCode)
        }
        $releases = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    } catch [UpdaterError] {
        throw
    } catch {
        Stop-Updater 'check-failed' ("The release list request failed: {0}" -f $_.Exception.GetBaseException().Message)
    } finally {
        $client.Dispose()
    }
    $best = $null
    foreach ( $release in @($releases) ) {
        if ( (Get-Property $release 'draft') -eq $true ) { continue }
        if ( (Get-Property $release 'prerelease') -eq $true -and -not $Prerelease ) { continue }
        $tag = [string] (Get-Property $release 'tag_name')
        if ( $tag -cnotmatch '^v(.+)$' -or (Test-ReleaseVersion $Matches[1]) -eq $false ) { continue }
        $candidate = $Matches[1]
        $asset = Get-AssetName $candidate $Edition
        $names = @(Get-Property $release 'assets' | ForEach-Object { Get-Property $_ 'name' })
        if ( $names -cnotcontains $asset -or $names -cnotcontains "$asset.sha256" ) { continue }
        if ( $null -eq $best -or (Compare-ReleaseVersion $candidate $best) -gt 0 ) { $best = $candidate }
    }
    if ( $null -eq $best ) { Stop-Updater 'no-release' 'No compatible release was found.' }
    return $best
}

# ---------------------------------------------------------------------------
# Native messaging

function Read-NativeMessage {
    param([Parameter(Mandatory)][IO.Stream] $Stream)
    $header = New-Object byte[] 4
    $offset = 0
    while ( $offset -lt 4 ) {
        $read = $Stream.Read($header, $offset, 4 - $offset)
        if ( $read -le 0 ) { return $null }
        $offset += $read
    }
    $length = [BitConverter]::ToInt32($header, 0)
    if ( $length -le 0 -or $length -gt 65536 ) { Stop-Updater 'invalid-request' 'The request size is invalid.' }
    $body = New-Object byte[] $length
    $offset = 0
    while ( $offset -lt $length ) {
        $read = $Stream.Read($body, $offset, $length - $offset)
        if ( $read -le 0 ) { Stop-Updater 'invalid-request' 'The request ended early.' }
        $offset += $read
    }
    return $script:Utf8.GetString($body) | ConvertFrom-Json
}

function Write-NativeMessage {
    param([Parameter(Mandatory)][IO.Stream] $Stream, [Parameter(Mandatory)] $Message)
    $bytes = $script:Utf8.GetBytes(($Message | ConvertTo-Json -Compress -Depth 8))
    $Stream.Write([BitConverter]::GetBytes([int] $bytes.Length), 0, 4)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

function Invoke-NativeHost {
    $stdin = [Console]::OpenStandardInput()
    $stdout = [Console]::OpenStandardOutput()
    $requestId = $null
    $lock = $null
    try {
        $request = Read-NativeMessage $stdin
        if ( $null -eq $request ) { return }
        $requestId = [string] (Get-Property $request 'id')
        if ( $requestId.Length -gt 64 ) { $requestId = $requestId.Substring(0, 64) }
        if ( (Get-Property $request 'v') -ne $script:ProtocolVersion ) {
            Stop-Updater 'unsupported-protocol' "This updater speaks protocol $script:ProtocolVersion."
        }
        $command = [string] (Get-Property $request 'cmd')
        if ( @('hello', 'stage', 'apply', 'rollback') -cnotcontains $command ) {
            Stop-Updater 'unsupported-command' 'The command is not supported.'
        }
        $config = Get-UpdaterConfig
        $installation = Resolve-Installation $config -Origin $CallerOrigin
        $response = [ordered] @{ v = $script:ProtocolVersion; id = $requestId; ok = $true; cmd = $command }
        $version = ''
        if ( $command -ceq 'stage' -or $command -ceq 'apply' ) {
            $version = [string] (Get-Property $request 'version')
            if ( (Test-ReleaseVersion $version) -eq $false ) { Stop-Updater 'invalid-version' 'The requested version is invalid.' }
        }
        switch ( $command ) {
            'hello' {
                # Does not wait for a running update; when none runs, an
                # interrupted one is undone first.
                Invoke-PendingRepair $installation
                $response.updaterVersion = $script:UpdaterVersion
                $response.protocol = $script:ProtocolVersion
                $response.repository = $config.repository
                $response.signatureRequired = (Get-TrustedKeys).Count -ne 0
                foreach ( $entry in (Get-InstallationStatus $installation).GetEnumerator() ) {
                    $response[$entry.Key] = $entry.Value
                }
            }
            'stage' {
                $lock = Enter-UpdaterLock
                $script:ProgressSink = {
                    param($details)
                    $event = [ordered] @{ v = $script:ProtocolVersion; id = $requestId; event = 'progress' }
                    foreach ( $entry in $details.GetEnumerator() ) { $event[$entry.Key] = $entry.Value }
                    Write-NativeMessage $stdout $event
                }
                $result = Invoke-Stage $config $installation $version
                foreach ( $entry in $result.GetEnumerator() ) { $response[$entry.Key] = $entry.Value }
            }
            'apply' {
                $lock = Enter-UpdaterLock
                $response.applied = Invoke-Apply $installation $version
            }
            'rollback' {
                $lock = Enter-UpdaterLock
                $response.applied = Invoke-RollbackInstallation $installation
            }
        }
        if ( $null -ne $script:Recovered ) { $response.recovered = $script:Recovered }
        Write-NativeMessage $stdout $response
    } catch {
        $code = 'internal-error'
        if ( $_.Exception -is [UpdaterError] ) { $code = $_.Exception.Code }
        Write-UpdaterLog ("Native request failed ({0}): {1}" -f $code, $_.Exception.Message)
        Write-NativeMessage $stdout ([ordered] @{
            v = $script:ProtocolVersion; id = $requestId; ok = $false
            error = [ordered] @{ code = $code; message = $_.Exception.Message }
        })
    } finally {
        $script:ProgressSink = $null
        if ( $null -ne $lock ) { $lock.Dispose() }
    }
}

# ---------------------------------------------------------------------------
# Command line

function Resolve-PrereleasePreference {
    param($Config)
    switch ( $IncludePrerelease ) {
        'yes' { return $true }
        'no' { return $false }
    }
    $value = Get-Property $Config 'includePrerelease'
    return $value -ne $false
}

function Invoke-CommandLine {
    $config = Get-UpdaterConfig
    $installation = Resolve-Installation $config -Directory $ExtensionDirectory
    switch ( $script:ParameterSet ) {
        'Status' {
            $interrupted = $null
            try {
                Invoke-PendingRepair $installation
            } catch {
                # Reported, so that the status stays readable.
                $applying = Get-Property (Read-InstallationState (Get-InstallationPaths $installation)) 'applying'
                $code = if ( $_.Exception -is [UpdaterError] ) { $_.Exception.Code } else { 'internal-error' }
                $interrupted = [ordered] @{
                    from = Get-Property $applying 'from'; to = Get-Property $applying 'to'
                    error = [ordered] @{ code = $code; message = $_.Exception.Message }
                }
            }
            $status = Get-InstallationStatus $installation
            if ( $null -ne $script:Recovered ) { $status.recovered = $script:Recovered }
            if ( $null -ne $interrupted ) { $status.interrupted = $interrupted }
            $status | ConvertTo-Json -Depth 6
            return
        }
        'Rollback' {
            $lock = Enter-UpdaterLock
            try {
                $applied = Invoke-RollbackInstallation $installation -ClearInterrupted
            } finally {
                $lock.Dispose()
            }
            if ( $applied.Contains('cleared') ) {
                Write-Host "No backup of uBlock Plus+ $($applied.from) was left, so $($installation.extensionDir) was kept as it is (version $($applied.installed))."
                Write-Host "Cleared the interrupted update to $($applied.to). If the extension misbehaves, run the updater with -Update or extract a release into this folder again."
                return
            }
            Write-Host "Restored uBlock Plus+ $($applied.to) in $($installation.extensionDir)."
            Write-Host 'Click Reload on the extension card at chrome://extensions (or restart the browser).'
            return
        }
    }
    $allowEmpty = $script:ParameterSet -eq 'Install'
    $target = $Version
    if ( $target -eq '' ) {
        $target = Get-LatestReleaseVersion $config $installation.edition (Resolve-PrereleasePreference $config)
    }
    $installed = Get-PackageIdentity $installation.extensionDir
    if ( $null -ne $installed -and (Test-ReleaseVersion $installed.Version) -and (Compare-ReleaseVersion $target $installed.Version) -le 0 ) {
        Write-Host "uBlock Plus+ $($installed.Version) is up to date."
        return
    }
    $lock = Enter-UpdaterLock
    try {
        $script:ProgressSink = {
            param($details)
            if ( $details.phase -eq 'download' -and $details.ContainsKey('received') -and $details.received -gt 0 ) {
                Write-Host ("  downloaded {0:N1} MiB" -f ($details.received / 1MB))
            } elseif ( $details.phase -ne 'download' ) {
                Write-Host "  $($details.phase)..."
            }
        }
        Write-Host "Downloading uBlock Plus+ $target ($($installation.edition))..."
        Invoke-Stage $config $installation $target -AllowEmptyTarget:$allowEmpty | Out-Null
        if ( $null -ne $script:Recovered ) {
            Write-Host "  restored $($script:Recovered.restored) after the interrupted update to $($script:Recovered.interrupted)"
        }
        $applied = Invoke-Apply $installation $target -AllowEmptyTarget:$allowEmpty
    } finally {
        $script:ProgressSink = $null
        $lock.Dispose()
    }
    Write-Host "Installed uBlock Plus+ $($applied.to) in $($installation.extensionDir)."
    if ( $null -ne $applied.from ) {
        Write-Host 'Click Reload on the extension card at chrome://extensions (or restart the browser).'
    }
}

if ( $MyInvocation.InvocationName -eq '.' ) { return }

$script:ParameterSet = $PSCmdlet.ParameterSetName
if ( $NativeHost ) {
    Invoke-NativeHost
    exit 0
}
try {
    Invoke-CommandLine
} catch {
    $code = if ( $_.Exception -is [UpdaterError] ) { $_.Exception.Code } else { 'internal-error' }
    [Console]::Error.WriteLine("uBlock Plus+ updater error ($code): $($_.Exception.Message)")
    exit 1
}

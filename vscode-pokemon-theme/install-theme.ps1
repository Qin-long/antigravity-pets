param(
    [ValidateSet('pikachu', 'gengar', 'charizard', 'umbreon', 'mewtwo', 'pokedex-light', 'none')]
    [string]$ApplyTheme = 'mewtwo',
    [string]$CustomExtensionsRoot = '',
    [string]$CustomSettingsPath = ''
)

$ErrorActionPreference = 'Stop'

# Strip JSONC comments (outside strings) and trailing commas so PowerShell ConvertFrom-Json succeeds on VS Code settings.json
function ConvertFrom-JsoncText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    $Sb = New-Object System.Text.StringBuilder
    $InString = $false
    $Escaped = $false
    $Len = $Text.Length
    $i = 0

    while ($i -lt $Len) {
        $Ch = $Text[$i]
        if ($InString) {
            [void]$Sb.Append($Ch)
            if ($Escaped) {
                $Escaped = $false
            } elseif ($Ch -eq '\') {
                $Escaped = $true
            } elseif ($Ch -eq '"') {
                $InString = $false
            }
            $i++
            continue
        }

        if ($Ch -eq '"') {
            $InString = $true
            [void]$Sb.Append($Ch)
            $i++
            continue
        }

        # Single-line // comment
        if ($Ch -eq '/' -and ($i + 1) -lt $Len -and $Text[$i + 1] -eq '/') {
            $i += 2
            while ($i -lt $Len -and $Text[$i] -ne "`n") { $i++ }
            continue
        }

        # Block /* ... */ comment
        if ($Ch -eq '/' -and ($i + 1) -lt $Len -and $Text[$i + 1] -eq '*') {
            $i += 2
            while (($i + 1) -lt $Len -and -not ($Text[$i] -eq '*' -and $Text[$i + 1] -eq '/')) { $i++ }
            $i += 2
            continue
        }

        [void]$Sb.Append($Ch)
        $i++
    }

    $Cleaned = [regex]::Replace($Sb.ToString(), ',(?=\s*[}\]])', '')
    if ([string]::IsNullOrWhiteSpace($Cleaned)) {
        return $null
    }
    return ($Cleaned | ConvertFrom-Json)
}

function Register-ExtensionInManifest {
    param(
        [string]$ExtensionsRoot,
        [string]$ExtensionDest,
        [string]$RelativeFolder
    )

    $ManifestPath = Join-Path $ExtensionsRoot 'extensions.json'
    if (-not (Test-Path $ManifestPath)) {
        return
    }

    try {
        $RawManifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8
        $Items = @()
        if (-not [string]::IsNullOrWhiteSpace($RawManifest)) {
            $Parsed = ConvertFrom-JsoncText -Text $RawManifest
            if ($null -ne $Parsed) {
                $Items = @($Parsed)
            }
        }

        $ExtId = 'antigravity-pokemon.vscode-pokemon-theme'
        $Filtered = @($Items | Where-Object { $_.identifier.id -ne $ExtId })

        $NormalizedFsPath = [System.IO.Path]::GetFullPath($ExtensionDest)
        # Format /c:/Users/... matching VS Code URI path convention
        $ForwardPath = $NormalizedFsPath -replace '\\', '/'
        if ($ForwardPath -match '^([A-Za-z]):(.*)$') {
            $DriveLower = $Matches[1].ToLowerInvariant()
            $RestPath = $Matches[2]
            $UriPath = "/$($DriveLower):$RestPath"
            $ExternalUri = "file:///$($DriveLower)%3A$RestPath"
        } else {
            $UriPath = $ForwardPath
            $ExternalUri = "file://$ForwardPath"
        }

        $NowMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $NewEntry = [ordered]@{
            identifier       = [ordered]@{ id = $ExtId }
            version          = '1.0.0'
            location         = [ordered]@{
                '$mid'   = 1
                fsPath   = $NormalizedFsPath
                _sep     = 1
                external = $ExternalUri
                path     = $UriPath
                scheme   = 'file'
            }
            relativeLocation = $RelativeFolder
            metadata         = [ordered]@{
                installedTimestamp   = $NowMs
                pinned               = $false
                source               = 'vsix'
                isApplicationScoped  = $false
                isMachineScoped      = $false
                isBuiltin            = $false
                updated              = $true
                private              = $false
                isPreReleaseVersion  = $false
                hasPreReleaseVersion = $false
            }
        }

        $UpdatedList = @($Filtered) + @($NewEntry)
        $OutJson = ConvertTo-Json -InputObject $UpdatedList -Depth 20 -Compress
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($ManifestPath, $OutJson, $Utf8NoBom)
        Write-Host "[OK] Registered $ExtId in: $ManifestPath" -ForegroundColor Green
    } catch {
        Write-Warning "Failed to update extensions.json ($ManifestPath): $($_.Exception.Message)"
    }
}

$ExtensionSrc = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SuiteRoot = Split-Path -Parent $ExtensionSrc
$TargetFolderName = 'antigravity-pokemon.vscode-pokemon-theme-1.0.0'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ExtRoots = @()
if (-not [string]::IsNullOrWhiteSpace($CustomExtensionsRoot)) {
    if (-not (Test-Path $CustomExtensionsRoot)) { New-Item -ItemType Directory -Path $CustomExtensionsRoot -Force | Out-Null }
    $ExtRoots += $CustomExtensionsRoot
} else {
    $AgyExtDir = Join-Path $HOME '.antigravity\extensions'
    $AgyIdeExtDir = Join-Path $HOME '.antigravity-ide\extensions'
    $VsCodeExtDir = Join-Path $HOME '.vscode\extensions'

    if (Test-Path (Join-Path $HOME '.antigravity')) {
        if (-not (Test-Path $AgyExtDir)) { New-Item -ItemType Directory -Path $AgyExtDir -Force | Out-Null }
        $ExtRoots += $AgyExtDir
    }
    if ((Test-Path (Join-Path $HOME '.antigravity-ide')) -or (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE'))) {
        if (-not (Test-Path $AgyIdeExtDir)) { New-Item -ItemType Directory -Path $AgyIdeExtDir -Force | Out-Null }
        $ExtRoots += $AgyIdeExtDir
    }
    if (Test-Path (Join-Path $HOME '.vscode')) {
        if (-not (Test-Path $VsCodeExtDir)) { New-Item -ItemType Directory -Path $VsCodeExtDir -Force | Out-Null }
        $ExtRoots += $VsCodeExtDir
    }
    if ($ExtRoots.Count -eq 0) {
        New-Item -ItemType Directory -Path $AgyExtDir -Force | Out-Null
        $ExtRoots += $AgyExtDir
    }
}

foreach ($Root in $ExtRoots) {
    $Dest = Join-Path $Root $TargetFolderName
    if (Test-Path $Dest) {
        Remove-Item -Recurse -Force $Dest
    }
    Copy-Item -Recurse -Force $ExtensionSrc $Dest

    # Record SuiteRoot so extension.js resolves shared assets/bridge/desktop-pet from anywhere
    $Marker = [ordered]@{ suiteRoot = $SuiteRoot; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $Dest 'source-root.json'), $Marker, $Utf8NoBom)
    Write-Host "[OK] Installed extension to: $Dest" -ForegroundColor Green

    Register-ExtensionInManifest -ExtensionsRoot $Root -ExtensionDest $Dest -RelativeFolder $TargetFolderName
}

function U([string]$Escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($Escaped)
}

$ThemeLabelMap = @{
    'pikachu'       = 'agent-pets-volt-dark'
    'gengar'        = 'agent-pets-shadow-dark'
    'charizard'     = 'agent-pets-flame-dark'
    'umbreon'       = 'agent-pets-moonlight-dark'
    'mewtwo'        = 'agent-pets-psychic-dark'
    'pokedex-light' = 'agent-pets-daybreak-light'
}

if ($ApplyTheme -ne 'none' -and $ThemeLabelMap.ContainsKey($ApplyTheme)) {
    $SettingsTargets = @()
    if (-not [string]::IsNullOrWhiteSpace($CustomSettingsPath)) {
        $SettingsTargets += $CustomSettingsPath
    } else {
        $SettingsTargets += (Join-Path $env:APPDATA 'Antigravity\User\settings.json')
        $SettingsTargets += (Join-Path $env:APPDATA 'Antigravity IDE\User\settings.json')
    }

    foreach ($SettingsPath in $SettingsTargets) {
        $ParentDir = Split-Path -Parent $SettingsPath
        if (Test-Path $ParentDir) {
            $SettingsObj = [ordered]@{}
            if (Test-Path $SettingsPath) {
                try {
                    $Raw = Get-Content -Path $SettingsPath -Raw -Encoding UTF8
                    if (-not [string]::IsNullOrWhiteSpace($Raw)) {
                        $Parsed = ConvertFrom-JsoncText -Text $Raw
                        if ($null -ne $Parsed) {
                            foreach ($Prop in $Parsed.PSObject.Properties) {
                                $SettingsObj[$Prop.Name] = $Prop.Value
                            }
                        }
                    }
                } catch {
                    Write-Warning "Could not parse existing settings.json ($SettingsPath : $($_.Exception.Message)), skipping automatic theme write."
                    continue
                }
            }
            $SettingsObj['workbench.colorTheme'] = $ThemeLabelMap[$ApplyTheme]
            $JsonOut = $SettingsObj | ConvertTo-Json -Depth 20
            [System.IO.File]::WriteAllText($SettingsPath, $JsonOut, $Utf8NoBom)
            Write-Host "[OK] Activated theme '$($ThemeLabelMap[$ApplyTheme])' in $SettingsPath" -ForegroundColor Cyan
        }
    }
}

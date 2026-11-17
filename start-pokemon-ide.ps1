<#
.SYNOPSIS
    One-Click Launcher & Installer for the Antigravity Full-App Pokemon Skin, IDE Theme & Side-by-Side Authentic Agent Pets Suite.
.DESCRIPTION
    1) Starts `bridge/agent-monitor.mjs` in background on http://127.0.0.1:17580
    2) Installs `vscode-pokemon-theme` into `~/.antigravity/extensions/` (`-InstallTheme` / `-InstallAll`)
    3) Applies full Antigravity Agent Manager / Subagents / Chat global skin (`-ApplyGlobalSkin` / `-InstallAll`) or restores original (`-RestoreGlobalSkin`)
    4) Syncs `plugin-bundle/pokemon-agent-pets` into `~/.gemini/config/plugins/` (`-InstallPlugin` / `-InstallAll`)
    5) Launches Windows transparent always-on-top side-by-side authentic Pokemon desktop pets (`desktop-pet/pokemon-desktop-overlay.ps1`)
#>
[CmdletBinding()]
param(
    [ValidateSet("pikachu", "gengar", "charizard", "umbreon", "mewtwo", "pokedex-light", "rotom-light")]
    [string]$Theme = "mewtwo",
    [ValidateSet("showdown", "pixel")]
    [string]$SpriteStyle = "showdown",
    [string]$BridgeUrl = "http://127.0.0.1:17580",
    [switch]$BindToIde,
    [switch]$LaunchIde,
    [switch]$InstallTheme,
    [switch]$InstallPlugin,
    [switch]$ApplyGlobalSkin,
    [switch]$RestoreGlobalSkin,
    [switch]$InstallAll,
    [switch]$OpenWebStage,
    [switch]$ClickThrough,
    [switch]$NoDesktopPet,
    [switch]$StopAll,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
if ($Theme -eq "rotom-light") { $Theme = "pokedex-light" }

function U([string]$Escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($Escaped)
}

$SuiteRoot         = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BridgeScript      = Join-Path $SuiteRoot "bridge\agent-monitor.mjs"
$OverlayScript     = Join-Path $SuiteRoot "desktop-pet\pokemon-desktop-overlay.ps1"
$LaunchScript      = Join-Path $SuiteRoot "desktop-pet\launch-desktop-pet.ps1"
$SilentVbs         = Join-Path $SuiteRoot "desktop-pet\silent-launch.vbs"
$WScriptExe        = Join-Path $env:SystemRoot "System32\wscript.exe"
$WebStageHtml      = Join-Path $SuiteRoot "desktop-pet\overlay.html"
$ThemeInstall      = Join-Path $SuiteRoot "vscode-pokemon-theme\install-theme.ps1"
$GlobalSkinApply   = Join-Path $SuiteRoot "vscode-pokemon-theme\full-app-skin\apply-global-skin.ps1"
$GlobalSkinRestore = Join-Path $SuiteRoot "vscode-pokemon-theme\full-app-skin\restore-global-skin.ps1"
$PluginSync        = Join-Path $SuiteRoot "plugin-bundle\sync-plugin.ps1"

function Resolve-RealNodeExe {
    $nvmdDef = Join-Path $env:USERPROFILE ".nvmd\default"
    if (Test-Path $nvmdDef) {
        $ver = (Get-Content $nvmdDef -Raw -ErrorAction SilentlyContinue).Trim()
        if ($ver) {
            $cand = Join-Path $env:USERPROFILE ".nvmd\versions\$ver\node.exe"
            if (Test-Path $cand) { return $cand }
        }
    }
    $versRoot = Join-Path $env:USERPROFILE ".nvmd\versions"
    if (Test-Path $versRoot) {
        $dirs = @(Get-ChildItem -Path $versRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
        foreach ($d in $dirs) {
            $cand = Join-Path $d.FullName "node.exe"
            if (Test-Path $cand) { return $cand }
        }
    }
    $pfNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $pfNode) { return $pfNode }
    return "node.exe"
}

if (-not ("StartIdeWin32" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class StartIdeWin32 {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    public static bool SpawnNoInherit(string exePath, string argsLine, string workDir) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 1; si.wShowWindow = 0;
        PROCESS_INFORMATION pi;
        string cmd = "\"" + exePath + "\" " + argsLine;
        bool ok = CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x01000000, IntPtr.Zero, workDir, ref si, out pi);
        if (!ok) ok = CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, workDir, ref si, out pi);
        if (ok) { if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess); }
        return ok;
    }
}
"@
}

function Invoke-SilentVbsDetached([string[]]$TargetArgs) {
    if (-not (Test-Path $SilentVbs)) { throw "Missing silent launcher: $SilentVbs" }
    $allArgs = @("//B", "//Nologo", $SilentVbs) + $TargetArgs
    $escaped = foreach ($a in $allArgs) {
        $s = [string]$a
        if ($s.Length -eq 0) { '""' }
        elseif ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' }
        else { $s }
    }
    [void][StartIdeWin32]::SpawnNoInherit($WScriptExe, ($escaped -join " "), $SuiteRoot)
}

# RestoreGlobalSkin Mode: 1-click clean restore of original Antigravity HTML & product.json backups
if ($RestoreGlobalSkin) {
    if (-not (Test-Path $GlobalSkinRestore)) {
        throw "Global skin restore script not found: $GlobalSkinRestore"
    }
    Write-Host (U "\uD83D\uDD04 \u6B63\u5728\u8FD8\u539F Antigravity \u5168\u5C40\u539F\u751F\u754C\u9762\u5907\u4EFD...") -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $GlobalSkinRestore
    Write-Host (U "\u2705 [OK] \u5DF2\u8FD8\u539F Antigravity \u539F\u751F UI\uFF0C\u6309 Ctrl+R / Reload Window \u5373\u53EF\u751F\u6548\u3002") -ForegroundColor Green
    exit 0
}

if ($InstallAll) {
    $InstallTheme    = $true
    $InstallPlugin   = $true
    $ApplyGlobalSkin = $true
}

# StopAll Mode: Cleanly stop floating desktop pets and background bridge if requested
if ($StopAll) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LaunchScript -StopPets | Out-Null
    try {
        $conns = Get-NetTCPConnection -LocalPort 17580 -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess -and $c.OwningProcess -gt 4) {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    Write-Host (U "\uD83D\uDED1 [OK] \u5DF2\u505C\u6B62\u684C\u9762\u60AC\u6D6E\u684C\u5BA0\u4E0E\u76D1\u63A7\u6865\u3002") -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host (U "  \u26A1 Antigravity \u667A\u80FD\u4F53\u684C\u5BA0\u4E00\u952E\u542F\u52A8\u5668\uFF08\u5168\u5C40\u76AE\u80A4 + \u684C\u9762\u60AC\u6D6E\u7A97\uFF09") -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Yellow

# Optional: Launch Antigravity.exe if -LaunchIde is passed and not yet running
if ($LaunchIde) {
    $BindToIde = $true
    $agRunning = @(Get-Process -Name "Antigravity","Antigravity IDE" -ErrorAction SilentlyContinue)
    if ($agRunning.Count -eq 0) {
        $agyExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity\Antigravity.exe"
        if (-not (Test-Path $agyExe)) {
            $agyExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE\Antigravity IDE.exe"
        }
        if (Test-Path $agyExe -and (Test-Path $SilentVbs)) {
            Write-Host (U "\uD83D\uDE80 \u6B63\u5728\u542F\u52A8 Antigravity IDE ($agyExe)...") -ForegroundColor Cyan
            Invoke-SilentVbsDetached @($agyExe)
        }
    }
}

# Step 1: Ensure Live Agent Monitor Bridge (`bridge/agent-monitor.mjs`) is running
$IdeSessionScript = Join-Path $SuiteRoot "bridge\ide-session.mjs"
$bridgeHealthy = $false
try {
    $health = Invoke-RestMethod -Uri "$BridgeUrl/health" -Method Get -TimeoutSec 1 -ErrorAction Stop
    if ($health -and $health.ok) {
        $bridgeStale = $false
        if ($null -ne $health.uptimeSec) {
            $bridgeStartedUtc = [DateTime]::UtcNow.AddSeconds(-[double]$health.uptimeSec)
            $latestBridgeWriteUtc = [DateTime]::MinValue
            foreach ($bf in @($BridgeScript, $IdeSessionScript)) {
                if (Test-Path $bf) {
                    $wt = (Get-Item $bf).LastWriteTimeUtc
                    if ($wt -gt $latestBridgeWriteUtc) { $latestBridgeWriteUtc = $wt }
                }
            }
            if ($latestBridgeWriteUtc -gt $bridgeStartedUtc.AddSeconds(2)) {
                $bridgeStale = $true
            }
        }
        if ($bridgeStale) {
            Write-Host (U "\uD83D\uDD04 [1/5] \u68C0\u6D4B\u5230\u6865\u63A5\u811A\u672C\u5DF2\u66F4\u65B0\uFF0C\u6B63\u5728\u91CD\u542F\u6700\u65B0\u7248 bridge/agent-monitor.mjs...") -ForegroundColor Yellow
            $bridgePort = 17580
            try {
                $u = [System.Uri]$BridgeUrl
                if ($u.Port -gt 0) { $bridgePort = $u.Port }
            } catch {}
            try {
                $conns = Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue
                foreach ($c in $conns) {
                    if ($c.OwningProcess -and $c.OwningProcess -gt 4) {
                        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                    }
                }
            } catch {}
            Start-Sleep -Milliseconds 350
        } else {
            $bridgeHealthy = $true
            Write-Host (U "\uD83D\uDEF0\uFE0F [1/5] \u667A\u80FD\u4F53\u72B6\u6001\u6865\u63A5\u670D\u52A1\u5DF2\u5728\u7EBF: $BridgeUrl") -ForegroundColor Green
        }
    }
} catch {}

if (-not $bridgeHealthy) {
    if (-not (Test-Path $BridgeScript)) {
        throw "Bridge script missing: $BridgeScript"
    }
    Write-Host (U "\uD83D\uDE80 [1/5] \u6B63\u5728\u540E\u53F0\u542F\u52A8\u667A\u80FD\u4F53\u5B9E\u65F6\u76D1\u63A7\u6865\u63A5 (bridge/agent-monitor.mjs)...") -ForegroundColor Cyan
    if (Test-Path $SilentVbs) {
        $realNode = Resolve-RealNodeExe
        Invoke-SilentVbsDetached @($realNode, $BridgeScript)
    } else {
        throw "Missing silent launcher: $SilentVbs"
    }

    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "$BridgeUrl/health" -Method Get -TimeoutSec 1 -ErrorAction Stop
            if ($health -and $health.ok) {
                $bridgeHealthy = $true
                break
            }
        } catch {}
    }

    if ($bridgeHealthy) {
        Write-Host (U "\u2705       \u6865\u63A5\u670D\u52A1\u542F\u52A8\u6210\u529F: $BridgeUrl") -ForegroundColor Green
    } else {
        Write-Warning "Bridge health check timed out; desktop pet fallback scanner will still operate."
    }
}

# Step 2: Optional Antigravity IDE / VS Code Theme Extension Installation (includes auto-start on IDE open!)
if ($InstallTheme) {
    Write-Host (U "\uD83C\uDFA8 [2/5] \u6B63\u5728\u5B89\u88C5 Antigravity IDE \u914D\u8272\u4E3B\u9898\u4E0E\u81EA\u542F\u52A8\u6269\u5C55...") -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ThemeInstall -ApplyTheme $Theme
} else {
    Write-Host (U "\u23ED\uFE0F [2/5] \u8DF3\u8FC7 IDE \u4E3B\u9898\u5B89\u88C5 (\u53EF\u52A0 -InstallTheme \u6216 -InstallAll)") -ForegroundColor DarkGray
}

# Step 3: Optional Full Antigravity UI Skin (Agent Manager + Subagents Party UI + Chat Canvas)
if ($ApplyGlobalSkin) {
    if (Test-Path $GlobalSkinApply) {
        Write-Host (U "\uD83D\uDD2E [3/5] \u6B63\u5728\u6CE8\u5165 Antigravity \u5168\u5C40\u76AE\u80A4\u4E0E Subagents \u961F\u4F0D\u680F ($Theme)...") -ForegroundColor Cyan
        $cmdInfo = Get-Command $GlobalSkinApply -ErrorAction SilentlyContinue
        $applyArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $GlobalSkinApply)
        if ($cmdInfo -and $cmdInfo.Parameters.ContainsKey("Theme")) {
            $applyArgs += @("-Theme", $Theme)
        } elseif ($cmdInfo -and $cmdInfo.Parameters.ContainsKey("ApplyTheme")) {
            $applyArgs += @("-ApplyTheme", $Theme)
        }
        & powershell.exe @applyArgs
    } else {
        Write-Warning "Global skin script not found at $GlobalSkinApply"
    }
} else {
    Write-Host (U "\u23ED\uFE0F [3/5] \u8DF3\u8FC7 Antigravity \u5168\u5C40 UI \u76AE\u80A4\u6CE8\u5165 (\u53EF\u52A0 -ApplyGlobalSkin \u6216 -InstallAll)") -ForegroundColor DarkGray
}

# Step 4: Optional Antigravity 2.0 Plugin + Sidecar Sync
if ($InstallPlugin) {
    Write-Host (U "\uD83E\uDDE9 [4/5] \u6B63\u5728\u540C\u6B65 Antigravity app \u526F\u5C4F\u63D2\u4EF6...") -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PluginSync
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PluginSync -DryRun | Out-Null
    Write-Host (U "\u23ED\uFE0F [4/5] \u8DF3\u8FC7\u5168\u5C40\u63D2\u4EF6\u540C\u6B65 (\u53EF\u52A0 -InstallPlugin \u6216 -InstallAll)") -ForegroundColor DarkGray
}

if ($CheckOnly) {
    $snap = $null
    try { $snap = Invoke-RestMethod -Uri "$BridgeUrl/api/agents" -Method Get -TimeoutSec 2 } catch {}
    $agentTotal = if ($snap -and $snap.agents) { $snap.agents.Count } else { 0 }
    $out = @{
        ok                = $true
        bridgeHealthy     = $bridgeHealthy
        activeAgents      = $agentTotal
        overlayExists     = (Test-Path $OverlayScript)
        stageExists       = (Test-Path $WebStageHtml)
        globalSkinExists  = (Test-Path $GlobalSkinApply)
    }
    Write-Output ($out | ConvertTo-Json -Compress)
    exit 0
}

# Step 5: Launch Windows Native Transparent Side-by-Side Authentic Pokemon Desktop Pets
$agProcs = @(Get-Process -Name "Antigravity","Antigravity IDE" -ErrorAction SilentlyContinue)
$effectiveBind = [bool]$BindToIde -or ($agProcs.Count -gt 0)

if (-not $NoDesktopPet) {
    Write-Host (U "\uD83E\uDE9F [5/5] \u6B63\u5728\u53EC\u5524 Windows \u684C\u9762\u60AC\u6D6E\u684C\u5BA0 ($Theme / $SpriteStyle)...") -ForegroundColor Cyan
    $launchArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $LaunchScript,
        "-Theme", $Theme,
        "-SpriteStyle", $SpriteStyle,
        "-ForceRestart"
    )
    if ($effectiveBind) { $launchArgs += "-BindToIde" }
    if ($ClickThrough) { $launchArgs += "-ClickThrough" }
    & powershell.exe @launchArgs | Out-Null
    Write-Host (U "\u2728       \u684C\u9762\u60AC\u6D6E\u684C\u5BA0\u5DF2\u5C31\u7EEA\uFF01(\u5DF2\u7ED1\u5B9A Antigravity IDE \u751F\u547D\u5468\u671F)") -ForegroundColor Green
} else {
    Write-Host (U "\u23ED\uFE0F [5/5] \u5DF2\u6309 -NoDesktopPet \u8DF3\u8FC7 Windows \u684C\u9762\u60AC\u6D6E\u7A97\u3002") -ForegroundColor DarkGray
}

if ($OpenWebStage -and (Test-Path $WebStageHtml)) {
    $fileUri = ([System.Uri]$WebStageHtml).AbsoluteUri
    $edgeExe = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edgeExe)) { $edgeExe = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
    if (Test-Path $edgeExe -and (Test-Path $SilentVbs)) {
        Invoke-SilentVbsDetached @($edgeExe, "--app=$fileUri", "--window-size=1020,700")
    } elseif (Test-Path $SilentVbs) {
        Invoke-SilentVbsDetached @("explorer.exe", $WebStageHtml)
    }
}

Write-Host ""
Write-Host (U "\uD83D\uDCA1 \u5E38\u7528\u547D\u4EE4\u901F\u67E5:") -ForegroundColor Cyan
Write-Host "   .\start-pokemon-ide.ps1 -InstallAll -Theme mewtwo   # Full global UI skin + Subagents party UI + IDE theme + side-by-side pets"
Write-Host "   .\start-pokemon-ide.ps1 -ApplyGlobalSkin -Theme gengar # Apply/switch full Antigravity global skin"
Write-Host "   .\start-pokemon-ide.ps1 -RestoreGlobalSkin          # Restore clean original Antigravity UI backups"
Write-Host "   .\start-antigravity-with-pets.cmd                   # Launch Antigravity IDE + bound side-by-side authentic pets"
Write-Host "   .\start-pokemon-ide.ps1 -StopAll                    # Stop all floating pets & background bridge"
Write-Host ""

<#
.SYNOPSIS
    Non-blocking launcher for the Windows Transparent Authentic Animated Pokemon Desktop Pets.
    Supports `-BindToIde` and `-IdePid` for automatic startup & shutdown bound to Antigravity IDE.
#>
[CmdletBinding()]
param(
    [ValidateSet("pikachu", "gengar", "charizard", "umbreon", "mewtwo", "pokedex-light", "rotom-light")]
    [string]$Theme = "",
    [ValidateSet("showdown", "pixel")]
    [string]$SpriteStyle = "showdown",
    [switch]$BindToIde,
    [int]$IdePid = 0,
    [switch]$ClickThrough,
    [switch]$ForceRestart,
    [switch]$FromWatchdog,
    [switch]$StopPets,
    [Parameter(ValueFromRemainingArguments = $true)]
    $RemainingArgs
)

$ErrorActionPreference = "Stop"
if ($Theme -eq "rotom-light") { $Theme = "pokedex-light" }
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$OverlayScript = Join-Path $ScriptDir "pokemon-desktop-overlay.ps1"
$PidFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay.pid"
$StateFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay-state.json"
$MuteFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay-muted.json"

if (-not ("LauncherDeskHelper" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LauncherDeskHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint dwThreadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int needed);
    public static string GetDesktopName() {
        try {
            IntPtr h = GetThreadDesktop(GetCurrentThreadId());
            if (h == IntPtr.Zero) return "Unknown";
            var sb = new StringBuilder(256);
            int n = 0;
            if (GetUserObjectInformation(h, 2, sb, sb.Capacity * 2, out n)) return sb.ToString();
        } catch {}
        return "Unknown";
    }
    public static bool SpawnNoInherit(string exePath, string argsLine, string workDir) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 1;
        si.wShowWindow = 0;
        PROCESS_INFORMATION pi;
        string cmd = "\"" + exePath + "\" " + argsLine;
        bool ok = CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x01000000, IntPtr.Zero, workDir, ref si, out pi);
        if (!ok) {
            ok = CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, workDir, ref si, out pi);
        }
        if (ok) {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        }
        return ok;
    }
}
"@
}

$CurrentDesktop = [LauncherDeskHelper]::GetDesktopName()

if ($StopPets) {
    try {
        $muteJson = @{ mutedAt = (Get-Date).ToString("o"); reason = "stop-pets" } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($MuteFile, $muteJson, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    if (Test-Path $StateFile) {
        try {
            $st = Get-Content $StateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
            if ($st -and $st.pid) {
                Stop-Process -Id ([int]$st.pid) -Force -ErrorAction SilentlyContinue
            }
        } catch {}
        Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $PidFile) {
        try {
            $oldPid = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($oldPid) {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            }
        } catch {}
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    Write-Output '{"ok":true,"action":"stopped","muted":true}'
    exit 0
}

if ($FromWatchdog) {
    if (Test-Path $MuteFile) {
        Write-Output '{"ok":true,"muted":true}'
        exit 0
    }
} else {
    if (Test-Path $MuteFile) {
        Remove-Item $MuteFile -Force -ErrorAction SilentlyContinue
    }
}

# Auto-detect active IDE Pokemon theme from Bridge /health or settings.json when -Theme is not explicitly provided
if (-not $PSBoundParameters.ContainsKey("Theme") -or [string]::IsNullOrWhiteSpace($Theme)) {
    $Theme = "mewtwo"
    $resolvedFromBridge = $false
    try {
        $bh = Invoke-RestMethod -Uri "http://127.0.0.1:17580/health" -Method Get -TimeoutSec 1 -ErrorAction Stop
        if ($bh -and $bh.activeTheme) {
            $bt = [string]$bh.activeTheme
            if ($bt -eq "rotom-light") { $bt = "pokedex-light" }
            if ($bt -in @("pikachu", "gengar", "charizard", "umbreon", "mewtwo", "pokedex-light")) {
                $Theme = $bt
                $resolvedFromBridge = $true
            }
        }
    } catch {}
    $candidateSettings = @(
        (Join-Path $env:APPDATA "Antigravity\User\settings.json"),
        (Join-Path $env:APPDATA "Antigravity IDE\User\settings.json")
    )
    if (-not $resolvedFromBridge) {
        foreach ($settingsPath in $candidateSettings) {
            if (Test-Path $settingsPath) {
                try {
                    $rawSettings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    $ct = [string]$rawSettings.'workbench.colorTheme'
                    if (-not [string]::IsNullOrWhiteSpace($ct)) {
                        if ($ct -match ([regex]::Unescape('\u8D85\u68A6')) -or $ct -match 'Mewtwo' -or $ct -eq 'agent-pets-psychic-dark') { $Theme = "mewtwo"; break }
                        elseif ($ct -match ([regex]::Unescape('\u803F\u9B3C')) -or $ct -match 'Gengar' -or $ct -eq 'agent-pets-shadow-dark') { $Theme = "gengar"; break }
                        elseif ($ct -match ([regex]::Unescape('\u55B7\u706B\u9F99')) -or $ct -match 'Charizard' -or $ct -eq 'agent-pets-flame-dark') { $Theme = "charizard"; break }
                        elseif ($ct -match ([regex]::Unescape('\u6708\u4EAE\u4F0A\u5E03')) -or $ct -match 'Umbreon' -or $ct -eq 'agent-pets-moonlight-dark') { $Theme = "umbreon"; break }
                        elseif ($ct -match ([regex]::Unescape('\u56FE\u9274')) -or $ct -match 'Pokedex' -or $ct -eq 'agent-pets-daybreak-light') { $Theme = "pokedex-light"; break }
                        elseif ($ct -match ([regex]::Unescape('\u76AE\u5361\u4E18')) -or $ct -match 'Pikachu' -or $ct -eq 'agent-pets-volt-dark') { $Theme = "pikachu"; break }
                    }
                } catch {}
            }
        }
    }
}

# Fast single-instance check when -ForceRestart is NOT set (prevents duplicate spawns when extension.js + sidecar both auto-start)
if (-not $ForceRestart -and (Test-Path $StateFile)) {
    try {
        $oldState = Get-Content $StateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($oldState -and $oldState.pid) {
            $aliveProc = Get-Process -Id ([int]$oldState.pid) -ErrorAction SilentlyContinue
            if ($aliveProc -and ($aliveProc.ProcessName -match '^powershell|^pwsh')) {
                if ($CurrentDesktop -eq "Default" -and $oldState.desktop -eq "Default") {
                    Write-Output ("{`"ok`":true,`"alreadyRunning`":true,`"pid`":$($aliveProc.Id),`"desktop`":`"Default`",`"theme`":`"$($oldState.theme)`"}")
                    exit 0
                }
                if ($CurrentDesktop -ne "Default" -and $oldState.desktop -eq "Default") {
                    Write-Output ("{`"ok`":true,`"alreadyRunning`":true,`"pid`":$($aliveProc.Id),`"desktop`":`"Default`"}")
                    exit 0
                }
            }
        }
    } catch {}
}

$SilentVbs = Join-Path $ScriptDir "silent-launch.vbs"
$WScriptExe = Join-Path ($env:SystemRoot) "System32\wscript.exe"
if (-not (Test-Path $WScriptExe)) { $WScriptExe = "wscript.exe" }

$psArgs = @(
    "powershell.exe",
    "-STA",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", $OverlayScript,
    "-Theme", $Theme,
    "-SpriteStyle", $SpriteStyle,
    "-IdePid", "$IdePid"
)
if ($BindToIde) { $psArgs += "-BindToIde" }
if ($ClickThrough) { $psArgs += "-ClickThrough" }
if ($ForceRestart) { $psArgs += "-ForceRestart" }

$prevPid = 0
if (Test-Path $StateFile) {
    try {
        $prevObj = Get-Content $StateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($prevObj -and $prevObj.pid) { $prevPid = [int]$prevObj.pid }
    } catch {}
}

function Start-WscriptDetached([string]$WscriptBin, [string[]]$ArgItems) {
    $escaped = foreach ($a in $ArgItems) {
        $s = [string]$a
        if ($s.Length -eq 0) { '""' }
        elseif ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' }
        else { $s }
    }
    $workRoot = Split-Path -Parent $ScriptDir
    [void][LauncherDeskHelper]::SpawnNoInherit($WscriptBin, ($escaped -join " "), $workRoot)
}

if (Test-Path $SilentVbs) {
    $vbsInvokeArgs = @("//B", "//Nologo", $SilentVbs) + $psArgs
    Start-WscriptDetached $WScriptExe $vbsInvokeArgs
} else {
    throw "Missing required silent launcher: $SilentVbs"
}

$launchedPid = 0
for ($w = 0; $w -lt 16; $w++) {
    Start-Sleep -Milliseconds 180
    if (Test-Path $StateFile) {
        try {
            $curObj = Get-Content $StateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
            if ($curObj -and $curObj.pid -and ([int]$curObj.pid -ne $prevPid -or (-not $ForceRestart))) {
                $cand = Get-Process -Id ([int]$curObj.pid) -ErrorAction SilentlyContinue
                if ($cand) {
                    $launchedPid = $cand.Id
                    break
                }
            }
        } catch {}
    }
}

Write-Output ("{`"ok`":true,`"pid`":$launchedPid,`"theme`":`"$Theme`",`"spriteStyle`":`"$SpriteStyle`",`"bindToIde`":$(if ($BindToIde) {'true'} else {'false'}),`"desktop`":`"$CurrentDesktop`",`"launcher`":`"wscript-vbs`"}")

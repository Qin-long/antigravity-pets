<#
.SYNOPSIS
    Applies the v4.0 Full-App Global Pokemon UI Skin, Subagents Party Squad UI & Single Shared OS Overlay Hooks
    to both Antigravity 2.0 (App A) and Antigravity IDE (App B), with automatic clean backups.
#>
[CmdletBinding()]
param(
    [Alias('ApplyTheme')]
    [ValidateSet('mewtwo', 'pikachu', 'gengar', 'charizard', 'umbreon', 'pokedex-light')]
    [string]$Theme = 'mewtwo',
    # Antigravity app locks app.asar while it runs: keep retrying the app part (every 3s, up to
    # -WaitMinutes) and finish as soon as the app has been quit. Meant to be started hidden.
    [switch]$WaitForAppExit,
    [int]$WaitMinutes = 360
)

$ErrorActionPreference = 'Stop'

function U([string]$Escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($Escaped)
}

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SuiteRoot   = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PatchEngine = Join-Path $ScriptDir 'patch-engine.mjs'
$SilentVbs   = Join-Path $SuiteRoot 'desktop-pet\silent-launch.vbs'
$WScriptExe  = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $PatchEngine)) {
    throw "Patch engine missing: $PatchEngine"
}

if (-not ("ApplySkinWin32" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ApplySkinWin32 {
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
    if (-not (Test-Path $SilentVbs)) { return $false }
    $allArgs = @("//B", "//Nologo", $SilentVbs) + $TargetArgs
    $escaped = foreach ($a in $allArgs) {
        $s = [string]$a
        if ($s.Length -eq 0) { '""' }
        elseif ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' }
        else { $s }
    }
    return [ApplySkinWin32]::SpawnNoInherit($WScriptExe, ($escaped -join " "), $SuiteRoot)
}

function Resolve-RealNodeExe {
    $nvmdDefault = Join-Path $HOME '.nvmd\default'
    if (Test-Path $nvmdDefault) {
        $ver = (Get-Content $nvmdDefault -Raw -ErrorAction SilentlyContinue).Trim()
        if ($ver) {
            $cand = Join-Path $HOME ".nvmd\versions\$ver\node.exe"
            if (Test-Path $cand) { return $cand }
        }
    }
    $nvmdVersions = Join-Path $HOME '.nvmd\versions'
    if (Test-Path $nvmdVersions) {
        $dirs = Get-ChildItem -Path $nvmdVersions -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $dirs) {
            $cand = Join-Path $d.FullName 'node.exe'
            if (Test-Path $cand) { return $cand }
        }
    }
    $pfNode = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path $pfNode) { return $pfNode }
    return 'node'
}

$RealNodeExe  = Resolve-RealNodeExe
$WaiterPidFile = Join-Path $env:TEMP 'antigravity-pokemon-asar-waiter.pid'

function Get-ActiveAsarWaiterPid {
    if (-not (Test-Path $WaiterPidFile)) { return $null }
    try {
        $raw = (Get-Content $WaiterPidFile -Raw -ErrorAction SilentlyContinue).Trim()
        $wpid = 0
        if ([int]::TryParse($raw, [ref]$wpid) -and $wpid -gt 4) {
            $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'powershell|pwsh') {
                return $wpid
            }
        }
    } catch {}
    return $null
}

if ($WaitForAppExit) {
    $existingWaiter = Get-ActiveAsarWaiterPid
    if ($existingWaiter -and $existingWaiter -ne $PID) { exit 0 }
    try {
        [System.IO.File]::WriteAllText($WaiterPidFile, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
        $deadline = (Get-Date).AddMinutes([Math]::Max(1, $WaitMinutes))
        $windowlessSince = $null
        while ((Get-Date) -lt $deadline) {
            $out = & $RealNodeExe $PatchEngine apply --theme $Theme --only app-a
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $state = [string](($out | ConvertFrom-Json).appA.asar)
            if ($state -ne 'locked') { exit 0 }

            # Detect whether all running Antigravity processes are windowless (tray or orphaned subprocesses).
            # Never force-kill Antigravity.exe (user may have minimized to tray); keep retrying every 2s.
            $agProcs = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
            if ($agProcs.Count -gt 0) {
                $openWins = @($agProcs | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
                if ($openWins.Count -eq 0) {
                    if ($null -eq $windowlessSince) {
                        $windowlessSince = Get-Date
                    } elseif (((Get-Date) - $windowlessSince).TotalSeconds -gt 6) {
                        # Confirmed windowless >6s (tray or residual background Antigravity.exe); keep waiting cleanly
                    }
                } else {
                    $windowlessSince = $null
                }
            } else {
                $windowlessSince = $null
            }

            Start-Sleep -Seconds 2
        }
        exit 2
    } finally {
        try {
            if (Test-Path $WaiterPidFile) {
                $cur = (Get-Content $WaiterPidFile -Raw -ErrorAction SilentlyContinue).Trim()
                if ($cur -eq [string]$PID) {
                    Remove-Item $WaiterPidFile -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {}
    }
}

Write-Host (U "\uD83D\uDD2E [Global Skin] \u6B63\u5728\u6CE8\u5165\u5168\u5C40\u76AE\u80A4\u4E0E Subagents \u961F\u4F0D\u680F (\u4E3B\u9898: $Theme)...") -ForegroundColor Cyan

$JsonResult = & $RealNodeExe $PatchEngine apply --theme $Theme
if ($LASTEXITCODE -ne 0) {
    throw "patch-engine.mjs failed with exit code $LASTEXITCODE"
}

$Parsed = $JsonResult | ConvertFrom-Json

if ($Parsed.appA -and $Parsed.appA.found) {
    switch ([string]$Parsed.appA.asar) {
        'locked' {
            $activeWaiterPid = Get-ActiveAsarWaiterPid
            if ($activeWaiterPid) {
                Write-Host (U "\u26A0\uFE0F [App A: Antigravity 2.0] Antigravity.exe \u6B63\u5728\u8FD0\u884C\uFF0Capp.asar \u5F53\u524D\u88AB\u5360\u7528\u3002\u540E\u53F0\u9759\u9ED8\u5B88\u62A4\u8FDB\u7A0B\uFF08PID: $activeWaiterPid\uFF09\u5DF2\u5C31\u7EEA\uFF0C\u5173\u95ED Antigravity \u540E\u5C06\u81EA\u52A8\u5B8C\u6210\u94A9\u5B50\u6CE8\u5165\uFF08\u60A8\u73B0\u5728\u5373\u53EF\u76F4\u63A5\u5173\u95ED\u5E76\u91CD\u5F00 Antigravity\uFF09\u3002") -ForegroundColor Yellow
            } else {
                $selfScript = $MyInvocation.MyCommand.Definition
                $spawnedDetached = Invoke-SilentVbsDetached @($selfScript, '-Theme', $Theme, '-WaitForAppExit')
                if (-not $spawnedDetached) {
                    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                    if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }
                    $proc = Start-Process -FilePath $psExe -ArgumentList @(
                        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                        '-ExecutionPolicy', 'Bypass', '-File', $selfScript,
                        '-Theme', $Theme, '-WaitForAppExit'
                    ) -WindowStyle Hidden -PassThru
                    if ($proc -and $proc.Id) {
                        [System.IO.File]::WriteAllText($WaiterPidFile, [string]$proc.Id, (New-Object System.Text.UTF8Encoding($false)))
                    }
                }
                Write-Host (U "\u26A0\uFE0F [App A: Antigravity 2.0] Antigravity.exe \u6B63\u5728\u8FD0\u884C\uFF0Capp.asar \u5F53\u524D\u88AB\u5360\u7528\u3002\u5DF2\u5728\u540E\u53F0\u81EA\u52A8\u6302\u8F7D\u8131\u79BB Job \u7684\u9759\u9ED8\u5B88\u62A4\u8FDB\u7A0B\uFF0C\u5C06\u5728\u60A8\u5173\u95ED Antigravity \u540E\u7ACB\u5373\u81EA\u52A8\u5B8C\u6210\u94A9\u5B50\u6CE8\u5165\uFF08\u60A8\u73B0\u5728\u5373\u53EF\u76F4\u63A5\u5173\u95ED\u5E76\u91CD\u5F00 Antigravity\uFF09\u3002") -ForegroundColor Yellow
            }
            Write-Host (U "\uD83D\uDCA1 \u63D0\u793A: \u82E5\u5173\u95ED\u7A97\u53E3\u540E app.asar \u4ECD\u88AB\u5360\u7528\uFF0C\u8BF7\u53F3\u952E\u70B9\u51FB\u5C4F\u5E55\u53F3\u4E0B\u89D2\u7CFB\u7EDF\u6258\u76D8 Antigravity \u56FE\u6807 -> Quit \u5B8C\u5168\u9000\u51FA\uFF08\u6216\u5728\u4EFB\u52A1\u7BA1\u7406\u5668\u4E2D\u68C0\u67E5\u662F\u5426\u6709\u6B8B\u7559\u7684 Antigravity.exe \u5B50\u8FDB\u7A0B\uFF09\u3002") -ForegroundColor DarkYellow
        }
        'up-to-date' {
            Write-Host ((U "\u2705 [App A: Antigravity 2.0] app.asar \u91CC\u7684\u94A9\u5B50\u5DF2\u662F\u6700\u65B0\uFF0C\u53EA\u66F4\u65B0\u4E86\u76AE\u80A4\u6587\u4EF6: ") + $Parsed.appA.path) -ForegroundColor Green
        }
        default {
            Write-Host ((U "\u2705 [App A: Antigravity 2.0] \u5DF2\u628A\u94A9\u5B50\u5199\u5165 app.asar\uFF08\u539F\u7248\u5907\u4EFD\u4E3A app.asar.pokemon-backup\uFF09: ") + $Parsed.appA.path) -ForegroundColor Green
        }
    }
}
if ($Parsed.appB -and $Parsed.appB.found) {
    Write-Host ((U "\u2705 [App B: Antigravity IDE] \u5DF2\u6CE8\u5165 Workbench/Jetski HTML \u5E76\u66F4\u65B0 product.json SHA-256 \u6821\u9A8C\u548C: ") + $Parsed.appB.path) -ForegroundColor Green
}

Write-Host (U "\u2728 \u63D0\u793A: Antigravity IDE \u6309 Ctrl+R (Reload Window) \u7ACB\u5373\u751F\u6548\uFF1BAntigravity app \u9700\u5B8C\u5168\u9000\u51FA\u540E\u91CD\u65B0\u6253\u5F00\u624D\u751F\u6548\uFF01") -ForegroundColor Yellow

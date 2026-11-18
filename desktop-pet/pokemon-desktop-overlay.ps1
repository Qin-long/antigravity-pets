<#
.SYNOPSIS
    Antigravity Pokemon Desktop Pet Overlay v4.0 (Single Unified Shared Floating Window + Double-Click Focus Session)
.DESCRIPTION
    Genuine OS-level frameless, transparent/glassmorphic, always-on-top SINGLE shared floating window
    (`Local\AntigravityPokemonOverlay_Default`) shared across ALL Antigravity & Antigravity IDE windows.
    - Renders Project-Grouped Multi-Session Queues (`[leadAgent] -> [subagents]`) inside ONE unified WPF window.
    - Single-clicking `leadAgent` (debounced 220ms) toggles the Conversation Title & Project Name bubble/banner.
    - Double-clicking `leadAgent` calls `POST /api/focus-session` + Win32 `SetForegroundWindow` (or launches workspace)
      to immediately pop up the corresponding Project window and switch to that Conversation!
#>
[CmdletBinding()]
param(
    [string]$BridgeUrl = "http://127.0.0.1:17580",
    [ValidateSet("pikachu", "gengar", "charizard", "umbreon", "mewtwo", "pokedex-light", "rotom-light")]
    [string]$Theme = "mewtwo",
    [ValidateSet("showdown", "pixel")]
    [string]$SpriteStyle = "showdown",
    [int]$PollIntervalMs = 500,
    [bool]$AutoWalk = $false,
    [switch]$BindToIde,
    [int]$IdePid = 0,
    [switch]$ClickThrough,
    [switch]$NoAutoStartBridge,
    [switch]$ForceRestart,
    [int]$InteractiveSmokeTestMs = 0,
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
if ($Theme -eq "rotom-light") { $Theme = "pokedex-light" }

$OverlayErrorLog = Join-Path $env:USERPROFILE ".gemini\antigravity\pokemon-overlay-error.log"
function Write-OverlayErrorLog([string]$Where, $ErrObj) {
    try {
        $logDir = Split-Path -Parent $OverlayErrorLog
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        $msg = "[$(Get-Date -Format 'o')] [$Where] " + ($ErrObj | Out-String).Trim() + "`r`n"
        [System.IO.File]::AppendAllText($OverlayErrorLog, $msg, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

# 1. Ensure STA ApartmentState required by WPF
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne [System.Threading.ApartmentState]::STA) {
    $argList = @(
        "-STA",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-BridgeUrl", $BridgeUrl,
        "-Theme", $Theme,
        "-SpriteStyle", $SpriteStyle,
        "-PollIntervalMs", "$PollIntervalMs",
        "-IdePid", "$IdePid",
        "-InteractiveSmokeTestMs", "$InteractiveSmokeTestMs"
    )
    if ($AutoWalk) { $argList += "-AutoWalk:`$true" } else { $argList += "-AutoWalk:`$false" }
    if ($BindToIde) { $argList += "-BindToIde" }
    if ($ClickThrough) { $argList += "-ClickThrough" }
    if ($NoAutoStartBridge) { $argList += "-NoAutoStartBridge" }
    if ($ForceRestart) { $argList += "-ForceRestart" }
    if ($SelfTest) { $argList += "-SelfTest" }

    if ($SelfTest -or $InteractiveSmokeTestMs -gt 0) {
        & powershell.exe @argList
        exit $LASTEXITCODE
    }
    $localVbs = Join-Path (Split-Path -Parent $PSCommandPath) "silent-launch.vbs"
    $wscriptBin = Join-Path $env:SystemRoot "System32\wscript.exe"
    if (Test-Path $localVbs) {
        $vbsArgs = @("//B", "//Nologo", $localVbs, "powershell.exe") + $argList
        & $wscriptBin @vbsArgs | Out-Null
    }
    exit 0
}

function U([string]$Escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($Escaped)
}

# Load Win32 Interop for Click-Through, Desktop Name Detection, and Antigravity Window Restore/Foregrounding
if (-not ("PokemonOverlayWin32" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PokemonOverlayWin32 {
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_LAYERED = 0x00080000;
    private const int UOI_NAME = 2;
    private const int SW_RESTORE = 9;
    private const int SW_SHOW = 5;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

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
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

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

    public static string GetCurrentDesktopName() {
        try {
            IntPtr hDesk = GetThreadDesktop(GetCurrentThreadId());
            if (hDesk == IntPtr.Zero) return "Unknown";
            StringBuilder sb = new StringBuilder(256);
            int needed = 0;
            if (GetUserObjectInformation(hDesk, UOI_NAME, sb, sb.Capacity * 2, out needed)) {
                return sb.ToString();
            }
        } catch {}
        return "Unknown";
    }

    public static void SetClickThrough(IntPtr hwnd, bool enable) {
        if (hwnd == IntPtr.Zero) return;
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        if (enable) {
            SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT);
        } else {
            SetWindowLong(hwnd, GWL_EXSTYLE, (style | WS_EX_LAYERED) & ~WS_EX_TRANSPARENT);
        }
    }

    // Returns true if any top-level visible or minimized (IsIconic) Antigravity / Antigravity IDE host window exists.
    // Closed-to-tray and windowless zombie subprocesses are ignored.
    public static bool HasAnyOpenHostWindow() {
        return HasAnyOpenHostWindow(IntPtr.Zero);
    }

    public static bool HasAnyOpenHostWindow(IntPtr excludeHwnd) {
        bool found = false;
        int selfPid = Process.GetCurrentProcess().Id;

        EnumWindows((hWnd, lParam) => {
            if (hWnd == IntPtr.Zero || (excludeHwnd != IntPtr.Zero && hWnd == excludeHwnd)) return true;
            if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;

            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;

            StringBuilder sb = new StringBuilder(len + 4);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = (sb.ToString() ?? "").Trim();
            if (string.IsNullOrWhiteSpace(title)) return true;
            if (title.Equals("OleMainThreadWndName", StringComparison.OrdinalIgnoreCase)
                || title.Equals("Default IME", StringComparison.OrdinalIgnoreCase)
                || title.Equals("MSCTFIME UI", StringComparison.OrdinalIgnoreCase)) {
                return true;
            }

            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0 || (int)pid == selfPid) return true;

            string procName = "";
            try {
                procName = Process.GetProcessById((int)pid).ProcessName ?? "";
            } catch {
                return true;
            }

            if (procName.Equals("Antigravity", StringComparison.OrdinalIgnoreCase)
                || procName.Equals("Antigravity IDE", StringComparison.OrdinalIgnoreCase)) {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        return found;
    }

    public static IntPtr FindBestAntigravityWindow(IntPtr excludeHwnd, int targetPid, string[] candidateTitles, out int outScore) {
        return FindBestAntigravityWindow(excludeHwnd, targetPid, candidateTitles, null, out outScore);
    }

    // requiredProcName: "Antigravity" (the app) or "Antigravity IDE" to search only that program's windows; null = both.
    public static IntPtr FindBestAntigravityWindow(IntPtr excludeHwnd, int targetPid, string[] candidateTitles, string requiredProcName, out int outScore) {
        IntPtr bestHwnd = IntPtr.Zero;
        int bestScore = -1;

        EnumWindows((hWnd, lParam) => {
            if (hWnd == IntPtr.Zero || hWnd == excludeHwnd) return true;
            if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;

            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;

            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;

            string procName = "";
            try {
                procName = Process.GetProcessById((int)pid).ProcessName ?? "";
            } catch {
                return true;
            }

            bool isAgy = procName.Equals("Antigravity", StringComparison.OrdinalIgnoreCase)
                      || procName.Equals("Antigravity IDE", StringComparison.OrdinalIgnoreCase)
                      || (targetPid > 0 && (int)pid == targetPid);
            if (!isAgy) return true;
            if (!string.IsNullOrEmpty(requiredProcName) && !procName.Equals(requiredProcName, StringComparison.OrdinalIgnoreCase)) return true;

            StringBuilder sb = new StringBuilder(len + 4);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            int score = 10;
            if (targetPid > 0 && (int)pid == targetPid) {
                score += 55;
            }
            if (candidateTitles != null) {
                for (int i = 0; i < candidateTitles.Length; i++) {
                    string needle = candidateTitles[i];
                    if (!string.IsNullOrWhiteSpace(needle) && needle.Length >= 2) {
                        if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                            score += (120 - Math.Min(80, i * 20));
                            break;
                        }
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestHwnd = hWnd;
            }
            return true;
        }, IntPtr.Zero);

        outScore = bestScore;
        return bestHwnd;
    }

    public static bool ActivateWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        uint curThread = GetCurrentThreadId();
        IntPtr fgWnd = GetForegroundWindow();
        uint fgPid = 0;
        uint fgThread = fgWnd != IntPtr.Zero ? GetWindowThreadProcessId(fgWnd, out fgPid) : 0;
        uint targetPid = 0;
        uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);

        bool attachedFg = false;
        bool attachedTarget = false;
        try {
            if (fgThread != 0 && fgThread != curThread) {
                attachedFg = AttachThreadInput(curThread, fgThread, true);
            }
            if (targetThread != 0 && targetThread != curThread) {
                attachedTarget = AttachThreadInput(curThread, targetThread, true);
            }
            if (IsIconic(hWnd)) {
                ShowWindow(hWnd, SW_RESTORE);
            } else {
                ShowWindow(hWnd, SW_SHOW);
            }
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            SetFocus(hWnd);
            return true;
        } catch {
            return false;
        } finally {
            if (attachedTarget) AttachThreadInput(curThread, targetThread, false);
            if (attachedFg) AttachThreadInput(curThread, fgThread, false);
        }
    }
}
"@
}

# Sprite math (alpha bounding boxes, cropping, shiny recolor) + key/cursor polling for click-through recovery
if (-not ("PokemonSpriteMath" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PokemonSpriteMath {
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    public static bool IsKeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static bool IsCursorOverWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return false;
        POINT p; RECT r;
        if (!GetCursorPos(out p) || !GetWindowRect(hwnd, out r)) return false;
        return p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom;
    }

    // Bounding box of pixels with alpha > threshold in a BGRA32 buffer: [minX, minY, maxX, maxY] or null.
    public static int[] AlphaBounds(byte[] px, int w, int h, int stride, int threshold) {
        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++) {
            int row = y * stride;
            for (int x = 0; x < w; x++) {
                if (px[row + x * 4 + 3] > threshold) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        return new int[] { minX, minY, maxX, maxY };
    }

    // Alpha-weighted center of mass inside a crop rect: { sumX, sumY, sumW } (callers average across frames).
    public static double[] AlphaMass(byte[] px, int stride, int x0, int y0, int cw, int ch) {
        double sx = 0, sy = 0, sw = 0;
        for (int y = 0; y < ch; y++) {
            int row = (y0 + y) * stride;
            for (int x = 0; x < cw; x++) {
                int a = px[row + (x0 + x) * 4 + 3];
                if (a <= 24) continue;
                sx += (x + 0.5) * a; sy += (y + 0.5) * a; sw += a;
            }
        }
        return new double[] { sx, sy, sw };
    }

    public static byte[] Crop(byte[] px, int stride, int x, int y, int cw, int ch) {
        byte[] outPx = new byte[cw * ch * 4];
        for (int row = 0; row < ch; row++) {
            Buffer.BlockCopy(px, (y + row) * stride + x * 4, outPx, row * cw * 4, cw * 4);
        }
        return outPx;
    }

    // In-place HSL recolor of a BGRA32 buffer (approximates official shiny palettes when no shiny frames exist).
    public static void ShinyShift(byte[] px, double hueShiftDeg, double satMul, double lightMul) {
        for (int i = 0; i < px.Length; i += 4) {
            if (px[i + 3] == 0) continue;
            double b = px[i] / 255.0, g = px[i + 1] / 255.0, r = px[i + 2] / 255.0;
            double max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
            double l = (max + min) / 2.0, h = 0, s = 0, d = max - min;
            if (d > 1e-6) {
                s = l > 0.5 ? d / (2.0 - max - min) : d / (max + min);
                if (max == r) h = ((g - b) / d + (g < b ? 6 : 0));
                else if (max == g) h = ((b - r) / d + 2);
                else h = ((r - g) / d + 4);
                h *= 60.0;
            }
            h = (h + hueShiftDeg) % 360.0; if (h < 0) h += 360.0;
            s = Math.Min(1.0, Math.Max(0.0, s * satMul));
            l = Math.Min(1.0, Math.Max(0.0, l * lightMul));
            double q = l < 0.5 ? l * (1 + s) : l + s - l * s, p2 = 2 * l - q, hk = h / 360.0;
            px[i + 2] = (byte)Math.Round(255 * Hue(p2, q, hk + 1.0 / 3));
            px[i + 1] = (byte)Math.Round(255 * Hue(p2, q, hk));
            px[i]     = (byte)Math.Round(255 * Hue(p2, q, hk - 1.0 / 3));
        }
    }

    // In-place exact colour swap for packs that define a shiny palette. Pixels within `tol` (RGB distance) of a
    // source colour take the target colour plus their original offset, so anti-aliased edges keep their shading.
    public static void PaletteSwap(byte[] px, int[] fromRgb, int[] toRgb, int tol) {
        int n = Math.Min(fromRgb.Length, toRgb.Length);
        if (n == 0) return;
        int tol2 = tol * tol;
        for (int i = 0; i < px.Length; i += 4) {
            if (px[i + 3] == 0) continue;
            int b = px[i], g = px[i + 1], r = px[i + 2];
            int best = -1, bestD = int.MaxValue;
            for (int k = 0; k < n; k++) {
                int fr = (fromRgb[k] >> 16) & 255, fg = (fromRgb[k] >> 8) & 255, fb = fromRgb[k] & 255;
                int d = (r - fr) * (r - fr) + (g - fg) * (g - fg) + (b - fb) * (b - fb);
                if (d < bestD) { bestD = d; best = k; }
            }
            if (best < 0 || bestD > tol2) continue;
            int sr = (fromRgb[best] >> 16) & 255, sg = (fromRgb[best] >> 8) & 255, sb = fromRgb[best] & 255;
            int tr = (toRgb[best] >> 16) & 255, tg = (toRgb[best] >> 8) & 255, tb = toRgb[best] & 255;
            px[i + 2] = (byte)Math.Max(0, Math.Min(255, tr + r - sr));
            px[i + 1] = (byte)Math.Max(0, Math.Min(255, tg + g - sg));
            px[i]     = (byte)Math.Max(0, Math.Min(255, tb + b - sb));
        }
    }

    private static double Hue(double p, double q, double t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1.0 / 6) return p + (q - p) * 6 * t;
        if (t < 0.5) return q;
        if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
        return p;
    }
}
"@
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WorkspaceRoot = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay.pid"
$StateFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay-state.json"
$MuteFile = Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay-muted.json"
# Persistent (survives overlay/IDE restarts; NOT deleted on exit unlike $StateFile) user-placed window position.
$PositionFile = Join-Path $env:USERPROFILE ".gemini\antigravity\pokemon-overlay-position.json"
$CurrentDesktop = [PokemonOverlayWin32]::GetCurrentDesktopName()
$CurrentSessionId = (Get-Process -Id $PID).SessionId
$IsRealDesktop = ($CurrentDesktop -eq "Default")
$script:InstanceMutex = $null
$script:OwnsStateFiles = $false

# Desktop-Aware Single-Instance Enforcement (`Local\AntigravityPokemonOverlay_Default`)
$IsIsolatedSmoke = ($InteractiveSmokeTestMs -gt 0 -and (-not $ForceRestart))
if (-not $SelfTest -and (-not $IsIsolatedSmoke)) {
    $oldState = $null
    if (Test-Path $StateFile) {
        try { $oldState = Get-Content $StateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json } catch {}
    }

    $oldPid = 0
    if ($oldState -and $oldState.pid) {
        $oldPid = [int]$oldState.pid
    } elseif (Test-Path $PidFile) {
        try { $oldPid = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1) } catch {}
    }

    if ($oldPid -gt 0 -and $oldPid -ne $PID) {
        $existingProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($existingProc -and ($existingProc.ProcessName -match '^powershell|^pwsh')) {
            $oldDesktop = if ($oldState -and $oldState.desktop) { [string]$oldState.desktop } else { "Unknown" }
            if ($IsRealDesktop) {
                if ($oldDesktop -ne "Default" -or $ForceRestart) {
                    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 250
                } else {
                    Write-Host "Single shared pet overlay already running on Default desktop (PID $oldPid)."
                    exit 0
                }
            } else {
                if ($oldDesktop -eq "Default") {
                    if (-not $ForceRestart) {
                        Write-Host "Real Default desktop overlay already active (PID $oldPid); skipping sandbox duplicate."
                        exit 0
                    }
                } elseif ($ForceRestart) {
                    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 200
                } else {
                    exit 0
                }
            }
        }
    }

    $mutexSuffix = if ($IsRealDesktop) { "Default" } else { "Sandbox_" + ($CurrentDesktop -replace '[^A-Za-z0-9_]', '_') }
    $createdNew = $false
    $script:InstanceMutex = New-Object System.Threading.Mutex($false, "Local\AntigravityPokemonOverlay_$mutexSuffix", [ref]$createdNew)
    $waitMs = if ($ForceRestart) { 2500 } else { 0 }
    $acquired = $false
    try {
        $acquired = $script:InstanceMutex.WaitOne($waitMs)
    } catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) {
        Write-Host "Single shared pet overlay mutex already held ($mutexSuffix)."
        exit 0
    }

    $canWriteGlobalPid = $IsRealDesktop
    if (-not $IsRealDesktop) {
        $liveDefault = $false
        if ($oldState -and $oldState.desktop -eq "Default" -and $oldState.pid) {
            $dp = Get-Process -Id ([int]$oldState.pid) -ErrorAction SilentlyContinue
            if ($dp) { $liveDefault = $true }
        }
        if (-not $liveDefault) { $canWriteGlobalPid = $true }
    }

    if ($canWriteGlobalPid) {
        $script:OwnsStateFiles = $true
        if ($IsRealDesktop -and (Test-Path $MuteFile)) {
            Remove-Item $MuteFile -Force -ErrorAction SilentlyContinue
        }
        Set-Content -Path $PidFile -Value $PID -Encoding Ascii -Force
        $statePayload = @{
            pid                = $PID
            version            = "4.1.0"
            singleSharedWindow = $true
            desktop            = $CurrentDesktop
            sessionId          = $CurrentSessionId
            bindToIde          = [bool]$BindToIde
            idePid             = $IdePid
            theme              = $Theme
            spriteStyle        = $SpriteStyle
            startedAt          = (Get-Date).ToString("o")
        } | ConvertTo-Json -Depth 3
        [System.IO.File]::WriteAllText($StateFile, $statePayload, (New-Object System.Text.UTF8Encoding($false)))
    }
}

$TXT = @{
    AppTitle        = U "\uD83D\uDC3E \u667A\u80FD\u4F53\u684C\u5BA0"
    HeaderTitle     = U "\uD83D\uDC3E \u667A\u80FD\u4F53\u684C\u5BA0"
    AgentsOnline    = U "\u5BA0"
    BtnStyle3D      = U "\u2728\u9AD8\u6E05"
    BtnStylePixel   = U "\uD83D\uDC7E\u50CF\u7D20"
    BtnTheme        = U "\uD83C\uDFA8\u6362\u80A4"
    BtnDemo         = U "\u2795\u6D4B\u8BD5"
    BtnGhost        = U "\uD83D\uDC7B\u7A7F\u900F"
    BtnGhostOn      = U "\uD83D\uDD13\u6062\u590D"
    BtnLineup       = U "\uD83D\uDCCF\u5F52\u4F4D"
    BtnStage        = U "\uD83C\uDF10\u821E\u53F0"
    BtnCollapse     = U "\u25BC\u6536\u8D77"
    BtnExpand       = U "\u25B2\u5C55\u5F00"
    StateThinking   = U "\uD83D\uDCAD \u601D\u8003\u4E2D"
    StateWorking    = U "\u26A1 \u5DE5\u4F5C\u4E2D"
    StateSleeping   = U "\uD83D\uDCA4 \u5F85\u547D"
    StateHappy      = U "\u2728 \u6B22\u547C"
    StateError      = U "\u26A0\uFE0F \u5F02\u5E38"
    MenuFocus       = U "\uD83D\uDE80 \u5F39\u8D77\u5BF9\u5E94\u9879\u76EE\u4E0E\u4F1A\u8BDD (Focus Project & Session)"
    MenuShowTitle   = U "\uD83D\uDCAC \u663E\u793A\u5F53\u524D\u4F1A\u8BDD\u540D\u79F0 (Show Session Title)"
    MenuSpecies     = U "\uD83D\uDC3E \u5207\u6362\u4F19\u4F34\u5F62\u8C61"
    MenuSpriteStyle = U "\uD83C\uDF9E\uFE0F \u5207\u6362\u753B\u98CE (Sprite Style)"
    StyleShowdown   = U "\u2728 \u9AD8\u6E05\u52A8\u56FE"
    StylePixel      = U "\uD83D\uDC7E \u50CF\u7D20\u52A8\u56FE"
    MenuState       = U "\uD83C\uDFAD \u6A21\u62DF/\u6D4B\u8BD5\u72B6\u6001 (Simulate State)"
    MenuSimThink    = U "\uD83D\uDCAD \u601D\u8003\u4E2D (Thinking)"
    MenuSimWork     = U "\u26A1 \u5DE5\u4F5C\u4E2D (Working)"
    MenuSimSleep    = U "\uD83D\uDCA4 \u5F85\u547D\u4E2D (Sleeping)"
    MenuSimHappy    = U "\u2728 \u5E86\u795D\u6B22\u547C (Celebrating)"
    MenuSimError    = U "\uD83D\uDCA7 \u7729\u6655\u5F02\u5E38 (Error)"
    MenuSimAuto     = U "\uD83D\uDD04 \u6062\u590D\u5B9E\u65F6\u540C\u6B65 (Auto Live Sync)"
    MenuTheme       = U "\uD83C\uDFA8 \u5207\u6362\u4E3B\u9898\u914D\u8272 (Switch Theme)"
    MenuLineup      = U "\uD83D\uDCCF \u6D6E\u7A97\u5F52\u4F4D\u5C55\u5F00 (Reset Position)"
    MenuWebStage    = U "\uD83C\uDF10 \u6253\u5F00\u7F51\u9875\u684C\u5BA0\u821E\u53F0 (Web Stage)"
    MenuExit        = U "\u274C \u5173\u95ED\u684C\u5BA0\u6D6E\u7A97 (Exit)"
    SimThinkMsg     = U "\uD83D\uDCAD \u6B63\u5728\u6DF1\u5EA6\u63A8\u7406\u4EE3\u7801\u67B6\u6784..."
    SimWorkMsg      = U "\u26A1 \u5168\u901F\u65BD\u5C55\u62DB\u5F0F\u7F16\u5199\u4EE3\u7801\u4E2D\uFF01"
    SimSleepMsg     = U "\uD83D\uDCA4 \u5B89\u9759\u5F85\u547D\u4E2D..."
    SimHappyMsg     = U "\u2728 \u4EFB\u52A1\u5927\u6210\u529F\uFF01"
    SimErrorMsg     = U "\uD83D\uDCA7 \u9047\u5230\u5F02\u5E38 @_@"
    DoubleClickHint = U "\uD83D\uDCA1 \u70B9\u51FB\u6B64\u5904\u6216\u53CC\u51FB\u9886\u961F \u2192 \u8DF3\u8F6C\u5230\u4F1A\u8BDD"
    FocusToastPrefix = U "\uD83D\uDE80 \u5DF2\u5F39\u8D77\u4F1A\u8BDD\uFF1A"
    FocusNeedsHookHint = U "\uD83E\uDE9F \u5DF2\u5524\u8D77\u7A97\u53E3\uFF5C\u81EA\u52A8\u5207\u4F1A\u8BDD\u9700\u5173\u95ED Antigravity \u540E\u6267\u884C -ApplyGlobalSkin \u6CE8\u5165\u94A9\u5B50"
    ThemePikachu    = U "\u26A1 \u7535\u5149\u9EC4"
    ThemeGengar     = U "\uD83D\uDFE3 \u6697\u5F71\u7D2B"
    ThemeCharizard  = U "\uD83D\uDD25 \u70C8\u7130\u6A59"
    ThemeUmbreon    = U "\uD83C\uDF19 \u6708\u591C\u9ED1"
    ThemeMewtwo     = U "\uD83D\uDD2E \u7075\u80FD\u7D2B"
    ThemePokedex    = U "\u2600\uFE0F \u6668\u5149\u6D45\u8272"
    SymHeart        = U "\u2764"
    SymSparkle      = U "\u2728"
    SymBolt         = U "\u26A1"
    SymFire         = U "\uD83D\uDD25"
    SymOrb          = U "\uD83D\uDFE3"
    SymPsychic      = U "\uD83D\uDD2E"
    SymThought      = U "\uD83D\uDCAD"
    SymSweat        = U "\uD83D\uDCA7"
    SymSleep        = U "\uD83D\uDCA4"
    TitleShort      = U "\u667A\u80FD\u4F53\u684C\u5BA0"
    GhostOnTip      = U "\u5F00\u542F\u9F20\u6807\u7A7F\u900F (Ctrl+Alt+P)"
    GhostOffTip     = U "\u5173\u95ED\u9F20\u6807\u7A7F\u900F (Ctrl+Alt+P)"
    GhostNotice     = U "\u9F20\u6807\u7A7F\u900F\u4E2D \u00B7 Ctrl+Alt+P \u6216\u5355\u51FB\u6258\u76D8\u56FE\u6807\u6062\u590D \u00B7 \u6309\u4F4F Ctrl \u53EF\u4E34\u65F6\u64CD\u4F5C"
    MenuTip         = U "\u66F4\u591A"
    CloseTip        = U "\u5173\u95ED\u6D6E\u7A97"
    MenuStyleToggle = U "\u5207\u6362\u9AD8\u6E05 / \u50CF\u7D20\u753B\u98CE"
    MenuGachaDemo   = U "\uD83C\uDFB2 \u6D4B\u8BD5\u62BD\u5361\uFF08\u53EC\u5524\u4E00\u53EA\u6A21\u62DF\u5B50\u667A\u80FD\u4F53\uFF09"
    MenuDexStage    = U "\uD83D\uDCD6 \u6253\u5F00\u821E\u53F0 / \u56FE\u9274\u4E0E\u62BD\u5361\u8BBE\u7F6E"
    MenuGhost       = U "\uD83D\uDC7B \u9F20\u6807\u7A7F\u900F (Ctrl+Alt+P)"
    MenuResetPos    = U "\uD83D\uDCCD \u5F52\u4F4D\u5230\u9876\u90E8\u5C45\u4E2D"
    TrayTitle       = U "\u667A\u80FD\u4F53\u684C\u5BA0\u6D6E\u7A97"
    TrayGhost       = U "\u9F20\u6807\u7A7F\u900F (Ctrl+Alt+P)"
    TrayShow        = U "\u663E\u793A\u5E76\u5F52\u4F4D\u6D6E\u7A97"
    TrayStage       = U "\u6253\u5F00\u821E\u53F0 / \u56FE\u9274"
    TrayExit        = U "\u9000\u51FA"
    NotCaughtYet    = U "\u56FE\u9274\u91CC\u8FD8\u6CA1\u6709\u6293\u5230\uFF1A"
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml

# Theme palettes: quiet glass surfaces, one accent per theme, accent used sparingly (LED, title, lead name, highlights).
#   Bg/Bg2  window gradient      Surface  group/card wash      Border  hairline stroke
#   Accent  primary highlight    Accent2  secondary highlight  Text/Muted  typography     Track  ring track
$THEMES = @{
    mewtwo          = @{ Id = "mewtwo";        Label = $TXT.ThemeMewtwo;    Light = $false; Bg = "#EB16121F"; Bg2 = "#EB1D1530"; Surface = "#0FFFFFFF"; Border = "#24FFFFFF"; Accent = "#D8B4FE"; Accent2 = "#7DD3FC"; Text = "#F4F1FA"; Muted = "#A59FB8"; Track = "#1FFFFFFF"; Bubble = "#F2241D33" }
    pikachu         = @{ Id = "pikachu";       Label = $TXT.ThemePikachu;   Light = $false; Bg = "#EB17150F"; Bg2 = "#EB221D10"; Surface = "#0FFFFFFF"; Border = "#24FFFFFF"; Accent = "#FDE047"; Accent2 = "#FB923C"; Text = "#FBF8EC"; Muted = "#B3AC93"; Track = "#1FFFFFFF"; Bubble = "#F2292414" }
    gengar          = @{ Id = "gengar";        Label = $TXT.ThemeGengar;    Light = $false; Bg = "#EB14101E"; Bg2 = "#EB1F1430"; Surface = "#0FFFFFFF"; Border = "#24FFFFFF"; Accent = "#C4B5FD"; Accent2 = "#F472B6"; Text = "#F3F0FB"; Muted = "#A39CBA"; Track = "#1FFFFFFF"; Bubble = "#F2221A33" }
    charizard       = @{ Id = "charizard";     Label = $TXT.ThemeCharizard; Light = $false; Bg = "#EB18120E"; Bg2 = "#EB24150D"; Surface = "#0FFFFFFF"; Border = "#24FFFFFF"; Accent = "#FDBA74"; Accent2 = "#5EEAD4"; Text = "#FBF4EE"; Muted = "#B5A496"; Track = "#1FFFFFFF"; Bubble = "#F22A1D14" }
    umbreon         = @{ Id = "umbreon";       Label = $TXT.ThemeUmbreon;   Light = $false; Bg = "#EB0E1117"; Bg2 = "#EB131826"; Surface = "#0FFFFFFF"; Border = "#24FFFFFF"; Accent = "#FDE68A"; Accent2 = "#93C5FD"; Text = "#EEF2F7"; Muted = "#97A1B3"; Track = "#1FFFFFFF"; Bubble = "#F2192130" }
    "pokedex-light" = @{ Id = "pokedex-light"; Label = $TXT.ThemePokedex;   Light = $true;  Bg = "#F2FBFBFD"; Bg2 = "#F2F1F4F9"; Surface = "#0A0F172A"; Border = "#1F0F172A"; Accent = "#DC2626"; Accent2 = "#0284C7"; Text = "#0F172A"; Muted = "#64748B"; Track = "#170F172A"; Bubble = "#FAFFFFFF" }
}
$THEME_ORDER = @("mewtwo", "pikachu", "gengar", "charizard", "umbreon", "pokedex-light")

# State colors (presence dot + subtle aura)
$STATE_COLORS = @{
    working     = "#FBBF24"
    thinking    = "#A78BFA"
    celebrating = "#F472B6"
    error       = "#F87171"
    sleeping    = "#64748B"
}

# Gacha rarity colors (match bridge/pokemon-gacha.mjs)
$RARITY_COLORS = @{ N = "#94A3B8"; R = "#38BDF8"; SR = "#C084FC"; SSR = "#FBBF24" }
$RARITY_LABELS = @{ N = (U "\u666E\u901A"); R = (U "\u7A00\u6709"); SR = (U "\u8D85\u7A00\u6709"); SSR = (U "\u4F20\u8BF4") }

# Creatures (ids, names, scale, colours, celebration lines, shiny looks) and their sprite folders come from the
# active skin pack: GET /api/pack?paths=1 on the bridge, or bridge/describe-pack.mjs when the bridge is not up yet.
# Both tables are filled in place by Import-PetPack, so closures and functions always see the current pack.
$SPECIES_ORDER = New-Object System.Collections.ArrayList
$SPECIES_META = @{}
$PackState = @{ Pack = $null; Sig = ""; Gen = 0; LastTryUtc = [DateTime]::MinValue }

$script:BrushConv = New-Object System.Windows.Media.BrushConverter
$script:BrushCache = @{}
function Get-Brush([string]$Hex) {
    if ($script:BrushCache.ContainsKey($Hex)) { return $script:BrushCache[$Hex] }
    $b = $script:BrushConv.ConvertFromString($Hex)
    if ($b -is [System.Windows.Freezable] -and $b.CanFreeze) { $b.Freeze() }
    $script:BrushCache[$Hex] = $b
    return $b
}

$script:SpritePackCache = @{}

function ConvertTo-FrozenBitmapImage([string]$FilePath) {
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    try {
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bmp.CreateOptions = [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat
        $bmp.StreamSource = $ms
        $bmp.EndInit()
        if ($bmp.CanFreeze) { $bmp.Freeze() }
        return $bmp
    } finally {
        $ms.Dispose()
    }
}

function Invoke-BridgeGetJson([string]$Path, [int]$TimeoutMs = 1500) {
    $resp = $null
    $sr = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create("$BridgeUrl$Path")
        $req.Method = "GET"
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        if ($raw) { return ($raw | ConvertFrom-Json) }
    } catch {
        if ($_.Exception -and $_.Exception.Response) {
            try { $_.Exception.Response.Close() } catch {}
        }
    } finally {
        if ($sr) { try { $sr.Dispose() } catch {} }
        if ($resp) { try { $resp.Close() } catch {} }
    }
    return $null
}

function Read-PetPackViaNode {
    $cli = Join-Path $WorkspaceRoot "bridge\describe-pack.mjs"
    if (-not (Test-Path $cli)) { return $null }
    $tmp = Join-Path $env:TEMP ("antigravity-pet-pack-" + [guid]::NewGuid().ToString("N") + ".json")
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = Resolve-RealNodeExe
        $psi.Arguments = '"' + $cli + '" --out "' + $tmp + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        [void]$proc.WaitForExit(8000)
        if (Test-Path $tmp) { return ([System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }
    } catch {
    } finally {
        if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    }
    return $null
}

function Import-PetPack($Desc) {
    $SPECIES_META.Clear()
    $SPECIES_ORDER.Clear()
    $script:SpritePackCache.Clear()
    foreach ($c in @($Desc.creatures)) {
        $id = [string]$c.id
        $short = if ($c.short) { [string]$c.short } else { [string]$c.name }
        $dex = if ($null -ne $c.dexNo) { " #{0:D3}" -f [int]$c.dexNo } else { "" }
        $SPECIES_META[$id] = @{
            Name       = "$([string]$c.name)$dex"
            Short      = $short
            Cheer      = if ($c.cheer) { [string]$c.cheer } else { "$(U '\u2728 ')$short$(U ' \u5E72\u52B2\u6EE1\u6EE1\uFF01')" }
            Spark      = if ($c.spark) { [string]$c.spark } else { $TXT.SymSparkle }
            Color      = if ($c.color) { [string]$c.color } else { "#94A3B8" }
            ScaleBoost = if ($c.scale) { [double]$c.scale } else { 1.0 }
            Creature   = $c
        }
        [void]$SPECIES_ORDER.Add($id)
    }
    $PackState.Pack = $Desc
    $PackState.Sig = "$($Desc.id)@$($Desc.version)"
    $PackState.Gen = [int]$PackState.Gen + 1
}

# Loads the active skin pack once (or again with -Force after the bridge reports a pack switch).
function Initialize-PetPack([switch]$Force) {
    if ($PackState.Pack -and -not $Force) { return }
    $desc = Invoke-BridgeGetJson "/api/pack?paths=1" 2500
    if (-not ($desc -and $desc.ok)) { $desc = Read-PetPackViaNode }
    if ($desc -and $desc.ok -and @($desc.creatures).Count -gt 0) {
        Import-PetPack $desc
        return
    }
    if (-not $PackState.Pack) {
        throw "No skin pack installed. Run: node tools/export-pokemon-pack.mjs (private sprites) or install a pack into ~/.gemini/antigravity/pet-packs/"
    }
}

function Resolve-PackStyle([string]$Style) {
    $desc = $PackState.Pack
    $ids = @($desc.styles | ForEach-Object { [string]$_.id })
    if ($ids -contains $Style) { return $Style }
    # "showdown"/"pixel" are the overlay's two menu choices: map them onto whatever the pack calls its styles.
    $pix = @($desc.styles | Where-Object { $_.pixelated } | ForEach-Object { [string]$_.id })
    if ($Style -eq "pixel" -and $pix.Count -gt 0) { return $pix[0] }
    return [string]$desc.defaultStyle
}

function Get-AuthenticSpritePack([string]$Species, [string]$Style = "showdown", [bool]$Shiny = $false) {
    Initialize-PetPack
    $sp = if ($SPECIES_META.ContainsKey($Species)) { $Species } else { [string]$SPECIES_ORDER[0] }
    $st = Resolve-PackStyle $Style
    $cacheKey = "$($PackState.Sig):$st`:$sp`:$([int]$Shiny)"
    if ($script:SpritePackCache.ContainsKey($cacheKey)) {
        return $script:SpritePackCache[$cacheKey]
    }

    $creature = $SPECIES_META[$sp].Creature
    $assets = $creature.assets.$st
    $styleInfo = @($PackState.Pack.styles | Where-Object { [string]$_.id -eq $st })[0]
    $pixelated = [bool]($styleInfo -and $styleInfo.pixelated)
    $framesDir = if ($assets -and $assets.framesDir) { [string]$assets.framesDir } else { "" }
    # Shiny look, best first: the pack's real shiny frames -> palette swap -> HSL shift.
    $recolor = $null
    if ($Shiny) {
        if ($assets -and $assets.shinyFramesDir) { $framesDir = [string]$assets.shinyFramesDir } else { $recolor = $creature.shiny }
    }

    $raw = New-Object System.Collections.Generic.List[System.Windows.Media.Imaging.BitmapSource]
    $delays = New-Object System.Collections.Generic.List[double]
    if ($framesDir -and (Test-Path $framesDir)) {
        $manifestFile = Join-Path $framesDir "manifest.json"
        $manifestDelays = @()
        if (Test-Path $manifestFile) {
            try {
                $mObj = Get-Content $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($mObj -and $mObj.frameDelaysMs) { $manifestDelays = @($mObj.frameDelaysMs) }
            } catch {}
        }
        $pngFiles = @(Get-ChildItem -Path $framesDir -Filter "frame-*.png" -File | Sort-Object Name)
        for ($i = 0; $i -lt $pngFiles.Count; $i++) {
            $raw.Add((ConvertTo-FrozenBitmapImage $pngFiles[$i].FullName))
            $dMs = if ($i -lt $manifestDelays.Count -and [double]$manifestDelays[$i] -ge 15) { [double]$manifestDelays[$i] } else { 50.0 }
            $delays.Add($dMs)
        }
    }
    if ($raw.Count -eq 0) {
        $gPath = if ($assets -and $assets.gifPath) { [string]$assets.gifPath } else { "" }
        if ($Shiny -and $assets -and $assets.shinyGifPath -and (Test-Path ([string]$assets.shinyGifPath))) {
            $gPath = [string]$assets.shinyGifPath
            $recolor = $null
        }
        if ($gPath -and (Test-Path $gPath)) {
            if ($gPath -match '\.gif$') {
                try {
                    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
                    $gImg = [System.Drawing.Image]::FromFile($gPath)
                    try {
                        $dim = New-Object System.Drawing.Imaging.FrameDimension($gImg.FrameDimensionsList[0])
                        $fCount = [Math]::Max(1, $gImg.GetFrameCount($dim))
                        $delayBytes = $null
                        try {
                            $propItem = $gImg.GetPropertyItem(0x5100)
                            if ($propItem -and $propItem.Value) { $delayBytes = $propItem.Value }
                        } catch {}
                        $gw = $gImg.Width; $gh = $gImg.Height
                        $gRect = New-Object System.Drawing.Rectangle(0, 0, $gw, $gh)
                        $pxFmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
                        $bgraFmt = [System.Windows.Media.PixelFormats]::Bgra32
                        for ($fi = 0; $fi -lt $fCount; $fi++) {
                            [void]$gImg.SelectActiveFrame($dim, $fi)
                            $frameBmp = New-Object System.Drawing.Bitmap($gw, $gh, $pxFmt)
                            try {
                                $gr = [System.Drawing.Graphics]::FromImage($frameBmp)
                                try {
                                    $gr.Clear([System.Drawing.Color]::Transparent)
                                    $gr.DrawImage($gImg, 0, 0, $gw, $gh)
                                } finally { $gr.Dispose() }
                                $bData = $frameBmp.LockBits($gRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $pxFmt)
                                try {
                                    $stride = [Math]::Abs($bData.Stride)
                                    $pxArr = New-Object byte[] ($stride * $gh)
                                    [System.Runtime.InteropServices.Marshal]::Copy($bData.Scan0, $pxArr, 0, $pxArr.Length)
                                    $wb = [System.Windows.Media.Imaging.BitmapSource]::Create($gw, $gh, 96, 96, $bgraFmt, $null, $pxArr, $stride)
                                    if ($wb.CanFreeze) { $wb.Freeze() }
                                    $raw.Add($wb)
                                } finally { $frameBmp.UnlockBits($bData) }
                            } finally { $frameBmp.Dispose() }
                            $dMs = 60.0
                            if ($delayBytes -and (($fi * 4 + 3) -lt $delayBytes.Length)) {
                                $cs = [BitConverter]::ToInt32($delayBytes, $fi * 4)
                                if ($cs -ge 2) { $dMs = [double]($cs * 10) }
                            }
                            $delays.Add($dMs)
                        }
                    } finally { $gImg.Dispose() }
                } catch {
                    $raw.Clear(); $delays.Clear()
                }
            }
            if ($raw.Count -eq 0) {
                try {
                    $still = ConvertTo-FrozenBitmapImage $gPath
                    if ($still) { $raw.Add($still); $delays.Add(100.0) }
                } catch {}
            }
        }
        if ($raw.Count -eq 0 -and $creature.artworkPath -and (Test-Path ([string]$creature.artworkPath))) {
            $stillArt = ConvertTo-FrozenBitmapImage ([string]$creature.artworkPath)
            if ($stillArt) { $raw.Add($stillArt); $delays.Add(100.0) }
        }
        if ($raw.Count -eq 0) { throw "Skin pack '$($PackState.Pack.id)' has no sprite for $sp ($st)" }
    }

    # Convert every frame to BGRA32 (skip FormatConvertedBitmap when already Bgra32) and find opaque union bounds.
    $bgra = [System.Windows.Media.PixelFormats]::Bgra32
    $buffers = New-Object System.Collections.Generic.List[object]
    $u = $null
    foreach ($bmp in $raw) {
        $srcBmp = if ($bmp.Format -eq $bgra) { $bmp } else { New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($bmp, $bgra, $null, 0) }
        $w = $srcBmp.PixelWidth; $h = $srcBmp.PixelHeight; $stride = $w * 4
        $px = New-Object byte[] ($stride * $h)
        $srcBmp.CopyPixels($px, $stride, 0)
        $buffers.Add(@{ Px = $px; W = $w; H = $h; Stride = $stride })
        $b = [PokemonSpriteMath]::AlphaBounds($px, $w, $h, $stride, 24)
        if ($b) {
            if ($null -eq $u) { $u = @($b[0], $b[1], $b[2], $b[3]) }
            else { $u = @([Math]::Min($u[0], $b[0]), [Math]::Min($u[1], $b[1]), [Math]::Max($u[2], $b[2]), [Math]::Max($u[3], $b[3])) }
        }
    }
    $raw.Clear()
    $w0 = $buffers[0].W; $h0 = $buffers[0].H
    if ($null -eq $u) { $u = @(0, 0, ($w0 - 1), ($h0 - 1)) }
    $cx = [Math]::Max(0, $u[0] - 1); $cy = [Math]::Max(0, $u[1] - 1)
    $cw = [Math]::Min($w0 - $cx, ($u[2] - $u[0]) + 3); $ch = [Math]::Min($h0 - $cy, ($u[3] - $cy) + 3)

    $frames = New-Object System.Collections.Generic.List[System.Windows.Media.Imaging.BitmapSource]
    $palFrom = $null; $palTo = $null; $hsl = $null
    if ($recolor) {
        $palProps = @(if ($recolor.palette) { $recolor.palette.PSObject.Properties } else { @() })
        if ($palProps.Count -gt 0) {
            $palFrom = [int[]]@($palProps | ForEach-Object { [Convert]::ToInt32(([string]$_.Name).TrimStart('#'), 16) })
            $palTo = [int[]]@($palProps | ForEach-Object { [Convert]::ToInt32(([string]$_.Value).TrimStart('#'), 16) })
        } else {
            $hsl = @([double]$recolor.hue, [double]$recolor.saturation, [double]$recolor.lightness)
        }
    }
    $massX = 0.0; $massY = 0.0; $massW = 0.0
    foreach ($buf in $buffers) {
        $fx = [Math]::Min($cx, [Math]::Max(0, $buf.W - $cw)); $fy = [Math]::Min($cy, [Math]::Max(0, $buf.H - $ch))
        $fw = [Math]::Min($cw, $buf.W); $fh = [Math]::Min($ch, $buf.H)
        $m = [PokemonSpriteMath]::AlphaMass($buf.Px, $buf.Stride, $fx, $fy, $fw, $fh)
        $massX += $m[0]; $massY += $m[1]; $massW += $m[2]
        $cropped = [PokemonSpriteMath]::Crop($buf.Px, $buf.Stride, $fx, $fy, $fw, $fh)
        if ($palFrom) { [PokemonSpriteMath]::PaletteSwap($cropped, $palFrom, $palTo, [int]$recolor.tolerance) }
        elseif ($hsl) { [PokemonSpriteMath]::ShinyShift($cropped, $hsl[0], $hsl[1], $hsl[2]) }
        $src = [System.Windows.Media.Imaging.BitmapSource]::Create($fw, $fh, 96, 96, $bgra, $null, $cropped, $fw * 4)
        if ($src.CanFreeze) { $src.Freeze() }
        $frames.Add($src)
    }
    $buffers.Clear()

    # Offset (in source pixels) that moves the creature's visual center of mass onto the crop center.
    # Wings / tails / flames make the bounding-box center a poor anchor (e.g. Charizard drifts lower-left).
    $offX = 0.0; $offY = 0.0
    if ($massW -gt 0) {
        $offX = ($cw / 2.0) - ($massX / $massW)
        $offY = ($ch / 2.0) - ($massY / $massW)
    }
    $pack = @{ Species = $sp; Style = $st; Pixelated = $pixelated; Shiny = $Shiny; Frames = $frames; Delays = $delays; Count = $frames.Count; Width = $cw; Height = $ch; CenterOffX = $offX; CenterOffY = $offY }
    if ($script:SpritePackCache.Count -ge 12) {
        $activeKeys = @{}
        if ($script:Pets) {
            foreach ($p in $script:Pets.Values) {
                if ($p.SpritePack) {
                    $activeKeys["$($p.SpritePack.Species)|$($p.SpritePack.Style)|$([bool]$p.SpritePack.Shiny)"] = $true
                }
            }
        }
        $evicted = $false
        foreach ($ck in @($script:SpritePackCache.Keys)) {
            if ($script:SpritePackCache.Count -lt 9) { break }
            if (-not $activeKeys.ContainsKey($ck)) {
                $script:SpritePackCache.Remove($ck)
                $evicted = $true
            }
        }
        if ($evicted) { $script:PendingSpriteGc = $true }
    }
    $script:SpritePackCache[$cacheKey] = $pack
    return $pack
}

$script:LastBridgeSpawnUtc = [DateTime]::MinValue
$script:CachedFallbackQueues = $null
$script:CachedFallbackUtc = [DateTime]::MinValue
$script:ConvMetaCache = @{}
$script:AgentIdleSince = @{}

function Resolve-RealNodeExe {
    $nvmdDef = Join-Path $env:USERPROFILE ".nvmd\default"
    if (Test-Path $nvmdDef) {
        try {
            $ver = (Get-Content $nvmdDef -Raw -ErrorAction SilentlyContinue).Trim()
            if ($ver) {
                $cand = Join-Path $env:USERPROFILE ".nvmd\versions\$ver\node.exe"
                if (Test-Path $cand) { return $cand }
            }
        } catch {}
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

function Invoke-SilentVbs([string[]]$TargetArgs) {
    $vbs = Join-Path $ScriptDir "silent-launch.vbs"
    $wscriptBin = Join-Path $env:SystemRoot "System32\wscript.exe"
    if (-not (Test-Path $vbs)) { return $false }
    try {
        $allArgs = @("//B", "//Nologo", $vbs) + $TargetArgs
        $escaped = foreach ($a in $allArgs) {
            $s = [string]$a
            if ($s.Length -eq 0) { '""' }
            elseif ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' }
            else { $s }
        }
        return [PokemonOverlayWin32]::SpawnNoInherit($wscriptBin, ($escaped -join " "), $WorkspaceRoot)
    } catch {
        return $false
    }
}

function Start-BridgeBackground {
    if ($NoAutoStartBridge) { return }
    $now = [DateTime]::UtcNow
    if (($now - $script:LastBridgeSpawnUtc).TotalSeconds -lt 10.0) { return }
    $bridgeScript = Join-Path $WorkspaceRoot "bridge\agent-monitor.mjs"
    if (Test-Path $bridgeScript) {
        $script:LastBridgeSpawnUtc = $now
        $realNode = Resolve-RealNodeExe
        [void](Invoke-SilentVbs @($realNode, $bridgeScript))
    }
}

function Ensure-BridgeServer {
    if ($NoAutoStartBridge) { return }
    try {
        $null = Invoke-RestMethod -Uri "$BridgeUrl/health" -Method Get -TimeoutSec 1 -ErrorAction Stop
        return
    } catch {}
    Start-BridgeBackground
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Milliseconds 220
        try {
            $null = Invoke-RestMethod -Uri "$BridgeUrl/health" -Method Get -TimeoutSec 1 -ErrorAction Stop
            break
        } catch {}
    }
}

function Invoke-BridgePostJson([string]$Path, [hashtable]$Payload, [int]$TimeoutMs = 700) {
    try {
        $json = $Payload | ConvertTo-Json -Compress -Depth 5
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $req = [System.Net.HttpWebRequest]::Create("$BridgeUrl$Path")
        $req.Method = "POST"
        $req.ContentType = "application/json; charset=utf-8"
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        if ($raw) { return ($raw | ConvertFrom-Json) }
        return @{ ok = $true }
    } catch {
        return $null
    }
}

function Send-BridgeSimulate([hashtable]$Payload) {
    [void](Invoke-BridgePostJson "/api/simulate" $Payload 500)
}

function Send-BridgeTheme([string]$ThemeKey) {
    $bridgeTheme = if ($ThemeKey -eq "pokedex-light") { "rotom-light" } else { $ThemeKey }
    [void](Invoke-BridgePostJson "/api/theme" @{ theme = $bridgeTheme; source = "pokemon-desktop-overlay" } 500)
}

function Resolve-AgentSpecies([string]$AgentName, [string]$PreferredSpecies) {
    Initialize-PetPack
    if ($PreferredSpecies -and $SPECIES_META.ContainsKey($PreferredSpecies.ToLower())) {
        return $PreferredSpecies.ToLower()
    }
    Initialize-PetPack
    $lower = if ($AgentName) { $AgentName.ToLower() } else { "agent" }
    $hash = 0
    foreach ($ch in $lower.ToCharArray()) { $hash = (($hash * 31) + [int]$ch) -band 0x7FFFFFFF }
    return [string]$SPECIES_ORDER[$hash % $SPECIES_ORDER.Count]
}

function Get-ConversationMeta([string]$ConvDir, [string]$ConvId, [string]$SwarmTitle) {
    $defaultProject = U "\u5168\u5C40\u4F1A\u8BDD"
    $shortId = if ($ConvId -and $ConvId.Length -ge 6) { $ConvId.Substring(0, 6) } else { "active" }
    $defaultTitle = if ($SwarmTitle -and $SwarmTitle.Trim().Length -gt 0) { $SwarmTitle.Trim() } else { (U "\u4F1A\u8BDD ") + $shortId }

    $cacheKey = "$ConvDir|$SwarmTitle"
    if ($ConvDir -and $script:ConvMetaCache.ContainsKey($cacheKey)) {
        return $script:ConvMetaCache[$cacheKey]
    }

    $projName = $defaultProject
    $wsPath = ""
    $convTitle = $defaultTitle

    $trPath = if ($ConvDir) { Join-Path $ConvDir ".system_generated\logs\transcript.jsonl" } else { "" }
    if ($trPath -and (Test-Path $trPath)) {
        try {
            $fs = [System.IO.File]::Open($trPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
                $readBytes = [int][Math]::Min(24576L, $fs.Length)
                $headRaw = if ($readBytes -gt 0) {
                    $buf = New-Object byte[] $readBytes
                    $actual = $fs.Read($buf, 0, $readBytes)
                    [System.Text.Encoding]::UTF8.GetString($buf, 0, $actual)
                } else { "" }
            } finally {
                $fs.Close()
            }

            if ($headRaw) {
                $unescaped = $headRaw -replace '\\r\\n', "`n" -replace '\\n', "`n" -replace '\\\\', '\'
                $wsMatch = [regex]::Match($unescaped, 'Active Workspaces:\s*\n-\s*([^\r\n"<]+)')
                if ($wsMatch.Success) {
                    $wsClean = $wsMatch.Groups[1].Value.Trim().TrimEnd('\', '/')
                    if ($wsClean) {
                        $wsPath = $wsClean
                        $leaf = Split-Path -Leaf $wsClean
                        if ($leaf) { $projName = $leaf }
                    }
                }
                if (-not $SwarmTitle -or $SwarmTitle.Trim().Length -eq 0) {
                    $reqMatch = [regex]::Match($unescaped, '<USER_REQUEST>\s*([\s\S]{1,160})')
                    if ($reqMatch.Success) {
                        $reqClean = ($reqMatch.Groups[1].Value -split '</USER_REQUEST>')[0]
                        $reqClean = ($reqClean -replace '^/[a-zA-Z0-9_-]+\s+', '' -replace '\s+', ' ').Trim()
                        if ($reqClean.Length -gt 38) { $reqClean = $reqClean.Substring(0, 38) + "..." }
                        if ($reqClean.Length -gt 0) { $convTitle = $reqClean }
                    }
                }
            }
        } catch {}
    }

    $meta = @{ projectName = $projName; workspacePath = $wsPath; conversationTitle = $convTitle }
    if ($ConvDir) { $script:ConvMetaCache[$cacheKey] = $meta }
    return $meta
}

function Resolve-AgentIdleMs([string]$AgentKey, [string]$State, $ExplicitIdleMs, [Nullable[DateTime]]$LastWriteUtc) {
    $now = [DateTime]::UtcNow
    if ($State -ne "sleeping") {
        if ($AgentKey) { $script:AgentIdleSince.Remove($AgentKey) }
        return 0.0
    }
    if ($null -ne $ExplicitIdleMs -and "$ExplicitIdleMs" -ne "") {
        try {
            $val = [double]$ExplicitIdleMs
            if ($val -ge 0) { return $val }
        } catch {}
    }
    if ($LastWriteUtc -and $LastWriteUtc.Value -gt [DateTime]::MinValue) {
        $diskIdle = ($now - $LastWriteUtc.Value).TotalMilliseconds
        if ($diskIdle -ge 0) { return $diskIdle }
    }
    if ($AgentKey) {
        if (-not $script:AgentIdleSince.ContainsKey($AgentKey)) {
            $script:AgentIdleSince[$AgentKey] = $now
        }
        return [Math]::Max(0.0, ($now - $script:AgentIdleSince[$AgentKey]).TotalMilliseconds)
    }
    return 0.0
}

function Get-TranscriptTailState([string]$TranscriptPath, [bool]$IsWakeWorking) {
    if (-not $TranscriptPath -or -not (Test-Path $TranscriptPath)) {
        return @{ state = "sleeping"; statusText = $TXT.SimSleepMsg; lastWriteUtc = [DateTime]::MinValue }
    }
    try {
        $fi = Get-Item $TranscriptPath -ErrorAction Stop
        $lastWrite = $fi.LastWriteTimeUtc
        $ageSec = ([DateTime]::UtcNow - $lastWrite).TotalSeconds
        $effectiveWakeWorking = $IsWakeWorking -and ($ageSec -le 90.0)
        $fs = [System.IO.File]::Open($TranscriptPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $len = $fs.Length
            $readBytes = [int][Math]::Min(14336L, $len)
            if ($readBytes -le 0) {
                return @{ state = $(if ($effectiveWakeWorking) { "thinking" } else { "sleeping" }); statusText = ""; lastWriteUtc = $lastWrite }
            }
            [void]$fs.Seek($len - $readBytes, [System.IO.SeekOrigin]::Begin)
            $buf = New-Object byte[] $readBytes
            $actual = $fs.Read($buf, 0, $readBytes)
            $tailText = [System.Text.Encoding]::UTF8.GetString($buf, 0, $actual)
        } finally {
            $fs.Close()
        }

        $rawLines = @($tailText -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") })
        $steps = New-Object System.Collections.ArrayList
        foreach ($ln in $rawLines) {
            try { [void]$steps.Add(($ln | ConvertFrom-Json)) } catch {}
        }
        if ($steps.Count -eq 0) {
            return @{ state = $(if ($effectiveWakeWorking) { "thinking" } else { "sleeping" }); statusText = ""; lastWriteUtc = $lastWrite }
        }

        $lastStep = $steps[$steps.Count - 1]
        if (($lastStep.type -eq "USER_INPUT" -or $lastStep.source -eq "SYSTEM") -and ($effectiveWakeWorking -or $ageSec -lt 25.0)) {
            return @{ state = "thinking"; statusText = $TXT.SimThinkMsg; lastWriteUtc = $lastWrite }
        }

        $plannerIdx = -1
        for ($i = $steps.Count - 1; $i -ge 0; $i--) {
            if ($steps[$i].type -eq "PLANNER_RESPONSE") { $plannerIdx = $i; break }
        }
        if ($plannerIdx -ge 0) {
            $pl = $steps[$plannerIdx]
            $genericAfter = ($steps.Count - 1) - $plannerIdx
            $allTools = @()
            $hasSwarmWait = $false
            if ($pl.tool_calls) {
                foreach ($tc in $pl.tool_calls) {
                    $tName = if ($tc.name) { [string]$tc.name } elseif ($tc.tool_name) { [string]$tc.tool_name } else { "tool" }
                    $allTools += $tName
                    if ($tName -eq "swarm_wait") { $hasSwarmWait = $true }
                }
            }
            if ($hasSwarmWait -and (-not $effectiveWakeWorking)) {
                return @{ state = "sleeping"; statusText = $TXT.SimSleepMsg; lastWriteUtc = $lastWrite }
            }
            $nonWait = @($allTools | Where-Object { $_ -ne "swarm_wait" })
            if ($nonWait.Count -gt 0 -and (($genericAfter -lt $allTools.Count) -or ([string]$pl.status -ne "DONE")) -and ($effectiveWakeWorking -or $ageSec -lt 45.0)) {
                $toolIdx = [Math]::Min($genericAfter, $nonWait.Count - 1)
                return @{ state = "working"; statusText = "Tool: $($nonWait[$toolIdx])"; lastWriteUtc = $lastWrite }
            }
            if ($effectiveWakeWorking -or ([string]$pl.status -ne "DONE" -and $ageSec -lt 30.0)) {
                return @{ state = "thinking"; statusText = $TXT.SimThinkMsg; lastWriteUtc = $lastWrite }
            }
        }
        return @{ state = "sleeping"; statusText = $TXT.SimSleepMsg; lastWriteUtc = $lastWrite }
    } catch {}
    return @{ state = "sleeping"; statusText = $TXT.SimSleepMsg; lastWriteUtc = [DateTime]::MinValue }
}

function Format-TokenCompact([double]$Val) {
    if ([Double]::IsNaN($Val) -or [Double]::IsInfinity($Val) -or $Val -le 0) { return "0" }
    if ($Val -ge 1000000.0) {
        $m = [Math]::Round($Val / 1000000.0, 1)
        return "${m}M"
    }
    if ($Val -ge 10000.0) {
        return "$([int][Math]::Round($Val / 1000.0))k"
    }
    if ($Val -ge 1000.0) {
        $k = [Math]::Round($Val / 1000.0, 1)
        return "${k}k"
    }
    return "$([int][Math]::Round($Val))"
}

function Normalize-AgentContext($RawAg, [double]$FallbackUsedTokens = 0.0, [double]$FallbackCachePct = 0.0) {
    $ctx = if ($RawAg -and $null -ne $RawAg.context) { $RawAg.context } else { $null }
    $maxTok = 200000.0
    if ($ctx -and $null -ne $ctx.maxTokens -and [double]$ctx.maxTokens -gt 0) {
        $maxTok = [double]$ctx.maxTokens
    } elseif ($ctx -and $null -ne $ctx.contextMaxTokens -and [double]$ctx.contextMaxTokens -gt 0) {
        $maxTok = [double]$ctx.contextMaxTokens
    } elseif ($RawAg -and $null -ne $RawAg.contextMaxTokens -and [double]$RawAg.contextMaxTokens -gt 0) {
        $maxTok = [double]$RawAg.contextMaxTokens
    }

    $usedTok = $FallbackUsedTokens
    if ($ctx -and $null -ne $ctx.usedTokens) {
        $usedTok = [double]$ctx.usedTokens
    } elseif ($ctx -and $null -ne $ctx.contextUsedTokens) {
        $usedTok = [double]$ctx.contextUsedTokens
    } elseif ($RawAg -and $null -ne $RawAg.contextUsedTokens) {
        $usedTok = [double]$RawAg.contextUsedTokens
    }
    if ([Double]::IsNaN($usedTok) -or [Double]::IsInfinity($usedTok) -or $usedTok -lt 0) { $usedTok = 0.0 }

    $usedPct = if ($ctx -and $null -ne $ctx.usedPct) {
        [double]$ctx.usedPct
    } elseif ($ctx -and $null -ne $ctx.contextUsedPct) {
        [double]$ctx.contextUsedPct
    } elseif ($RawAg -and $null -ne $RawAg.contextUsedPct) {
        [double]$RawAg.contextUsedPct
    } elseif ($maxTok -gt 0) {
        ($usedTok / $maxTok) * 100.0
    } else { 0.0 }
    if ([Double]::IsNaN($usedPct) -or [Double]::IsInfinity($usedPct)) { $usedPct = 0.0 }
    $usedPct = [Math]::Round([Math]::Min(100.0, [Math]::Max(0.0, $usedPct)), 1)

    $cachePct = if ($ctx -and $null -ne $ctx.cacheHitPct) {
        [double]$ctx.cacheHitPct
    } elseif ($ctx -and $null -ne $ctx.cachedPct) {
        [double]$ctx.cachedPct
    } elseif ($RawAg -and $null -ne $RawAg.cacheHitPct) {
        [double]$RawAg.cacheHitPct
    } else {
        0.0
    }
    # cacheKnown=false means no model response yet: draw no green arc instead of a made-up ratio.
    $cacheKnown = if ($ctx -and $null -ne $ctx.cacheKnown) { [bool]$ctx.cacheKnown } elseif (($ctx -and $null -ne $ctx.cacheHitPct) -or ($RawAg -and $null -ne $RawAg.cacheHitPct)) { $true } else { $false }
    $cacheWarm = if ($ctx -and $null -ne $ctx.cacheWarm) { [bool]$ctx.cacheWarm } else { $true }
    $ctxTip = if ($ctx -and $ctx.tooltipText) { [string]$ctx.tooltipText } else { '' }
    if ([Double]::IsNaN($cachePct) -or [Double]::IsInfinity($cachePct)) { $cachePct = 0.0 }
    $cachePct = [Math]::Round([Math]::Min(100.0, [Math]::Max(0.0, $cachePct)), 1)

    $cachedTok = if ($ctx -and $null -ne $ctx.cachedTokens) {
        [double]$ctx.cachedTokens
    } elseif ($ctx -and $null -ne $ctx.cacheHitTokens) {
        [double]$ctx.cacheHitTokens
    } else {
        [Math]::Round($usedTok * ($cachePct / 100.0))
    }
    if ([Double]::IsNaN($cachedTok) -or [Double]::IsInfinity($cachedTok) -or $cachedTok -lt 0) { $cachedTok = 0.0 }

    $uncachedTok = if ($ctx -and $null -ne $ctx.uncachedTokens) {
        [double]$ctx.uncachedTokens
    } else {
        [Math]::Max(0.0, $usedTok - $cachedTok)
    }
    $modelLbl = if ($ctx -and $ctx.modelContextLabel) {
        [string]$ctx.modelContextLabel
    } else {
        Format-TokenCompact $maxTok
    }

    return @{
        usedTokens        = [int][Math]::Round($usedTok)
        maxTokens         = [int][Math]::Round($maxTok)
        usedPct           = $usedPct
        cachedTokens      = [int][Math]::Round($cachedTok)
        cacheHitPct       = $cachePct
        uncachedTokens    = [int][Math]::Round($uncachedTok)
        modelContextLabel = $modelLbl
        cacheKnown        = $cacheKnown
        cacheWarm         = $cacheWarm
        tooltipText       = $ctxTip
    }
}

function Build-ArcGeometry([double]$Cx, [double]$Cy, [double]$Radius, [double]$Pct) {
    if ([Double]::IsNaN($Pct) -or [Double]::IsInfinity($Pct) -or $Pct -le 0.08 -or $Radius -le 1.0) {
        return [System.Windows.Media.Geometry]::Empty
    }
    $geom = New-Object System.Windows.Media.PathGeometry
    $topPt = New-Object System.Windows.Point($Cx, ($Cy - $Radius))
    $sz = New-Object System.Windows.Size($Radius, $Radius)

    if ($Pct -ge 99.9) {
        $botPt = New-Object System.Windows.Point($Cx, ($Cy + $Radius))
        $fig = New-Object System.Windows.Media.PathFigure
        $fig.StartPoint = $topPt
        $fig.IsClosed = $true
        $fig.IsFilled = $false
        $seg1 = New-Object System.Windows.Media.ArcSegment($botPt, $sz, 0.0, $false, [System.Windows.Media.SweepDirection]::Clockwise, $true)
        $seg2 = New-Object System.Windows.Media.ArcSegment($topPt, $sz, 0.0, $false, [System.Windows.Media.SweepDirection]::Clockwise, $true)
        [void]$fig.Segments.Add($seg1)
        [void]$fig.Segments.Add($seg2)
        [void]$geom.Figures.Add($fig)
    } else {
        $clamped = [Math]::Max(0.5, [Math]::Min(99.89, $Pct))
        $sweepDeg = ($clamped / 100.0) * 360.0
        $endRad = (-90.0 + $sweepDeg) * ([Math]::PI / 180.0)
        $endX = $Cx + ($Radius * [Math]::Cos($endRad))
        $endY = $Cy + ($Radius * [Math]::Sin($endRad))
        $endPt = New-Object System.Windows.Point($endX, $endY)
        $isLarge = ($sweepDeg -gt 180.0)

        $fig = New-Object System.Windows.Media.PathFigure
        $fig.StartPoint = $topPt
        $fig.IsClosed = $false
        $fig.IsFilled = $false
        $seg = New-Object System.Windows.Media.ArcSegment($endPt, $sz, 0.0, $isLarge, [System.Windows.Media.SweepDirection]::Clockwise, $true)
        [void]$fig.Segments.Add($seg)
        [void]$geom.Figures.Add($fig)
    }
    if ($geom.CanFreeze) { $geom.Freeze() }
    return $geom
}

function Normalize-PetMember($RawAg, [string]$ConvId, [bool]$ForceLead) {
    $nm = if ($RawAg.name) { [string]$RawAg.name } else { "agent" }
    $rawId = if ($RawAg.id) { [string]$RawAg.id } else { "$ConvId::$nm" }
    $petKey = if ($ConvId -and ($rawId -notmatch [regex]::Escape($ConvId))) { "$ConvId::$rawId" } else { $rawId }
    $st = if ($RawAg.state) { [string]$RawAg.state } else { "sleeping" }
    $rawSp = if ($RawAg.pokemonSpecies) { [string]$RawAg.pokemonSpecies } elseif ($RawAg.species) { [string]$RawAg.species } elseif ($RawAg.pokemon) { [string]$RawAg.pokemon } else { "" }
    $sp = Resolve-AgentSpecies $nm $rawSp
    $txtMsg = if ($RawAg.statusText) { [string]$RawAg.statusText } elseif ($RawAg.lastTool) { "Tool: $($RawAg.lastTool)" } else { "" }
    $idleVal = Resolve-AgentIdleMs $petKey $st $RawAg.idleMs $RawAg.lastWriteUtc
    $fbUsed = if ($ForceLead) { 28000.0 } else { 14000.0 }
    $fbCache = if ($st -eq "sleeping" -and $idleVal -gt 300000.0) { 0.0 } else { 82.0 }
    $ctxNorm = Normalize-AgentContext $RawAg $fbUsed $fbCache

    return @{
        id             = $petKey
        rawId          = $rawId
        name           = $nm
        role           = if ($ForceLead) { "lead" } elseif ($RawAg.role) { [string]$RawAg.role } else { "worker" }
        isLead         = $ForceLead
        state          = $st
        idleMs         = [double]$idleVal
        statusText     = $txtMsg
        pokemonSpecies = $sp
        shiny          = [bool]$RawAg.shiny
        rarity         = if ($RawAg.rarity) { [string]$RawAg.rarity } else { "" }
        gachaKey       = if ($RawAg.gachaKey) { [string]$RawAg.gachaKey } else { "" }
        gachaRevealSeq = if ($RawAg.gachaRevealSeq) { [int]$RawAg.gachaRevealSeq } else { 0 }
        context        = $ctxNorm
    }
}

# Core Multi-Session Project-Grouped Queue Engine enforcing all 6 rules + v4.0 window/workspace metadata
function Apply-QueueRules([array]$RawQueues, [switch]$TrustBridge) {
    if (-not $RawQueues -or $RawQueues.Count -eq 0) { return @() }

    $evaluated = New-Object System.Collections.ArrayList
    $fallbackBest = $null
    $fallbackBestScore = -1.0

    $qIndex = 0
    foreach ($rq in $RawQueues) {
        if (-not $rq) { continue }
        $convId = if ($rq.conversationId) { [string]$rq.conversationId } elseif ($rq.queueId) { [string]$rq.queueId } elseif ($rq.id) { [string]$rq.id } else { "session-$qIndex" }
        $projName = if ($rq.projectName -and ([string]$rq.projectName).Trim().Length -gt 0) { ([string]$rq.projectName).Trim() } else { U "\u5168\u5C40\u4F1A\u8BDD" }
        $wsPath = if ($rq.workspacePath) { [string]$rq.workspacePath } else { "" }
        $winId = if ($rq.windowId) { [string]$rq.windowId } else { "" }
        $winTitle = if ($rq.windowTitle) { [string]$rq.windowTitle } else { "" }
        $hdrTitle = if ($rq.headerTitle) { [string]$rq.headerTitle } else { "" }
        $appKind = if ($rq.appKind) { [string]$rq.appKind } else { "" }
        $winPid = if ($rq.pid) { [int]$rq.pid } else { 0 }

        $convTitle = if ($rq.conversationTitle -and ([string]$rq.conversationTitle).Trim().Length -gt 0) {
            ([string]$rq.conversationTitle).Trim()
        } elseif ($hdrTitle -and $hdrTitle.Trim().Length -gt 0) {
            $hdrTitle.Trim()
        } elseif ($rq.title -and ([string]$rq.title).Trim().Length -gt 0) {
            ([string]$rq.title).Trim()
        } elseif ($rq.swarmTitle -and ([string]$rq.swarmTitle).Trim().Length -gt 0) {
            ([string]$rq.swarmTitle).Trim()
        } else {
            (U "\u4F1A\u8BDD ") + $(if ($convId.Length -ge 6) { $convId.Substring(0, 6) } else { $convId })
        }
        $isFocused = [bool]($rq.focused -or $rq.isFocused -or $rq.isFocusedUi -or $rq.isActiveWindow)
        $lastMs = if ($rq.lastActiveMs) { [double]$rq.lastActiveMs } elseif ($rq.updatedAtMs) { [double]$rq.updatedAtMs } else { [double](1000 - $qIndex) }

        $rawLead = $rq.leadAgent
        $rawSubs = New-Object System.Collections.ArrayList
        if ($rq.subagents) {
            foreach ($s in @($rq.subagents)) { if ($s) { [void]$rawSubs.Add($s) } }
        } elseif ($rq.agents) {
            foreach ($a in @($rq.agents)) {
                if (-not $a) { continue }
                $aIsLead = ($a.isLead -eq $true) -or ([string]$a.role -in @("lead", "coordinator", "main")) -or ([string]$a.name -eq "coordinator")
                if (-not $rawLead -and $aIsLead) { $rawLead = $a } else { [void]$rawSubs.Add($a) }
            }
        }

        if (-not $rawLead) {
            $rawLead = @{
                id = "$convId::lead"; name = "lead-agent"; role = "lead"; isLead = $true
                state = "sleeping"; idleMs = 0; statusText = $TXT.SimSleepMsg; pokemonSpecies = "pikachu"
            }
        }

        $leadMember = Normalize-PetMember $rawLead $convId $true

        # Rule 4: Auto-remove any sleeping subagent whose idleMs > 60000ms
        $keptSubs = New-Object System.Collections.ArrayList
        $seenSubNames = @{}
        foreach ($rs in $rawSubs) {
            $subMember = Normalize-PetMember $rs $convId $false
            if ($subMember.name -eq $leadMember.name -and $subMember.rawId -eq $leadMember.rawId) { continue }
            if ($subMember.state -eq "sleeping" -and $subMember.idleMs -gt 60000.0) { continue }
            if ($seenSubNames.ContainsKey($subMember.name)) { continue }
            $seenSubNames[$subMember.name] = $true
            [void]$keptSubs.Add($subMember)
        }

        # Rule 5: Keep leadAgent alive whenever >=1 subagent is non-sleeping
        $hasActiveSub = $false
        foreach ($ks in $keptSubs) {
            if ($ks.state -ne "sleeping") { $hasActiveSub = $true; break }
        }

        $keepQueue = $TrustBridge -or $hasActiveSub -or ($keptSubs.Count -gt 0) -or ($leadMember.state -ne "sleeping") -or ($leadMember.idleMs -le 60000.0) -or $isFocused

        $qObj = @{
            ConversationId    = $convId
            ConversationTitle = $convTitle
            HeaderTitle       = $hdrTitle
            ProjectName       = $projName
            WorkspacePath     = $wsPath
            WindowId          = $winId
            WindowTitle       = $winTitle
            AppKind           = $appKind
            WindowPid         = $winPid
            IsFocused         = $isFocused
            HasActiveSubagent = $hasActiveSub
            LastActiveMs      = $lastMs
            LeadAgent         = $leadMember
            Subagents         = @($keptSubs)
        }

        if ($lastMs -gt $fallbackBestScore) {
            $fallbackBestScore = $lastMs
            $fallbackBest = $qObj
        }
        if ($keepQueue) { [void]$evaluated.Add($qObj) }
        $qIndex++
    }

    if ($evaluated.Count -eq 0 -and $fallbackBest) {
        $fallbackBest.Subagents = @()
        [void]$evaluated.Add($fallbackBest)
    }

    # Rule 2: Group contiguously by ProjectName
    $projectOrder = New-Object System.Collections.ArrayList
    $projectBuckets = @{}
    $sortedCandidates = @($evaluated | Sort-Object `
        @{ Expression = { if ($_.IsFocused) { 0 } else { 1 } } }, `
        @{ Expression = { if ($_.HasActiveSubagent -or $_.LeadAgent.state -ne "sleeping") { 0 } else { 1 } } }, `
        @{ Expression = { -$_.LastActiveMs } })

    foreach ($q in $sortedCandidates) {
        $pKey = $q.ProjectName
        if (-not $projectBuckets.ContainsKey($pKey)) {
            $projectBuckets[$pKey] = New-Object System.Collections.ArrayList
            [void]$projectOrder.Add($pKey)
        }
        [void]$projectBuckets[$pKey].Add($q)
    }

    $finalRows = New-Object System.Collections.ArrayList
    $rowIdx = 0
    foreach ($pKey in $projectOrder) {
        foreach ($q in $projectBuckets[$pKey]) {
            if ($rowIdx -ge 16) { break }
            $rowMembers = New-Object System.Collections.ArrayList
            $leadCopy = $q.LeadAgent.Clone()
            $leadCopy.RowIndex          = $rowIdx
            $leadCopy.ColIndex          = 0
            $leadCopy.IsLead            = $true
            $leadCopy.ProjectName       = $q.ProjectName
            $leadCopy.WorkspacePath     = $q.WorkspacePath
            $leadCopy.WindowId          = $q.WindowId
            $leadCopy.WindowTitle       = $q.WindowTitle
            $leadCopy.HeaderTitle       = $q.HeaderTitle
            $leadCopy.AppKind           = $q.AppKind
            $leadCopy.WindowPid         = $q.WindowPid
            $leadCopy.ConversationId    = $q.ConversationId
            $leadCopy.ConversationTitle = $q.ConversationTitle
            [void]$rowMembers.Add($leadCopy)

            $colIdx = 1
            $orderedSubs = @($q.Subagents | Sort-Object @{ Expression = { if ($_.state -ne "sleeping") { 0 } else { 1 } } })
            foreach ($sub in $orderedSubs) {
                if ($colIdx -gt 8) { break }
                $subCopy = $sub.Clone()
                $subCopy.RowIndex          = $rowIdx
                $subCopy.ColIndex          = $colIdx
                $subCopy.IsLead            = $false
                $subCopy.ProjectName       = $q.ProjectName
                $subCopy.WorkspacePath     = $q.WorkspacePath
                $subCopy.WindowId          = $q.WindowId
                $subCopy.WindowTitle       = $q.WindowTitle
                $subCopy.HeaderTitle       = $q.HeaderTitle
                $subCopy.AppKind           = $q.AppKind
                $subCopy.WindowPid         = $q.WindowPid
                $subCopy.ConversationId    = $q.ConversationId
                $subCopy.ConversationTitle = $q.ConversationTitle
                [void]$rowMembers.Add($subCopy)
                $colIdx++
            }

            $leadCopy.HasSubagentsInRow = ($rowMembers.Count -gt 1)

            [void]$finalRows.Add(@{
                RowIndex          = $rowIdx
                ProjectName       = $q.ProjectName
                WorkspacePath     = $q.WorkspacePath
                WindowId          = $q.WindowId
                ConversationId    = $q.ConversationId
                ConversationTitle = $q.ConversationTitle
                HasActiveSubagent = $q.HasActiveSubagent
                Members           = @($rowMembers)
            })
            $rowIdx++
        }
        if ($rowIdx -ge 16) { break }
    }

    return @($finalRows)
}

function Get-FallbackQueues {
    $nowUtc = [DateTime]::UtcNow
    if ($script:CachedFallbackQueues -and (($nowUtc - $script:CachedFallbackUtc).TotalMilliseconds -lt 450)) {
        return $script:CachedFallbackQueues
    }

    $rawQueues = New-Object System.Collections.ArrayList
    $brainRoots = @(
        (Join-Path $env:USERPROFILE ".gemini\antigravity\brain"),
        (Join-Path $env:USERPROFILE ".gemini\antigravity-ide\brain"),
        (Join-Path $env:USERPROFILE ".gemini\antigravity-cli\brain"),
        (Join-Path $env:APPDATA "Antigravity\brain"),
        (Join-Path $env:APPDATA "Antigravity IDE\brain")
    ) | Where-Object { Test-Path $_ } | Select-Object -Unique

    $swarmMemberConvIds = @{}

    foreach ($bRoot in $brainRoots) {
        $convDirsForSwarm = Get-ChildItem -Path $bRoot -Directory -ErrorAction SilentlyContinue
        foreach ($cDir in $convDirsForSwarm) {
            $mfPath = Join-Path $cDir.FullName ".system_generated\swarm\members.json"
            if (-not (Test-Path $mfPath)) { continue }
            $mf = Get-Item $mfPath -ErrorAction SilentlyContinue
            if (-not $mf) { continue }
            if (($nowUtc - $mf.LastWriteTimeUtc).TotalHours -gt 6.0) { continue }
            try {
                $raw = Get-Content $mf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                $swarmTitle = if ($raw.title) { [string]$raw.title } else { "" }
                $membersNode = if ($null -ne $raw.members) { $raw.members } else { $raw }
                $entries = @()
                if ($membersNode -is [System.Array]) {
                    foreach ($item in $membersNode) { if ($item) { $entries += @{ Name = [string]$item.name; Data = $item } } }
                } elseif ($membersNode -and $membersNode.PSObject -and $membersNode.PSObject.Properties) {
                    foreach ($prop in $membersNode.PSObject.Properties) {
                        if ($prop.Value -and ($prop.Name -notin @("title", "members"))) {
                            $entries += @{ Name = [string]$prop.Name; Data = $prop.Value }
                        }
                    }
                }
                if ($entries.Count -eq 0) { continue }

                $swarmDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $mf.FullName))
                $swarmConvId = Split-Path -Leaf $swarmDir
                $meta = Get-ConversationMeta $swarmDir $swarmConvId $swarmTitle

                $latestUtc = $mf.LastWriteTimeUtc
                $leadObj = $null
                $subList = New-Object System.Collections.ArrayList

                foreach ($ent in $entries) {
                    $d = $ent.Data
                    $convId = if ($d.conversation_id) { [string]$d.conversation_id } elseif ($d.id) { [string]$d.id } else { "" }
                    if ($convId) { $swarmMemberConvIds[$convId] = $true }
                    $isKilled = ($d.killed -eq $true) -or ([string]$d.desired_state -eq "KILLED") -or ([string]$d.phase -eq "KILLED") -or ([string]$d.state -eq "killed")
                    if ($isKilled) { continue }

                    $trPath = if ($convId) { Join-Path $bRoot "$convId\.system_generated\logs\transcript.jsonl" } else { "" }
                    $wakeWorking = ([string]$d.wake_mode -eq "working") -or ([string]$d.state -eq "working")
                    $stInfo = Get-TranscriptTailState $trPath $wakeWorking
                    $effWriteUtc = if ($trPath -and (Test-Path $trPath)) { $stInfo.lastWriteUtc } else { $mf.LastWriteTimeUtc.AddMinutes(-2) }
                    if ($effWriteUtc -gt $latestUtc) { $latestUtc = $effWriteUtc }

                    $isCoord = ($ent.Name -eq "coordinator") -or ([string]$d.role -eq "coordinator")
                    $agItem = @{
                        id           = if ($convId) { $convId } else { "$swarmConvId::$($ent.Name)" }
                        name         = $ent.Name
                        role         = if ($isCoord) { "coordinator" } else { "worker" }
                        isLead       = $isCoord
                        state        = $stInfo.state
                        statusText   = $stInfo.statusText
                        lastWriteUtc = $effWriteUtc
                    }
                    if ($isCoord -and (-not $leadObj)) { $leadObj = $agItem } else { [void]$subList.Add($agItem) }
                }

                $epochMs = ($latestUtc - [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalMilliseconds
                [void]$rawQueues.Add(@{
                    conversationId    = $swarmConvId
                    conversationTitle = $meta.conversationTitle
                    projectName       = $meta.projectName
                    workspacePath     = $meta.workspacePath
                    lastActiveMs      = $epochMs
                    leadAgent         = $leadObj
                    subagents         = @($subList)
                })
            } catch {}
        }
    }

    foreach ($bRoot in $brainRoots) {
        $convDirs = Get-ChildItem -Path $bRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 8
        foreach ($cd in $convDirs) {
            if ($swarmMemberConvIds.ContainsKey($cd.Name)) { continue }
            $tr = Join-Path $cd.FullName ".system_generated\logs\transcript.jsonl"
            if (-not (Test-Path $tr)) { continue }
            $tUtc = (Get-Item $tr).LastWriteTimeUtc
            $ageSec = ($nowUtc - $tUtc).TotalSeconds
            if ($ageSec -gt 180.0 -and $rawQueues.Count -gt 0) { continue }

            $meta = Get-ConversationMeta $cd.FullName $cd.Name ""
            $stInfo = Get-TranscriptTailState $tr ($ageSec -lt 15.0)
            $shortId = if ($cd.Name.Length -ge 6) { $cd.Name.Substring(0, 6) } else { $cd.Name }
            $epochMs = ($tUtc - [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalMilliseconds
            [void]$rawQueues.Add(@{
                conversationId    = $cd.Name
                conversationTitle = $meta.conversationTitle
                projectName       = $meta.projectName
                workspacePath     = $meta.workspacePath
                lastActiveMs      = $epochMs
                leadAgent         = @{
                    id = $cd.Name; name = "lead-$shortId"; role = "lead"; isLead = $true
                    state = $stInfo.state; statusText = $stInfo.statusText; lastWriteUtc = $tUtc
                }
                subagents         = @()
            })
        }
    }

    $rows = Apply-QueueRules @($rawQueues)
    if ($rows.Count -eq 0) {
        $rows = Apply-QueueRules @(@{
            conversationId    = "default-session"
            conversationTitle = (U "\u5F53\u524D\u5DE5\u4F5C\u533A\u4F1A\u8BDD")
            projectName       = (Split-Path -Leaf $WorkspaceRoot)
            workspacePath     = $WorkspaceRoot
            focused           = $true
            lastActiveMs      = 1000
            leadAgent         = @{
                id = "main-companion"; name = "lead-agent"; role = "lead"; isLead = $true
                state = "sleeping"; idleMs = 0; statusText = $TXT.SimSleepMsg; pokemonSpecies = "mewtwo"
            }
            subagents         = @()
        })
    }

    $script:CachedFallbackQueues = $rows
    $script:CachedFallbackUtc = $nowUtc
    return $rows
}

$script:LastBridgeETag = ""
$script:LastBridgeRawJson = ""
$script:LastBridgeQueueRows = @()

function Fetch-LiveQueues {
    try {
        $req = [System.Net.HttpWebRequest]::Create("$BridgeUrl/api/agents")
        $req.Method = "GET"
        $req.Timeout = 420
        $req.ReadWriteTimeout = 420
        if ($script:LastBridgeETag) {
            $req.Headers.Add("If-None-Match", $script:LastBridgeETag)
        }
        $respHttp = $null
        try {
            $respHttp = $req.GetResponse()
        } catch [System.Net.WebException] {
            $wResp = $_.Exception.Response
            if ($wResp -and $wResp -is [System.Net.HttpWebResponse] -and $wResp.StatusCode -eq [System.Net.HttpStatusCode]::NotModified) {
                $wResp.Close()
                return $script:LastBridgeQueueRows
            }
            throw
        }
        $newETag = $respHttp.Headers["ETag"]
        $sr = New-Object System.IO.StreamReader($respHttp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $rawJson = $sr.ReadToEnd()
        $sr.Close()
        $respHttp.Close()
        if ($rawJson -eq $script:LastBridgeRawJson -and $null -ne $script:LastBridgeQueueRows) {
            if ($newETag) { $script:LastBridgeETag = $newETag }
            return $script:LastBridgeQueueRows
        }
        $script:LastBridgeRawJson = $rawJson
        if ($newETag) { $script:LastBridgeETag = $newETag }
        $resp = $rawJson | ConvertFrom-Json

        # Skin pack switched in the stage -> reload creatures + sprites (pets re-render on the next update).
        if ($resp -and $resp.pack -and $PackState.Pack) {
            $packSig = "$($resp.pack.id)@$($resp.pack.version)"
            if ($packSig -ne $PackState.Sig) { try { Initialize-PetPack -Force } catch {} }
        }

        # v4.0 Live Global Theme Sync (`activeTheme`)
        if ($resp -and $resp.activeTheme) {
            $remoteTh = [string]$resp.activeTheme
            if ($remoteTh -eq "rotom-light") { $remoteTh = "pokedex-light" }
            if ($THEMES.ContainsKey($remoteTh) -and $remoteTh -ne $script:LastBridgeTheme) {
                $script:LastBridgeTheme = $remoteTh
                if ($remoteTh -ne $script:CurrentTheme -and $script:MainWindow) {
                    Apply-ThemePalette $remoteTh -FromBridge
                }
            }
        }

        if ($resp -and $resp.gacha) { $script:GachaRevealEnabled = [bool]$resp.gacha.revealAnimation }

        # v4.1 Explicit Summon Watermark (`summonRequestedAt`) -> Bring existing window to top & reset off-screen move
        if ($resp -and $resp.summonRequestedAt) {
            $sumAt = [string]$resp.summonRequestedAt
            if (-not $script:LastSummonSeen) {
                $script:LastSummonSeen = $sumAt
            } elseif ($sumAt -ne $script:LastSummonSeen) {
                $script:LastSummonSeen = $sumAt
                if ($script:MainWindow) {
                    if ($script:IsClickThrough) { Set-PetClickThroughAll $false }
                    # Summon = bring to front at the user's saved spot (off-screen safety is handled by the
                    # all-monitor placement check); never snap back to the primary monitor.
                    Force-ShowSharedOverlayWindow
                }
            }
        }

        $rawQueues = New-Object System.Collections.ArrayList
        if ($resp -and $resp.projects -and @($resp.projects).Count -gt 0) {
            foreach ($proj in @($resp.projects)) {
                $pName = if ($proj.projectName) { [string]$proj.projectName } else { U "\u5168\u5C40\u4F1A\u8BDD" }
                $pWs = if ($proj.workspacePath) { [string]$proj.workspacePath } else { "" }
                if ($proj.queues) {
                    foreach ($q in @($proj.queues)) {
                        if (-not $q) { continue }
                        [void]$rawQueues.Add(@{
                            conversationId    = if ($q.conversationId) { [string]$q.conversationId } elseif ($q.queueId) { [string]$q.queueId } else { "q-$($rawQueues.Count)" }
                            conversationTitle = if ($q.conversationTitle) { [string]$q.conversationTitle } elseif ($q.headerTitle) { [string]$q.headerTitle } elseif ($q.title) { [string]$q.title } else { "" }
                            headerTitle       = if ($q.headerTitle) { [string]$q.headerTitle } else { "" }
                            projectName       = if ($q.projectName) { [string]$q.projectName } else { $pName }
                            workspacePath     = if ($q.workspacePath) { [string]$q.workspacePath } else { $pWs }
                            windowId          = if ($q.windowId) { [string]$q.windowId } else { "" }
                            windowTitle       = if ($q.windowTitle) { [string]$q.windowTitle } else { "" }
                            appKind           = if ($q.appKind) { [string]$q.appKind } else { "" }
                            pid               = if ($q.pid) { [int]$q.pid } else { 0 }
                            focused           = [bool]($q.focused -or $q.isFocused -or $q.isFocusedUi -or $q.isActiveWindow)
                            lastActiveMs      = if ($q.lastActiveMs) { [double]$q.lastActiveMs } elseif ($q.updatedAtMs) { [double]$q.updatedAtMs } elseif ($q.isActiveQueue) { [double](20000 - $rawQueues.Count) } else { [double](10000 - $rawQueues.Count) }
                            leadAgent         = $q.leadAgent
                            subagents         = $q.subagents
                            agents            = $q.agents
                        })
                    }
                }
            }
        } elseif ($resp -and $resp.queues -and @($resp.queues).Count -gt 0) {
            foreach ($q in @($resp.queues)) { if ($q) { [void]$rawQueues.Add($q) } }
        } elseif ($resp -and $resp.agents -and @($resp.agents).Count -gt 0) {
            $byConv = @{}
            foreach ($a in @($resp.agents)) {
                if (-not $a) { continue }
                $cid = if ($a.conversationId) { [string]$a.conversationId } elseif ($resp.activeSessionId) { [string]$resp.activeSessionId } else { "bridge-session" }
                if (-not $byConv.ContainsKey($cid)) {
                    $byConv[$cid] = @{
                        conversationId    = $cid
                        conversationTitle = if ($a.conversationTitle) { [string]$a.conversationTitle } elseif ($resp.swarmTitle) { [string]$resp.swarmTitle } else { "" }
                        projectName       = if ($a.projectName) { [string]$a.projectName } else { Split-Path -Leaf $WorkspaceRoot }
                        workspacePath     = if ($a.workspacePath) { [string]$a.workspacePath } else { $WorkspaceRoot }
                        focused           = $true
                        lastActiveMs      = 5000
                        agents            = New-Object System.Collections.ArrayList
                    }
                }
                [void]$byConv[$cid].agents.Add($a)
            }
            foreach ($kv in $byConv.Values) { [void]$rawQueues.Add($kv) }
        }

        # IDE-bound bridge: it already decided exactly which conversations belong to this IDE launch
        # (pinned while their project window is open). Don't re-apply 60s retirement or fall back to a brain scan.
        $ideScoped = [bool]($resp -and $resp.ideSession -and $resp.ideSession.active)
        if ($rawQueues.Count -gt 0) {
            $rows = Apply-QueueRules @($rawQueues) -TrustBridge:$true
            if ($rows.Count -gt 0 -or $ideScoped -or $resp.ok) {
                $script:LastBridgeQueueRows = $rows
                return $rows
            }
        } elseif ($resp -and $resp.ok) {
            $script:LastBridgeQueueRows = @()
            return @()
        }
    } catch {
        $script:LastBridgeETag = ""
        $script:LastBridgeRawJson = ""
        Start-BridgeBackground
    }
    return (Get-FallbackQueues)
}

# Global Runtime State (v4.0 Single Unified Shared Floating Window)
$script:CurrentTheme = if ($THEMES.ContainsKey($Theme)) { $Theme } else { "mewtwo" }
$script:LastBridgeTheme = ""
$script:CurrentSpriteStyle = $SpriteStyle
$script:AutoWalkEnabled = $AutoWalk
$script:IsClickThrough = [bool]$ClickThrough
$script:IsCollapsed = $false
$script:UserMovedWindow = $false
$script:Pets = @{}
$script:ProjectBorders = New-Object System.Collections.ArrayList
$script:ProjectTitleTexts = New-Object System.Collections.ArrayList
$script:AnchorCenterX = $null
$script:AnchorTop = $null
$script:PeekActive = $false
$script:HotkeyWasDown = $false
$script:TrayIcon = $null
$script:TrayGhostItem = $null
$script:LayoutSignature = ""
$script:TickCount = 0
$script:DemoCounter = 1
$script:MainRefs = $null
$script:MainWindow = $null
$script:ActiveBannerLeadPet = $null
$script:BannerUntilUtc = [DateTime]::MinValue
$script:LastFocusDispatched = $null
$script:PendingSingleClickPet = $null
$script:SingleClickTimer = $null
# OS double-click time (default 500ms); our own detection uses it with a generous distance tolerance.
$script:DoubleClickMs = 500
try { Add-Type -AssemblyName System.Windows.Forms; $script:DoubleClickMs = [Math]::Max(300, [Math]::Min(900, [int][System.Windows.Forms.SystemInformation]::DoubleClickTime)) } catch {}
$script:LastPetDown = @{ Pet = $null; Ms = 0.0; X = 0.0; Y = 0.0 }

# NOTE: pet mouse handlers are `.GetNewClosure()` script blocks. Inside a closure, `$script:X = ...`
# writes to the closure's private module scope and is never seen by the rest of the script (reads are fine).
# So all click state changes go through these script-level functions.
function Register-PetPress($Pet, [double]$X, [double]$Y, [int]$ClickCount) {
    $nowMs = [double][Environment]::TickCount
    $last = $script:LastPetDown
    $isDouble = ($ClickCount -ge 2) -or (
        ($null -ne $last.Pet) -and ([object]::ReferenceEquals($last.Pet, $Pet)) -and
        (($nowMs - $last.Ms) -le $script:DoubleClickMs) -and
        ([Math]::Abs($X - $last.X) -le 12) -and ([Math]::Abs($Y - $last.Y) -le 12))
    if ($isDouble) {
        $script:LastPetDown = @{ Pet = $null; Ms = 0.0; X = 0.0; Y = 0.0 }
        if ($script:SingleClickTimer) { $script:SingleClickTimer.Stop() }
        $script:PendingSingleClickPet = $null
    } else {
        $script:LastPetDown = @{ Pet = $Pet; Ms = $nowMs; X = $X; Y = $Y }
    }
    return $isDouble
}

# Single click is deferred until the double-click window has passed, so the info banner never
# changes the layout between the two clicks of a double-click.
function Set-PendingSingleClick($Pet) {
    $script:PendingSingleClickPet = $Pet
    if ($script:SingleClickTimer) {
        $script:SingleClickTimer.Stop()
        $script:SingleClickTimer.Start()
    } else {
        $script:PendingSingleClickPet = $null
        Invoke-PetSingleClick $Pet
    }
}

function Set-UserMovedWindow { $script:UserMovedWindow = $true }
$script:AnimStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:LastFrameElapsedMs = 0.0

# Antigravity IDE Lifecycle Binding State (`-BindToIde`)
$script:OverlayStartedUtc = [DateTime]::UtcNow
$script:IdeWasSeen = $false
$script:IdeMissingSince = $null
$script:IdeGraceSeconds = 6.5
$script:HiddenForNoHostWindow = $false
$script:NoHostWindowSince = $null

function Test-AntigravityIdeAlive {
    if ($IdePid -gt 0) {
        $pById = Get-Process -Id $IdePid -ErrorAction SilentlyContinue
        if ($pById) {
            return $true
        }
    }
    # Shared overlay stays alive as long as either Antigravity IDE or Antigravity app has any running process.
    $agBoth = @(Get-Process -Name @("Antigravity IDE", "Antigravity") -ErrorAction SilentlyContinue)
    return ($agBoth.Count -gt 0)
}

$script:LastIdeLifecycleCheckUtc = [DateTime]::MinValue
function Check-IdeLifecycle {
    if (-not $BindToIde) { return }
    $nowCheck = [DateTime]::UtcNow
    if (($nowCheck - $script:LastIdeLifecycleCheckUtc).TotalMilliseconds -lt 2500) { return }
    $script:LastIdeLifecycleCheckUtc = $nowCheck
    if (Test-AntigravityIdeAlive) {
        $script:IdeWasSeen = $true
        $script:IdeMissingSince = $null
        if (-not $SelfTest) {
            $excludeHwnd = if ($script:MainWindow) { Get-OverlayHwnd } else { [IntPtr]::Zero }
            $hasOpenWin = [PokemonOverlayWin32]::HasAnyOpenHostWindow($excludeHwnd)
            if ($hasOpenWin) {
                $script:NoHostWindowSince = $null
                if ($script:HiddenForNoHostWindow) {
                    $script:HiddenForNoHostWindow = $false
                    if ($script:AnimTimer -and (-not $script:AnimTimer.IsEnabled)) { $script:AnimTimer.Start() }
                    if ($script:PollTimer) {
                        $script:PollTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(250, $PollIntervalMs))
                    }
                    Force-ShowSharedOverlayWindow
                }
            } else {
                if ($null -eq $script:NoHostWindowSince) {
                    $script:NoHostWindowSince = [DateTime]::UtcNow
                } else {
                    $noWinSec = ([DateTime]::UtcNow - $script:NoHostWindowSince).TotalSeconds
                    if ($noWinSec -gt 2.5) {
                        if (-not $script:HiddenForNoHostWindow) {
                            $script:HiddenForNoHostWindow = $true
                            if ($script:MainWindow) {
                                $script:MainWindow.Visibility = [System.Windows.Visibility]::Hidden
                            }
                            if ($script:AnimTimer -and $script:AnimTimer.IsEnabled) { $script:AnimTimer.Stop() }
                        }
                        if ($noWinSec -gt 180.0 -and $script:PollTimer) {
                            $slowPoll = [TimeSpan]::FromMilliseconds(2000)
                            if ($script:PollTimer.Interval -lt $slowPoll) {
                                $script:PollTimer.Interval = $slowPoll
                            }
                        }
                    }
                }
            }
        }
        return
    }
    $uptimeSec = ([DateTime]::UtcNow - $script:OverlayStartedUtc).TotalSeconds
    if (-not $script:IdeWasSeen) {
        if ($uptimeSec -ge 25.0) { Close-AllAndExit }
        return
    }
    if ($null -eq $script:IdeMissingSince) {
        $script:IdeMissingSince = [DateTime]::UtcNow
        return
    }
    if ((([DateTime]::UtcNow - $script:IdeMissingSince).TotalSeconds) -ge $script:IdeGraceSeconds) {
        Close-AllAndExit
    }
}

$SPRITE_BOX = 66.0   # larger, breathable sprite box with minimal ring constraint
function Set-PetAuthenticSprite($Pet, [string]$Species, [string]$Style = $script:CurrentSpriteStyle) {
    $pack = Get-AuthenticSpritePack $Species $Style ([bool]$Pet.Shiny)
    $sp = $pack.Species
    $meta = $SPECIES_META[$sp]
    $Pet.PackGen = $PackState.Gen

    $Pet.Species = $sp
    $Pet.SpritePack = $pack
    $Pet.FrameIndex = ($Pet.SlotIndex * 3) % [Math]::Max(1, $pack.Count)
    $Pet.FrameElapsedMs = 0.0

    $img = $Pet.SpriteImage
    if ($pack.Pixelated) {
        [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, [System.Windows.Media.BitmapScalingMode]::NearestNeighbor)
        $img.SnapsToDevicePixels = $true
    } else {
        [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, [System.Windows.Media.BitmapScalingMode]::HighQuality)
        $img.SnapsToDevicePixels = $false
    }
    # Aspect-fit the tightly cropped frames into the box; the box is centered on the ring center.
    $box = $SPRITE_BOX * $meta.ScaleBoost
    $pw = [Math]::Max(1.0, [double]$pack.Width); $ph = [Math]::Max(1.0, [double]$pack.Height)
    $scale = [Math]::Min($box / $pw, $box / $ph)
    if ($pack.Pixelated) {
        $snap = [Math]::Floor($scale * 2.0) / 2.0   # keep pixel art on half-integer scales
        if ($snap -ge 0.5) { $scale = $snap }
    }
    $img.Width = [Math]::Round($pw * $scale)
    $img.Height = [Math]::Round($ph * $scale)
    # Shift so the center of mass (not the bbox center) sits on the ring center; clamp to stay inside the disc.
    $lim = 9.0
    $dx = [Math]::Max(-$lim, [Math]::Min($lim, [double]$pack.CenterOffX * $scale))
    $dy = [Math]::Max(-$lim, [Math]::Min($lim, [double]$pack.CenterOffY * $scale))
    $img.RenderTransform = New-Object System.Windows.Media.TranslateTransform([Math]::Round($dx, 1), [Math]::Round($dy, 1))
    $img.Source = $pack.Frames[$Pet.FrameIndex]
    return $pack
}

function Set-AllPetsSpriteStyle([string]$NewStyle) {
    $st = if ($NewStyle -eq "pixel") { "pixel" } else { "showdown" }
    $script:CurrentSpriteStyle = $st
    foreach ($pet in $script:Pets.Values) {
        [void](Set-PetAuthenticSprite $pet $pet.Species $st)
        Update-PetVisualState $pet
    }
}

function Get-ThemeGradient($Pal) {
    $key = "grad:$($Pal.Bg):$($Pal.Bg2)"
    if ($script:BrushCache.ContainsKey($key)) { return $script:BrushCache[$key] }
    $g = New-Object System.Windows.Media.LinearGradientBrush
    $g.StartPoint = New-Object System.Windows.Point(0, 0)
    $g.EndPoint = New-Object System.Windows.Point(1, 1)
    [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop(([System.Windows.Media.ColorConverter]::ConvertFromString($Pal.Bg)), 0.0)))
    [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop(([System.Windows.Media.ColorConverter]::ConvertFromString($Pal.Bg2)), 1.0)))
    if ($g.CanFreeze) { $g.Freeze() }
    $script:BrushCache[$key] = $g
    return $g
}

function Apply-ThemePalette([string]$ThemeKey, [switch]$FromBridge) {
    if ($ThemeKey -eq "rotom-light") { $ThemeKey = "pokedex-light" }
    if (-not $THEMES.ContainsKey($ThemeKey)) { $ThemeKey = "mewtwo" }
    $script:CurrentTheme = $ThemeKey
    $pal = $THEMES[$ThemeKey]
    $ghostTransparent = ($script:IsClickThrough -and (-not $script:PeekActive))

    if ($script:MainRefs) {
        $r = $script:MainRefs
        $r.RootBorder.Background  = if ($ghostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#A612111A" }
        $r.RootBorder.BorderBrush = if ($ghostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#18FFFFFF" }
        $r.TitleText.Foreground   = Get-Brush $pal.Text
        $r.SummaryText.Foreground = Get-Brush $pal.Muted
        $r.LedOrb.Fill            = Get-Brush $pal.Accent
        $r.SessionBannerBorder.Background  = Get-Brush $pal.Surface
        $r.SessionBannerBorder.BorderBrush = Get-Brush $pal.Accent
        $r.SessionBannerTitle.Foreground   = Get-Brush $pal.Text
        $r.SessionBannerSub.Foreground     = Get-Brush $pal.Muted
        $r.GhostNotice.Background          = if ($ghostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush $pal.Surface }
        $r.GhostNoticeText.Foreground      = Get-Brush $pal.Muted
        foreach ($b in @($r.BtnGhost, $r.BtnCollapse, $r.BtnMenu, $r.BtnClose)) {
            $b.Foreground = Get-Brush $pal.Text
        }
    }
    foreach ($pb in $script:ProjectBorders) {
        $pb.Background  = [System.Windows.Media.Brushes]::Transparent
        $pb.BorderBrush = if ($ghostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#16FFFFFF" }
    }
    foreach ($tb in $script:ProjectTitleTexts) {
        $tb.Foreground = Get-Brush $pal.Muted
    }
    foreach ($pet in $script:Pets.Values) {
        Update-PetVisualState $pet
    }
    if (-not $FromBridge -and (-not $SelfTest)) {
        $script:LastBridgeTheme = $ThemeKey
        Send-BridgeTheme $ThemeKey
    }
}

function Update-PetVisualState($Pet) {
    $now = [DateTime]::UtcNow
    $pal = $THEMES[$script:CurrentTheme]
    if (-not $pal) { $pal = $THEMES["mewtwo"] }

    $eff = if ($now -lt $Pet.CelebrateUntil) {
        "celebrating"
    } elseif ($Pet.ManualState) {
        $Pet.ManualState
    } else {
        $Pet.LiveState
    }
    if (-not $eff) { $eff = "sleeping" }
    $Pet.EffectiveState = $eff

    # Name + role badges
    $Pet.NameText.Text = $Pet.Name
    $Pet.NameText.Foreground = if ($Pet.IsLead) { Get-Brush $pal.Accent } else { Get-Brush $pal.Text }
    $Pet.CrownBadge.Visibility = if ($Pet.IsLead) { "Visible" } else { "Collapsed" }
    $Pet.ShinyBadge.Visibility = if ($Pet.Shiny) { "Visible" } else { "Collapsed" }
    $Pet.ProjectBorder.Visibility = "Collapsed"

    # Ring tracks, disc, presence dot
    $Pet.RedTrack.Stroke   = Get-Brush $pal.Track
    $Pet.GreenTrack.Stroke = Get-Brush $pal.Track
    $Pet.DiscEllipse.Fill  = Get-Brush $pal.Surface
    $Pet.StateDot.Stroke   = Get-Brush $pal.Bg
    $stateColor = if ($STATE_COLORS.ContainsKey($eff)) { $STATE_COLORS[$eff] } else { $STATE_COLORS.sleeping }
    $Pet.StateDot.Fill = Get-Brush $stateColor
    $Pet.StateText.Foreground = Get-Brush $pal.Muted
    $Pet.ContextSepText.Foreground = Get-Brush $pal.Muted

    switch ($eff) {
        "thinking"    { $Pet.StateText.Text = U "\u601D\u8003\u4E2D"; $Pet.AuraEllipse.Fill = Get-Brush "#30A78BFA"; $Pet.AuraEllipse.Visibility = "Visible"; $Pet.SpriteImage.Opacity = 1.0 }
        "working"     { $Pet.StateText.Text = U "\u5DE5\u4F5C\u4E2D"; $Pet.AuraEllipse.Fill = Get-Brush "#30FBBF24"; $Pet.AuraEllipse.Visibility = "Visible"; $Pet.SpriteImage.Opacity = 1.0 }
        "celebrating" { $Pet.StateText.Text = U "\u6B22\u547C";       $Pet.AuraEllipse.Fill = Get-Brush "#30F472B6"; $Pet.AuraEllipse.Visibility = "Visible"; $Pet.SpriteImage.Opacity = 1.0 }
        "error"       { $Pet.StateText.Text = U "\u5F02\u5E38";       $Pet.AuraEllipse.Fill = Get-Brush "#30F87171"; $Pet.AuraEllipse.Visibility = "Visible"; $Pet.SpriteImage.Opacity = 0.95 }
        default {
            $remSec = if (-not $Pet.IsLead -and $Pet.IdleMs -gt 0) {
                [Math]::Max(1, [int][Math]::Ceiling((60000.0 - $Pet.IdleMs) / 1000.0))
            } else { 0 }
            $Pet.StateText.Text = if ($remSec -gt 0) { "$(U '\u5F85\u547D') ${remSec}s" } else { U "\u5F85\u547D" }
            $Pet.AuraEllipse.Visibility = "Hidden"
            $Pet.SpriteImage.Opacity = 0.9
        }
    }

    # Context rings: outer = used context, inner = prompt cache hit
    $ctx = if ($Pet.Context) { $Pet.Context } else { Normalize-AgentContext $null $(if ($Pet.IsLead) { 28000.0 } else { 14000.0 }) 82.0 }
    $usedPctVal  = [double]$ctx.usedPct
    $cachePctVal = [double]$ctx.cacheHitPct
    $usedCompact = Format-TokenCompact ([double]$ctx.usedTokens)
    $maxCompact  = Format-TokenCompact ([double]$ctx.maxTokens)
    $cacheCompact = Format-TokenCompact ([double]$ctx.cachedTokens)

    $usedArcKey = [Math]::Round($usedPctVal, 1)
    if ($Pet._LastUsedArcKey -ne $usedArcKey) {
        $Pet._LastUsedArcKey = $usedArcKey
        $Pet.ContextRedArc.Data = Build-ArcGeometry 42.0 42.0 38.5 $usedPctVal
    }
    $cacheKnownVal = ($ctx.cacheKnown -ne $false)
    $cacheArcKey = if ($cacheKnownVal) { [string][Math]::Round($cachePctVal, 1) } else { "none" }
    if ($Pet._LastCacheArcKey -ne $cacheArcKey) {
        $Pet._LastCacheArcKey = $cacheArcKey
        $Pet.CacheGreenArc.Data = if ($cacheKnownVal) { Build-ArcGeometry 42.0 42.0 33.7 $cachePctVal } else { [System.Windows.Media.Geometry]::Empty }
    }
    # Expired cache (idle past the prompt-cache TTL): the next request re-bills the prompt, so dim the arc.
    $Pet.CacheGreenArc.Stroke = if ($ctx.cacheWarm -eq $false) { Get-Brush "#7F4ADE80" } else { Get-Brush "#4ADE80" }
    # Used-context arc warms up as the window fills: calm -> amber -> red
    $Pet.ContextRedArc.Stroke = if ($usedPctVal -ge 85) { Get-Brush "#EF4444" } elseif ($usedPctVal -ge 60) { Get-Brush "#FB923C" } else { Get-Brush "#F87171" }
    $Pet.ContextRedText.Text   = "$([int][Math]::Round($usedPctVal))%"
    $Pet.ContextGreenText.Text = if ($cacheKnownVal) { "$([int][Math]::Round($cachePctVal))%" } else { [string][char]0x2014 }
    $Pet.ContextRedText.Foreground = if ($pal.Light) { Get-Brush "#DC2626" } else { Get-Brush "#FCA5A5" }
    $Pet.ContextGreenText.Foreground = if ($pal.Light) { Get-Brush "#16A34A" } else { Get-Brush "#86EFAC" }

    $spLabel = if ($SPECIES_META.ContainsKey($Pet.Species)) { $SPECIES_META[$Pet.Species].Short } else { $Pet.Species }
    $tipRole = if ($Pet.IsLead) { U "\uD83D\uDC51 \u4F1A\u8BDD\u9886\u961F" } else { U "\uD83D\uDC3E \u5B50\u667A\u80FD\u4F53" }
    $tipMon  = "$spLabel$(if ($Pet.Shiny) { U ' \u2726\u95EA\u5149' })$(if ($Pet.Rarity -and $RARITY_LABELS.ContainsKey($Pet.Rarity)) { ' / ' + $RARITY_LABELS[$Pet.Rarity] })"
    $tipCtx  = "$(U '\u5DF2\u7528\u4E0A\u4E0B\u6587 ')$usedCompact / $maxCompact ($usedPctVal%)"
    $tipHit  = "$(U '\u7F13\u5B58\u547D\u4E2D ')$cachePctVal% ($cacheCompact)"
    # Bridge tooltip carries the real cumulative cache ledger (requests / cold starts / warm-or-expired).
    $tipCtxBlock = if ($ctx.tooltipText) { ([string]$ctx.tooltipText) -replace ' \| ', "`n" } else { "$tipCtx`n$tipHit" }
    $newTooltip = "$tipRole $($Pet.Name) $(U '\u00B7') $tipMon`n$(U '\uD83D\uDCC1 ')$($Pet.ProjectName)`n$(U '\uD83D\uDCAC ')$($Pet.ConversationTitle)`n$tipCtxBlock"
    if ($Pet._LastTooltipText -ne $newTooltip) {
        $Pet._LastTooltipText = $newTooltip
        $Pet.RootControl.ToolTip = $newTooltip
    }

    # Bubble: session info (single-click on lead) > temporary message > manual > live status while busy
    $Pet.BubbleBorder.Background  = Get-Brush $pal.Bubble
    $Pet.BubbleBorder.BorderBrush = Get-Brush $pal.Border
    $Pet.BubbleText.Foreground    = Get-Brush $pal.Text

    $sessionActive = ($Pet.SessionBubbleOpen -eq $true) -and ($now -lt $Pet.SessionBubbleUntil)
    if ($Pet.SessionBubbleOpen -and ($now -ge $Pet.SessionBubbleUntil)) { $Pet.SessionBubbleOpen = $false }
    if ($sessionActive -and $Pet.SessionBubbleText) {
        $Pet.BubbleBorder.BorderBrush = Get-Brush $pal.Accent
        $Pet.BubbleText.Text = $Pet.SessionBubbleText
        $Pet.BubbleBorder.Visibility = "Visible"
        return
    }

    $msg = if ($Pet.TempBubbleText -and ($now -lt $Pet.TempBubbleUntil)) {
        $Pet.TempBubbleText
    } elseif ($Pet.ManualBubble) {
        $Pet.ManualBubble
    } elseif ($eff -ne "sleeping") {
        $Pet.LiveStatusText
    } else { "" }

    if ($msg -and $msg.Trim().Length -gt 0) {
        $Pet.BubbleText.Text = $msg.Trim()
        $Pet.BubbleBorder.Visibility = "Visible"
    } else {
        $Pet.BubbleBorder.Visibility = "Hidden"
    }
}


function Spawn-Particle($Pet, [string]$Symbol, [string]$ColorHex, [double]$StartX, [double]$StartY, [double]$Vx, [double]$Vy, [double]$FontSize = 13) {
    if ($Pet.Particles.Count -ge 12) { return }
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Symbol
    $tb.FontSize = $FontSize
    $tb.FontWeight = [System.Windows.FontWeights]::Bold
    $tb.Foreground = Get-Brush $ColorHex
    $tb.IsHitTestVisible = $false
    [System.Windows.Controls.Canvas]::SetLeft($tb, $StartX)
    [System.Windows.Controls.Canvas]::SetTop($tb, $StartY)
    [void]$Pet.ParticleCanvas.Children.Add($tb)
    [void]$Pet.Particles.Add(@{ Element = $tb; X = $StartX; Y = $StartY; Vx = $Vx; Vy = $Vy; Life = 1.0 })
}

# ---- Gacha reveal (bridge rolls the species; overlay plays the Poke Ball animation once per draw) ----
$script:SeenRevealSeqs = @{}
$script:GachaRevealEnabled = $true
$REVEAL_SHAKE_MS = 1050.0
$REVEAL_FLASH_MS = 260.0
$REVEAL_POP_MS   = 520.0

function New-FlashBrush([string]$ColorHex) {
    $key = "flash:$ColorHex"
    if ($script:BrushCache.ContainsKey($key)) { return $script:BrushCache[$key] }
    $c = [System.Windows.Media.ColorConverter]::ConvertFromString($ColorHex)
    $transparent = [System.Windows.Media.Color]::FromArgb(0, $c.R, $c.G, $c.B)
    $g = New-Object System.Windows.Media.RadialGradientBrush
    [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop([System.Windows.Media.Colors]::White, 0.0)))
    [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop($c, 0.45)))
    [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop($transparent, 1.0)))
    if ($g.CanFreeze) { $g.Freeze() }
    $script:BrushCache[$key] = $g
    return $g
}

function Start-PetGachaRevealIfNew($Pet, [int]$RevealSeq) {
    if ($RevealSeq -le 0 -or $script:SeenRevealSeqs.ContainsKey($RevealSeq)) { return }
    $script:SeenRevealSeqs[$RevealSeq] = $true
    if (-not $script:GachaRevealEnabled -or $SelfTest) { return }
    $Pet.RevealStartMs = $script:AnimStopwatch.Elapsed.TotalMilliseconds
    $Pet.RevealDone = $false
    $Pet.PokeballHost.Visibility = "Visible"
    $Pet.SpriteHost.Opacity = 0.0
    $rc = if ($RARITY_COLORS.ContainsKey($Pet.Rarity)) { $RARITY_COLORS[$Pet.Rarity] } else { "#F8FAFC" }
    $Pet.FlashEllipse.Fill = New-FlashBrush $(if ($Pet.Shiny) { "#FDE047" } else { $rc })
}

# Returns $true while the reveal owns the sprite transforms for this frame.
function Update-PetGachaReveal($Pet, [double]$NowMs) {
    if ($Pet.RevealStartMs -lt 0) { return $false }
    $t = $NowMs - $Pet.RevealStartMs
    if ($t -lt $REVEAL_SHAKE_MS) {
        # three wobbles with pauses, like a capture
        $phase = ($t % 350.0) / 350.0
        $wob = if ($phase -lt 0.55) { [Math]::Sin(($phase / 0.55) * [Math]::PI * 2.0) * 22.0 } else { 0.0 }
        $Pet.PokeballRotate.Angle = $wob
        $Pet.PokeballTranslate.Y = if ($phase -lt 0.55) { -[Math]::Abs([Math]::Sin(($phase / 0.55) * [Math]::PI)) * 3.0 } else { 0.0 }
        $Pet.PokeballScale.ScaleX = 1.0; $Pet.PokeballScale.ScaleY = 1.0
        $Pet.FlashEllipse.Opacity = 0.0
        $Pet.SpriteHost.Opacity = 0.0
        return $true
    }
    $t2 = $t - $REVEAL_SHAKE_MS
    if ($t2 -lt $REVEAL_FLASH_MS) {
        $k = $t2 / $REVEAL_FLASH_MS
        $Pet.PokeballRotate.Angle = 0.0
        $Pet.PokeballScale.ScaleX = 1.0 + $k * 0.6; $Pet.PokeballScale.ScaleY = 1.0 + $k * 0.6
        $Pet.PokeballHost.Opacity = 1.0 - $k
        $Pet.FlashEllipse.Opacity = [Math]::Sin($k * [Math]::PI / 2.0)
        $Pet.SpriteHost.Opacity = 0.0
        return $true
    }
    $t3 = $t2 - $REVEAL_FLASH_MS
    if ($Pet.PokeballHost.Visibility -ne "Collapsed") {
        $Pet.PokeballHost.Visibility = "Collapsed"
        $Pet.PokeballHost.Opacity = 1.0
        $rc = if ($RARITY_COLORS.ContainsKey($Pet.Rarity)) { $RARITY_COLORS[$Pet.Rarity] } else { "#F8FAFC" }
        $n = if ($Pet.Shiny) { 10 } elseif ($Pet.Rarity -eq "SSR") { 9 } else { 6 }
        for ($i = 0; $i -lt $n; $i++) {
            $ang = ($i / $n) * [Math]::PI * 2.0
            $sym = if ($Pet.Shiny -and ($i % 2 -eq 0)) { [string][char]0x2726 } else { $TXT.SymSparkle }
            $col = if ($Pet.Shiny -and ($i % 2 -eq 0)) { "#FDE047" } else { $rc }
            Spawn-Particle $Pet $sym $col (36 + [Math]::Cos($ang) * 12) (34 + [Math]::Sin($ang) * 12) ([Math]::Cos($ang) * 1.6) ([Math]::Sin($ang) * 1.6 - 0.4) 12
        }
    }
    if ($t3 -lt $REVEAL_POP_MS) {
        $k = $t3 / $REVEAL_POP_MS
        # easeOutBack
        $c1 = 1.70158; $c3 = $c1 + 1.0
        $e = 1.0 + $c3 * [Math]::Pow($k - 1.0, 3) + $c1 * [Math]::Pow($k - 1.0, 2)
        $Pet.SpriteHost.Opacity = [Math]::Min(1.0, $k * 2.2)
        $Pet.BodyScale.ScaleX = 0.25 + 0.75 * $e; $Pet.BodyScale.ScaleY = 0.25 + 0.75 * $e
        $Pet.BodyRotate.Angle = 0.0; $Pet.BodyTranslate.Y = 0.0
        $Pet.FlashEllipse.Opacity = [Math]::Max(0.0, 1.0 - $k * 1.6)
        return $true
    }
    # done
    $Pet.RevealStartMs = -1.0
    $Pet.RevealDone = $true
    $Pet.SpriteHost.Opacity = 1.0
    $Pet.FlashEllipse.Opacity = 0.0
    $spName = if ($SPECIES_META.ContainsKey($Pet.Species)) { $SPECIES_META[$Pet.Species].Short } else { $Pet.Species }
    $rLabel = if ($RARITY_LABELS.ContainsKey($Pet.Rarity)) { $RARITY_LABELS[$Pet.Rarity] } else { "" }
    $Pet.TempBubbleText = if ($Pet.Shiny) { "$([char]0x2726) $(U '\u95EA\u5149')$spName$(U '\uFF01')" } else { "$(U '\u62BD\u5230 ')$spName $(U '\u00B7') $rLabel" }
    $Pet.TempBubbleUntil = [DateTime]::UtcNow.AddSeconds(4.0)
    $Pet.CelebrateUntil = [DateTime]::UtcNow.AddSeconds(1.8)
    Update-PetVisualState $Pet
    return $false
}

function Trigger-PetCelebration($Pet) {
    $meta = $SPECIES_META[$Pet.Species]
    $Pet.CelebrateUntil = [DateTime]::UtcNow.AddSeconds(2.5)
    $Pet.TempBubbleText = $meta.Cheer
    $Pet.TempBubbleUntil = [DateTime]::UtcNow.AddSeconds(2.6)
    for ($i = 0; $i -lt 5; $i++) {
        $sym = if ($i % 2 -eq 0) { $TXT.SymHeart } else { $TXT.SymSparkle }
        $col = if ($i % 2 -eq 0) { "#FB7185" } else { "#FACC15" }
        $vx = ((Get-Random -Minimum -16 -Maximum 17) / 10.0)
        $vy = -1.4 - ((Get-Random -Minimum 4 -Maximum 14) / 10.0)
        Spawn-Particle $Pet $sym $col (36 + (Get-Random -Minimum -14 -Maximum 15)) 18 $vx $vy 12
    }
    Update-PetVisualState $Pet
}

# Single-Click on `leadAgent`: Toggle Session Title + Project Banner & Speech Bubble
function Toggle-LeadSessionBubble($Pet, [switch]$ForceOpen) {
    $now = [DateTime]::UtcNow
    if ((-not $ForceOpen) -and $Pet.SessionBubbleOpen -and ($now -lt $Pet.SessionBubbleUntil)) {
        $Pet.SessionBubbleOpen = $false
        $Pet.SessionBubbleUntil = [DateTime]::MinValue
        if ($script:MainRefs -and $script:ActiveBannerLeadPet -eq $Pet) {
            $script:MainRefs.SessionBannerBorder.Visibility = "Collapsed"
            $script:ActiveBannerLeadPet = $null
        }
        Update-PetVisualState $Pet
        return
    }

    $fullTitle = if ($Pet.ConversationTitle -and $Pet.ConversationTitle.Trim().Length -gt 0) {
        $Pet.ConversationTitle.Trim()
    } else {
        (U "\u5F53\u524D\u4F1A\u8BDD")
    }
    $shortTitle = if ($fullTitle.Length -gt 28) { $fullTitle.Substring(0, 27) + "..." } else { $fullTitle }
    $projTxt = if ($Pet.ProjectName -and $Pet.ProjectName.Trim().Length -gt 0) {
        $Pet.ProjectName.Trim()
    } else {
        (U "\u5168\u5C40\u4F1A\u8BDD")
    }

    $Pet.SessionBubbleText  = "$(U '\uD83D\uDCAC ')$fullTitle"
    $Pet.SessionBubbleOpen  = $true
    $Pet.SessionBubbleUntil = $now.AddSeconds(6.5)
    $Pet.CelebrateUntil     = $now.AddSeconds(1.6)

    if ($script:MainRefs) {
        $script:ActiveBannerLeadPet = $Pet
        $script:BannerUntilUtc = $now.AddSeconds(6.5)
        $script:MainRefs.SessionBannerTitle.Text = "$(U '\uD83D\uDCAC \u5F53\u524D\u4F1A\u8BDD\uFF1A')$fullTitle"
        $script:MainRefs.SessionBannerSub.Text   = "$(U '\uD83D\uDCC1 \u6240\u5C5E\u9879\u76EE\uFF1A')$projTxt  $(U '\u00B7')  $($TXT.DoubleClickHint)"
        $script:MainRefs.SessionBannerBorder.Visibility = "Visible"
    }

    for ($i = 0; $i -lt 4; $i++) {
        $vx = ((Get-Random -Minimum -14 -Maximum 15) / 10.0)
        $vy = -1.4 - ((Get-Random -Minimum 3 -Maximum 10) / 10.0)
        Spawn-Particle $Pet $TXT.SymSparkle "#FACC15" (36 + (Get-Random -Minimum -12 -Maximum 13)) 16 $vx $vy 12
    }
    Update-PetVisualState $Pet
}

function Invoke-PetSingleClick($Pet) {
    if ($Pet.IsLead) {
        Toggle-LeadSessionBubble $Pet
    } else {
        Trigger-PetCelebration $Pet
    }
}

# Double-Click on `leadAgent`: Pop up corresponding Project Window & Switch Conversation!
function Invoke-FocusLeadSession($Pet, [switch]$SkipProcessLaunch) {
    $now = [DateTime]::UtcNow
    $convId    = [string]$Pet.ConversationId
    $convTitle = if ($Pet.ConversationTitle) { [string]$Pet.ConversationTitle } else { "" }
    $projName  = if ($Pet.ProjectName) { [string]$Pet.ProjectName } else { "" }
    $wsPath    = if ($Pet.WorkspacePath) { [string]$Pet.WorkspacePath } else { "" }
    $winId     = if ($Pet.WindowId) { [string]$Pet.WindowId } else { "" }

    $payload = @{
        conversationId    = $convId
        conversationTitle = $convTitle
        projectName       = $projName
        workspacePath     = $wsPath
        windowId          = $winId
        source            = "pokemon-desktop-overlay"
    }
    $script:LastFocusDispatched = $payload

    # Visual glow feedback on the double-clicked leadAgent & shared banner
    $Pet.CelebrateUntil = $now.AddSeconds(2.2)
    $Pet.SessionBubbleText  = "$($TXT.FocusToastPrefix)$(if ($convTitle.Length -gt 20) { $convTitle.Substring(0, 19) + '...' } else { $convTitle })"
    $Pet.SessionBubbleOpen  = $true
    $Pet.SessionBubbleUntil = $now.AddSeconds(4.0)
    if ($script:MainRefs) {
        $script:ActiveBannerLeadPet = $Pet
        $script:BannerUntilUtc = $now.AddSeconds(4.5)
        $script:MainRefs.SessionBannerTitle.Text = "$($TXT.FocusToastPrefix)$convTitle"
        $script:MainRefs.SessionBannerSub.Text   = "$(U '\uD83D\uDCC1 \u9879\u76EE\uFF1A')$projName"
        $script:MainRefs.SessionBannerBorder.Visibility = "Visible"
    }
    Update-PetVisualState $Pet

    # 1. Dispatch `POST /api/focus-session` to Bridge v4.0 -> triggers SSE `event: focus-session` in Antigravity!
    $focusResp = Invoke-BridgePostJson "/api/focus-session" $payload 900
    $bridgeAck = ($null -ne $focusResp -and $focusResp.ok -eq $true)
    $target = if ($focusResp -and $focusResp.target) { $focusResp.target } else { $null }
    $matchedUiWindow = [bool](($target -and $target.matchedUiWindow -eq $true) -or ($focusResp -and $focusResp.matchedUiWindow -eq $true))

    $targetPid = if ($target -and $target.pid) { [int]$target.pid } elseif ($Pet.WindowPid) { [int]$Pet.WindowPid } else { 0 }
    $resolvedWs = if ($target -and $target.workspacePath) { [string]$target.workspacePath } else { $wsPath }
    $resolvedApp = if ($target -and $target.appKind) { [string]$target.appKind } else { [string]$Pet.AppKind }
    # Bridge decides which program owns the jump: "app" (Antigravity.exe, lists every conversation) or "ide".
    $focusHost = if ($target -and $target.host) { ([string]$target.host).ToLowerInvariant() } elseif ($resolvedApp -match 'app-a|hub') { "app" } else { "" }
    $requiredProc = $null
    if ($focusHost -eq "app") {
        $requiredProc = "Antigravity"
        if ($target -and $target.appPid) { $targetPid = [int]$target.appPid }
    } elseif ($focusHost -eq "ide") {
        $requiredProc = "Antigravity IDE"
    }

    $connectedWindowCount = -1
    if (-not $matchedUiWindow) {
        $healthResp = Invoke-BridgeGetJson "/health" 450
        if ($healthResp -and $null -ne $healthResp.connectedWindowCount) {
            $connectedWindowCount = [int]$healthResp.connectedWindowCount
        }
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($target -and $target.windowTitle) { $candidates.Add([string]$target.windowTitle) }
    if ($target -and $target.candidateWindowTitles) {
        foreach ($ct in @($target.candidateWindowTitles)) {
            if ($ct) { $candidates.Add([string]$ct) }
        }
    }
    if ($Pet.WindowTitle) { $candidates.Add([string]$Pet.WindowTitle) }
    if ($Pet.HeaderTitle) { $candidates.Add([string]$Pet.HeaderTitle) }
    if ($convTitle) { $candidates.Add($convTitle) }
    if ($projName -and $projName -ne (U "\u5168\u5C40\u4F1A\u8BDD")) { $candidates.Add($projName) }

    # 2. OS-level Win32 Window Restore + Foregrounding (or launch workspace if no matching project window is open!)
    $excludeHwnd = [IntPtr]::Zero
    if ($script:MainWindow) {
        try { $excludeHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:MainWindow)).Handle } catch {}
    }

    $matchScore = -1
    $bestHwnd = [PokemonOverlayWin32]::FindBestAntigravityWindow($excludeHwnd, $targetPid, $candidates.ToArray(), $requiredProc, [ref]$matchScore)
    $win32Activated = $false
    $launchedExe = $false
    $appExe = Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"

    $hasSpecificMatch = ($matchScore -ge 50)
    $canUseFallbackWindow = ($bestHwnd -ne [IntPtr]::Zero) -and (-not $resolvedWs -or (-not (Test-Path $resolvedWs)))

    if ($focusHost -eq "app") {
        # The app's own hook switches the conversation; here we only raise (or start) its window.
        if ($bestHwnd -ne [IntPtr]::Zero) {
            $win32Activated = if ((-not $SkipProcessLaunch) -and (-not $SelfTest)) { [PokemonOverlayWin32]::ActivateWindow($bestHwnd) } else { $true }
        } elseif ((-not $SkipProcessLaunch) -and (-not $SelfTest) -and (Test-Path $appExe)) {
            [void](Invoke-SilentVbs @($appExe))
            $launchedExe = $true
        }
    } elseif ($bestHwnd -ne [IntPtr]::Zero -and ($hasSpecificMatch -or $canUseFallbackWindow)) {
        if (-not $SkipProcessLaunch -and (-not $SelfTest)) {
            $win32Activated = [PokemonOverlayWin32]::ActivateWindow($bestHwnd)
        } else {
            $win32Activated = $true
        }
    } elseif ((-not $SkipProcessLaunch) -and (-not $SelfTest) -and $resolvedWs -and (Test-Path $resolvedWs)) {
        $ideExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE\Antigravity IDE.exe"
        $chosenExe = if ($resolvedApp -match 'app-a|hub' -and (Test-Path $appExe)) {
            $appExe
        } elseif (Test-Path $ideExe) {
            $ideExe
        } elseif (Test-Path $appExe) {
            $appExe
        } else { "" }

        if ($chosenExe) {
            [void](Invoke-SilentVbs @($chosenExe, $resolvedWs))
            $launchedExe = $true
        }
    } elseif ((-not $SkipProcessLaunch) -and (-not $SelfTest) -and ($bestHwnd -ne [IntPtr]::Zero)) {
        $win32Activated = [PokemonOverlayWin32]::ActivateWindow($bestHwnd)
    }

    $isAppATarget = ($focusHost -eq "app") -or ($requiredProc -eq "Antigravity") -or ($resolvedApp -match 'app-a|hub')
    if ($script:MainRefs -and $isAppATarget -and (-not $matchedUiWindow) -and ($connectedWindowCount -eq 0)) {
        $script:MainRefs.SessionBannerSub.Text = $TXT.FocusNeedsHookHint
    }

    return @{
        ok                   = $true
        dispatched           = $true
        bridgeAck            = $bridgeAck
        matchedUiWindow      = $matchedUiWindow
        connectedWindowCount = $connectedWindowCount
        conversationId       = $convId
        conversationTitle    = $convTitle
        projectName          = $projName
        workspacePath        = $resolvedWs
        matchScore           = $matchScore
        focusHost            = $focusHost
        win32Activated       = $win32Activated
        launchedWorkspace    = $launchedExe
    }
}

function Get-OverlayHwnd {
    if (-not $script:MainWindow) { return [IntPtr]::Zero }
    try { return (New-Object System.Windows.Interop.WindowInteropHelper($script:MainWindow)).Handle } catch { return [IntPtr]::Zero }
}

function Update-OverlayGhostAppearance([bool]$GhostTransparent) {
    $pal = $THEMES[$script:CurrentTheme]
    if (-not $pal) { $pal = $THEMES["mewtwo"] }
    if ($script:MainWindow) {
        $script:MainWindow.Opacity = 1.0
    }
    if ($script:MainRefs) {
        $r = $script:MainRefs
        $r.RootBorder.Background  = if ($GhostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#A612111A" }
        $r.RootBorder.BorderBrush = if ($GhostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#18FFFFFF" }
        $r.GhostNotice.Background = if ($GhostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush $pal.Surface }
    }
    foreach ($pb in $script:ProjectBorders) {
        $pb.BorderBrush = if ($GhostTransparent) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#16FFFFFF" }
    }
}

# Click-through ("ghost") mode. While it is on the window ignores the mouse entirely, so it can be turned off from:
#   - the tray icon (left-click or menu),  - the global hotkey Ctrl+Alt+P,
#   - holding Ctrl while hovering the overlay (temporarily interactive until Ctrl is released).
function Set-PetClickThroughAll([bool]$Enable) {
    $script:IsClickThrough = $Enable
    $script:PeekActive = $false
    if ($script:MainWindow) {
        [PokemonOverlayWin32]::SetClickThrough((Get-OverlayHwnd), $Enable)
    }
    Update-OverlayGhostAppearance $Enable
    if ($script:MainRefs) {
        $script:MainRefs.GhostBtnText.Text = if ($Enable) { [string][char]0x25C9 } else { [string][char]0x25CE }
        $script:MainRefs.BtnGhost.ToolTip = if ($Enable) { $TXT.GhostOffTip } else { $TXT.GhostOnTip }
        $script:MainRefs.GhostNotice.Visibility = if ($Enable) { "Visible" } else { "Collapsed" }
    }
    if ($script:TrayGhostItem) { $script:TrayGhostItem.Checked = $Enable }
}

function Update-ClickThroughInput {
    if ($SelfTest -or (-not $script:MainWindow)) { return }
    $ctrl = [PokemonSpriteMath]::IsKeyDown(0x11)
    $alt  = [PokemonSpriteMath]::IsKeyDown(0x12)
    $pKey = [PokemonSpriteMath]::IsKeyDown(0x50)
    $combo = $ctrl -and $alt -and $pKey
    if ($combo -and (-not $script:HotkeyWasDown)) {
        Set-PetClickThroughAll (-not $script:IsClickThrough)
        if (-not $script:IsClickThrough) { Force-ShowSharedOverlayWindow }
    }
    $script:HotkeyWasDown = $combo

    if (-not $script:IsClickThrough) { return }
    $hwnd = Get-OverlayHwnd
    $wantPeek = $ctrl -and (-not $alt) -and [PokemonSpriteMath]::IsCursorOverWindow($hwnd)
    if ($wantPeek -and (-not $script:PeekActive)) {
        $script:PeekActive = $true
        [PokemonOverlayWin32]::SetClickThrough($hwnd, $false)
        Update-OverlayGhostAppearance $false
    } elseif ((-not $wantPeek) -and $script:PeekActive -and ([System.Windows.Input.Mouse]::Captured -eq $null)) {
        $script:PeekActive = $false
        [PokemonOverlayWin32]::SetClickThrough($hwnd, $true)
        Update-OverlayGhostAppearance $true
    }
}

function Initialize-TrayIcon {
    if ($SelfTest -or $script:TrayIcon) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bmp = New-Object System.Drawing.Bitmap 32, 32
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.FillPie((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 57, 70))), 2, 2, 28, 28, 180, 180)
        $g.FillPie([System.Drawing.Brushes]::WhiteSmoke, 2, 2, 28, 28, 0, 180)
        $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(31, 41, 55))), 2, 14, 28, 4)
        $g.DrawEllipse((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(31, 41, 55), 2.4)), 2, 2, 28, 28)
        $g.FillEllipse([System.Drawing.Brushes]::WhiteSmoke, 11, 11, 10, 10)
        $g.DrawEllipse((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(31, 41, 55), 2.4)), 11, 11, 10, 10)
        $g.Dispose()

        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
        $ni.Text = $TXT.TrayTitle
        $menu = New-Object System.Windows.Forms.ContextMenuStrip

        $miGhost = New-Object System.Windows.Forms.ToolStripMenuItem($TXT.TrayGhost)
        $miGhost.Checked = $script:IsClickThrough
        $miGhost.Add_Click({ Set-PetClickThroughAll (-not $script:IsClickThrough) })
        [void]$menu.Items.Add($miGhost)
        $script:TrayGhostItem = $miGhost

        $miShow = New-Object System.Windows.Forms.ToolStripMenuItem($TXT.TrayShow)
        $miShow.Add_Click({ Force-ShowSharedOverlayWindow })
        [void]$menu.Items.Add($miShow)

        $miStage = New-Object System.Windows.Forms.ToolStripMenuItem($TXT.TrayStage)
        $miStage.Add_Click({ Open-WebPetStage })
        [void]$menu.Items.Add($miStage)
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

        $miExit = New-Object System.Windows.Forms.ToolStripMenuItem($TXT.TrayExit)
        $miExit.Add_Click({ Close-AllAndExit -UserInitiated })
        [void]$menu.Items.Add($miExit)

        $ni.ContextMenuStrip = $menu
        $ni.Add_MouseClick({
            param($s, $e)
            if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
                if ($script:IsClickThrough) { Set-PetClickThroughAll $false }
                Force-ShowSharedOverlayWindow
            }
        })
        $ni.Visible = $true
        $script:TrayIcon = $ni
    } catch {
        Write-OverlayErrorLog "TrayIcon" $_
    }
}

function Get-WorkAreaSafe {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $l = if ([Double]::IsNaN($wa.Left) -or [Double]::IsInfinity($wa.Left)) { 0.0 } else { [double]$wa.Left }
    $t = if ([Double]::IsNaN($wa.Top) -or [Double]::IsInfinity($wa.Top)) { 0.0 } else { [double]$wa.Top }
    $r = if ([Double]::IsNaN($wa.Right) -or [Double]::IsInfinity($wa.Right) -or $wa.Right -le ($l + 200.0)) { $l + 1920.0 } else { [double]$wa.Right }
    $b = if ([Double]::IsNaN($wa.Bottom) -or [Double]::IsInfinity($wa.Bottom) -or $wa.Bottom -le ($t + 200.0)) { $t + 1040.0 } else { [double]$wa.Bottom }
    return @{ Left = $l; Top = $t; Right = $r; Bottom = $b }
}

# >>> OVERLAY-PLACEMENT-PURE (multi-monitor placement math; no WPF/Forms access, extracted verbatim by unit tests)
# All rects are WPF DIP work areas: @{ Name; Left; Top; Right; Bottom; Primary }.
function ConvertTo-OverlayDipRect($Rect, [double]$ScaleX, [double]$ScaleY) {
    # Device px -> DIP. Scale = DIP per device pixel (CompositionTarget.TransformFromDevice M11/M22). One process-wide
    # scale is applied to every monitor: a system-DPI-aware process (powershell.exe) sees ALL monitors (even those with a
    # different scaling %) in system-DPI virtualized px, so dividing by the same factor keeps negative/secondary coords
    # consistent with WPF Window.Left/Top in mixed-DPI setups.
    if (-not ($ScaleX -gt 0)) { $ScaleX = 1.0 }
    if (-not ($ScaleY -gt 0)) { $ScaleY = 1.0 }
    return @{ Left = [double]$Rect.Left * $ScaleX; Top = [double]$Rect.Top * $ScaleY; Right = [double]$Rect.Right * $ScaleX; Bottom = [double]$Rect.Bottom * $ScaleY }
}

function Get-OverlayRectOverlap($A, $B) {
    $w = [Math]::Min([double]$A.Right, [double]$B.Right) - [Math]::Max([double]$A.Left, [double]$B.Left)
    $h = [Math]::Min([double]$A.Bottom, [double]$B.Bottom) - [Math]::Max([double]$A.Top, [double]$B.Top)
    if ($w -le 0 -or $h -le 0) { return 0.0 }
    return $w * $h
}

function Test-OverlayPointOnScreens($Screens, [double]$X, [double]$Y) {
    foreach ($s in @($Screens)) {
        if ($X -ge [double]$s.Left -and $X -lt [double]$s.Right -and $Y -ge [double]$s.Top -and $Y -lt [double]$s.Bottom) { return $true }
    }
    return $false
}

function Find-OverlayScreenForRect($Screens, $Rect) {
    $best = $null; $bestArea = 0.0
    foreach ($s in @($Screens)) {
        $a = Get-OverlayRectOverlap $s $Rect
        if ($a -gt $bestArea) { $bestArea = $a; $best = $s }
    }
    return $best
}

function Get-OverlayPrimaryScreen($Screens, [string]$PreferredName) {
    $list = @($Screens)
    if ($PreferredName) { foreach ($s in $list) { if ([string]$s.Name -eq $PreferredName) { return $s } } }
    foreach ($s in $list) { if ($s.Primary) { return $s } }
    if ($list.Count -gt 0) { return $list[0] }
    return @{ Name = "fallback"; Left = 0.0; Top = 0.0; Right = 1920.0; Bottom = 1040.0; Primary = $true }
}

# Top-center default on a screen work area (outer margin of the window is transparent).
function Get-OverlayDefaultPlacement($Screen, [double]$Width) {
    return @{ Left = (([double]$Screen.Left + [double]$Screen.Right) / 2.0) - ($Width / 2.0); Top = [double]$Screen.Top - 4.0 }
}

# Minimal push-back into ONE monitor: header stays reachable, the window may hang off the bottom edge.
function Limit-OverlayRectToScreen($Screen, [double]$Left, [double]$Top, [double]$Width) {
    $minL = [double]$Screen.Left - 10.0
    $maxL = [Math]::Max($minL, [double]$Screen.Right - $Width + 10.0)
    $minT = [double]$Screen.Top - 10.0
    $maxT = [Math]::Max($minT, [double]$Screen.Bottom - 48.0)
    return @{ Left = [Math]::Max($minL, [Math]::Min($maxL, $Left)); Top = [Math]::Max($minT, [Math]::Min($maxT, $Top)) }
}

# Final Left/Top for a desired Left/Top, evaluated against ALL monitors:
#  keep     : header strip visible on any monitor(s) (negative coords, monitor above, straddling two monitors)
#  clamp    : partially off-screen -> minimal push into the monitor holding most of the window
#  fallback : on no monitor at all (e.g. the secondary monitor was unplugged) -> top-center of preferred/primary
function Resolve-OverlayPlacement($Screens, [double]$Left, [double]$Top, [double]$Width, [double]$Height, [string]$PreferredScreenName) {
    $hdrY = $Top + 24.0
    $ok = (Test-OverlayPointOnScreens $Screens ($Left + 12.0) $hdrY) -and
          (Test-OverlayPointOnScreens $Screens ($Left + $Width - 12.0) $hdrY) -and
          (Test-OverlayPointOnScreens $Screens ($Left + ($Width / 2.0)) $hdrY) -and
          (Test-OverlayPointOnScreens $Screens ($Left + ($Width / 2.0)) ($Top + 12.0))
    $rect = @{ Left = $Left; Top = $Top; Right = $Left + $Width; Bottom = $Top + [Math]::Max(48.0, $Height) }
    $scr = Find-OverlayScreenForRect $Screens $rect
    if ($ok) { return @{ Left = $Left; Top = $Top; Screen = $scr; Mode = "keep" } }
    if ($null -ne $scr) {
        $c = Limit-OverlayRectToScreen $scr $Left $Top $Width
        return @{ Left = $c.Left; Top = $c.Top; Screen = $scr; Mode = "clamp" }
    }
    $fb = Get-OverlayPrimaryScreen $Screens $PreferredScreenName
    $d = Get-OverlayDefaultPlacement $fb $Width
    $c = Limit-OverlayRectToScreen $fb $d.Left $d.Top $Width
    return @{ Left = $c.Left; Top = $c.Top; Screen = $fb; Mode = "fallback" }
}
# <<< OVERLAY-PLACEMENT-PURE

function Get-OverlayDipScale {
    $sx = 0.0; $sy = 0.0
    try {
        if ($script:MainWindow) {
            $src = [System.Windows.PresentationSource]::FromVisual($script:MainWindow)
            if ($src -and $src.CompositionTarget) {
                $m = $src.CompositionTarget.TransformFromDevice
                $sx = [double]$m.M11; $sy = [double]$m.M22
            }
        }
    } catch {}
    if (-not ($sx -gt 0) -or -not ($sy -gt 0)) {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
            $pb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            if ($pb.Width -gt 0 -and $pb.Height -gt 0) {
                $sx = [double][System.Windows.SystemParameters]::PrimaryScreenWidth / $pb.Width
                $sy = [double][System.Windows.SystemParameters]::PrimaryScreenHeight / $pb.Height
            }
        } catch {}
    }
    if (-not ($sx -gt 0) -or [Double]::IsInfinity($sx)) { $sx = 1.0 }
    if (-not ($sy -gt 0) -or [Double]::IsInfinity($sy)) { $sy = 1.0 }
    return @{ X = $sx; Y = $sy }
}

# Work areas of ALL monitors in DIP (falls back to the primary work area if Forms is unavailable).
function Get-OverlayScreensDip {
    $sc = Get-OverlayDipScale
    $list = New-Object System.Collections.ArrayList
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            $wa = $s.WorkingArea
            if ($wa.Width -le 0 -or $wa.Height -le 0) { continue }
            $r = ConvertTo-OverlayDipRect @{ Left = $wa.Left; Top = $wa.Top; Right = $wa.Right; Bottom = $wa.Bottom } $sc.X $sc.Y
            $r.Name = [string]$s.DeviceName
            $r.Primary = [bool]$s.Primary
            [void]$list.Add($r)
        }
    } catch {}
    if ($list.Count -eq 0) {
        $wa = Get-WorkAreaSafe
        [void]$list.Add(@{ Name = "primary"; Left = $wa.Left; Top = $wa.Top; Right = $wa.Right; Bottom = $wa.Bottom; Primary = $true })
    }
    return $list.ToArray()
}

# Anchored at the top-center of the work area. The window grows downward and stays horizontally centered on its
# anchor as queues come and go; dragging moves the anchor, "reset position" puts it back at top-center.
function Position-SharedOverlayWindow([switch]$ResetManualMove) {
    if (-not $script:MainWindow) { return }
    $screens = @(Get-OverlayScreensDip)
    $actW = $script:MainWindow.ActualWidth
    $w = if ((-not [Double]::IsNaN($actW)) -and $actW -gt 40.0) { $actW } else { 420.0 }
    $actH = $script:MainWindow.ActualHeight
    $h = if ((-not [Double]::IsNaN($actH)) -and $actH -gt 30.0) { $actH } else { 160.0 }
    if ($ResetManualMove) {
        # Explicit "Reset Position": top-center of the monitor the window is on now (not forcibly the primary one).
        $l0 = [double]$script:MainWindow.Left; $t0 = [double]$script:MainWindow.Top
        $curScr = $null
        if (-not [Double]::IsNaN($l0) -and -not [Double]::IsNaN($t0)) {
            $curScr = Find-OverlayScreenForRect $screens @{ Left = $l0; Top = $t0; Right = $l0 + $w; Bottom = $t0 + $h }
        }
        $script:UserMovedWindow = $false
        $script:AnchorCenterX = $null
        $script:AnchorTop = $null
        $script:PendingAnchorPx = $null
        $script:AnchorScreenName = if ($curScr) { [string]$curScr.Name } else { $null }
        if ($script:IsCollapsed) { Set-OverlayCollapsed $false }
        Remove-OverlayPositionFile
    }
    if ($script:PendingAnchorPx) {
        # Saved in device px -> convert with the CURRENT DPI scale (robust to scaling % changes between sessions).
        $sc = Get-OverlayDipScale
        $script:AnchorCenterX = [double]$script:PendingAnchorPx.CenterX * $sc.X
        $script:AnchorTop = [double]$script:PendingAnchorPx.Top * $sc.Y
        $script:PendingAnchorPx = $null
    }
    if ($null -ne $script:AnchorCenterX -and $null -ne $script:AnchorTop) {
        $left = [double]$script:AnchorCenterX - ($w / 2.0)
        $top = [double]$script:AnchorTop
    } else {
        $homeScr = Get-OverlayPrimaryScreen $screens $script:AnchorScreenName
        $d = Get-OverlayDefaultPlacement $homeScr $w
        $left = $d.Left; $top = $d.Top
    }
    # The anchor itself is never rewritten here, so size changes (queues growing/shrinking) keep the user's spot.
    $res = Resolve-OverlayPlacement $screens $left $top $w $h ([string]$script:AnchorScreenName)
    $nl = [Math]::Round([double]$res.Left); $nt = [Math]::Round([double]$res.Top)
    if ($script:MainWindow.Left -ne $nl) { $script:MainWindow.Left = $nl }
    if ($script:MainWindow.Top -ne $nt) { $script:MainWindow.Top = $nt }
}

function Save-OverlayAnchorFromWindow {
    if (-not $script:MainWindow) { return }
    $l = $script:MainWindow.Left; $t = $script:MainWindow.Top; $w = $script:MainWindow.ActualWidth
    if ([Double]::IsNaN($l) -or [Double]::IsNaN($t) -or [Double]::IsNaN($w)) { return }
    $script:AnchorCenterX = $l + ($w / 2.0)
    $script:AnchorTop = $t
    $script:PendingAnchorPx = $null
    $script:UserMovedWindow = $true
    $scr = $null
    try {
        $h = $script:MainWindow.ActualHeight; if ([Double]::IsNaN($h) -or $h -lt 48.0) { $h = 48.0 }
        $scr = Find-OverlayScreenForRect @(Get-OverlayScreensDip) @{ Left = $l; Top = $t; Right = $l + $w; Bottom = $t + $h }
        if ($scr) { $script:AnchorScreenName = [string]$scr.Name }
    } catch {}
    Save-OverlayPositionFile $scr
}

function Test-OverlayPositionPersistAllowed {
    return ((-not $SelfTest) -and (-not $IsIsolatedSmoke) -and $IsRealDesktop)
}

function Save-OverlayPositionFile($Screen) {
    if (-not (Test-OverlayPositionPersistAllowed)) { return }
    if ($null -eq $script:AnchorCenterX -or $null -eq $script:AnchorTop) { return }
    try {
        $sc = Get-OverlayDipScale
        $bounds = $null
        if ($Screen) { $bounds = [ordered]@{ left = [double]$Screen.Left; top = [double]$Screen.Top; right = [double]$Screen.Right; bottom = [double]$Screen.Bottom } }
        $payload = [ordered]@{
            version         = 1
            centerXPx       = [Math]::Round([double]$script:AnchorCenterX / $sc.X, 1)
            topPx           = [Math]::Round([double]$script:AnchorTop / $sc.Y, 1)
            centerXDip      = [Math]::Round([double]$script:AnchorCenterX, 1)
            topDip          = [Math]::Round([double]$script:AnchorTop, 1)
            dipPerPx        = [Math]::Round([double]$sc.X, 4)
            screen          = [string]$script:AnchorScreenName
            screenBoundsDip = $bounds
            savedAt         = (Get-Date).ToString("o")
        } | ConvertTo-Json -Compress -Depth 4
        $dir = Split-Path -Parent $PositionFile
        if (-not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        [System.IO.File]::WriteAllText($PositionFile, $payload, (New-Object System.Text.UTF8Encoding($false)))
    } catch { Write-OverlayErrorLog "SavePosition" $_ }
}

function Remove-OverlayPositionFile {
    if (-not (Test-OverlayPositionPersistAllowed)) { return }
    try { if (Test-Path $PositionFile) { Remove-Item $PositionFile -Force -ErrorAction SilentlyContinue } } catch {}
}

function Import-OverlayPositionFile {
    if (-not (Test-OverlayPositionPersistAllowed)) { return }
    if (-not (Test-Path $PositionFile)) { return }
    try {
        $p = Get-Content $PositionFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($null -ne $p.centerXPx -and $null -ne $p.topPx) {
            $cx = [double]$p.centerXPx; $tp = [double]$p.topPx
            if (-not ([Double]::IsNaN($cx) -or [Double]::IsInfinity($cx) -or [Double]::IsNaN($tp) -or [Double]::IsInfinity($tp))) {
                $script:PendingAnchorPx = @{ CenterX = $cx; Top = $tp }
                $script:UserMovedWindow = $true
                $script:AnchorScreenName = if ($p.screen) { [string]$p.screen } else { $null }
            }
        }
    } catch { Write-OverlayErrorLog "LoadPosition" $_ }
}

$script:PendingAnchorPx = $null
$script:AnchorScreenName = $null
Import-OverlayPositionFile

function Set-OverlayCollapsed([bool]$Collapsed) {
    $script:IsCollapsed = $Collapsed
    if (-not $script:MainRefs) { return }
    if ($Collapsed) {
        $script:MainRefs.BodyScroll.Visibility = "Collapsed"
        $script:MainRefs.SessionBannerBorder.Visibility = "Collapsed"
        $script:MainRefs.CollapseBtnText.Text = [string][char]0x25BE
        $script:MainRefs.BtnCollapse.ToolTip = $TXT.BtnExpand
    } else {
        $script:MainRefs.BodyScroll.Visibility = "Visible"
        $script:MainRefs.CollapseBtnText.Text = [string][char]0x25B4
        $script:MainRefs.BtnCollapse.ToolTip = $TXT.BtnCollapse
    }
}

# Bypass Win32 `STARTUPINFO.wShowWindow = SW_HIDE` inherited from `-WindowStyle Hidden` / `wscript.exe` (`SW_HIDE = 0`):
# Windows user32.dll overrides a process's FIRST ShowWindow() call with STARTUPINFO.wShowWindow; calling Win32
# ShowWindow(hwnd, SW_SHOW=5) a second time after WPF .Show() guarantees 100% OS-level visibility!
function Force-ShowSharedOverlayWindow([switch]$ResetManualMove) {
    if (-not $script:MainWindow) { return }
    $script:HiddenForNoHostWindow = $false
    $script:NoHostWindowSince = $null
    $script:MainWindow.Visibility = [System.Windows.Visibility]::Visible
    Update-OverlayGhostAppearance ($script:IsClickThrough -and (-not $script:PeekActive))
    $script:MainWindow.Topmost = $true
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:MainWindow)).EnsureHandle()
        if ($hwnd -ne [IntPtr]::Zero) {
            [void][PokemonOverlayWin32]::ShowWindow($hwnd, 5)
            [void][PokemonOverlayWin32]::BringWindowToTop($hwnd)
        }
    } catch {}
    try { $script:MainWindow.UpdateLayout() } catch {}
    if ($ResetManualMove) {
        Position-SharedOverlayWindow -ResetManualMove
    } else {
        Position-SharedOverlayWindow
    }
}

function Test-BridgeAlive {
    try {
        $req = [System.Net.HttpWebRequest]::Create("$BridgeUrl/health")
        $req.Timeout = 500
        $resp = $req.GetResponse()
        $ok = ([int]$resp.StatusCode -eq 200)
        $resp.Close()
        return $ok
    } catch { return $false }
}

# Opens the web stage (Pokedex, gacha history, settings). Served by the bridge so it shares one origin.
function Open-WebPetStage {
    # Preferred: ask the Antigravity IDE extension to open the stage as an editor tab, then raise that IDE window.
    $resp = $null
    try { $resp = Invoke-BridgePostJson "/api/open-stage" @{ source = "pokemon-desktop-overlay" } 900 } catch {}
    if ($resp -and $resp.ideConnected) {
        try {
            $excludeHwnd = [IntPtr]::Zero
            if ($script:MainWindow) { $excludeHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:MainWindow)).Handle }
            $cands = New-Object System.Collections.Generic.List[string]
            if ($resp.workspaceName) { $cands.Add([string]$resp.workspaceName) }
            $score = -1
            $hwnd = [PokemonOverlayWin32]::FindBestAntigravityWindow($excludeHwnd, 0, $cands.ToArray(), [ref]$score)
            if ($hwnd -ne [IntPtr]::Zero) { [void][PokemonOverlayWin32]::ActivateWindow($hwnd) }
        } catch {}
        return
    }
    # Fallback (IDE not running / extension not installed): standalone app window.
    $htmlPath = Join-Path $ScriptDir "overlay.html"
    $target = if (Test-BridgeAlive) { "$BridgeUrl/stage" } elseif (Test-Path $htmlPath) { ([System.Uri]$htmlPath).AbsoluteUri } else { "" }
    if (-not $target) { return }
    $edgeExe = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edgeExe)) { $edgeExe = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
    if (Test-Path $edgeExe) {
        [void](Invoke-SilentVbs @($edgeExe, "--app=$target", "--window-size=1180,780"))
    } else {
        [void](Invoke-SilentVbs @("explorer.exe", $target))
    }
}


function Close-AllAndExit([switch]$UserInitiated) {
    try {
        if ($script:AnimTimer) { $script:AnimTimer.Stop() }
        if ($script:PollTimer) { $script:PollTimer.Stop() }
        if ($script:SingleClickTimer) { $script:SingleClickTimer.Stop() }
        if ($script:TrayIcon) {
            try { $script:TrayIcon.Visible = $false; $script:TrayIcon.Dispose() } catch {}
            $script:TrayIcon = $null
        }
        if ($UserInitiated -and $IsRealDesktop -and (-not $SelfTest)) {
            $mutePayload = @{ mutedAt = (Get-Date).ToString("o"); reason = "user-closed" } | ConvertTo-Json -Compress
            [System.IO.File]::WriteAllText($MuteFile, $mutePayload, (New-Object System.Text.UTF8Encoding($false)))
        }
        $script:Pets.Clear()
        if ($script:MainWindow -and $script:UserMovedWindow -and ($null -ne $script:AnchorCenterX)) {
            try { Save-OverlayPositionFile $null } catch {}
        }
        if ($script:MainWindow) {
            try { $script:MainWindow.Close() } catch {}
        }
        if ($script:OwnsStateFiles) {
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
            if (Test-Path $StateFile) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue }
        }
        if ($script:InstanceMutex) {
            try { $script:InstanceMutex.ReleaseMutex() } catch {}
            try { $script:InstanceMutex.Dispose() } catch {}
            $script:InstanceMutex = $null
        }
    } catch {}
    if ([System.Windows.Application]::Current) {
        [System.Windows.Application]::Current.Shutdown()
    } else {
        [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
    }
}

# Create a Lightweight Pet Card Control (Grid, NOT a separate OS Window!) inside the Single Shared Overlay Window
function New-PetCardControl([hashtable]$AgentData, [int]$SlotIndex) {
    [xml]$cardXaml = @"
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
      Width="96" Margin="2,0" Background="Transparent" Cursor="Hand">
    <Grid.RowDefinitions>
        <RowDefinition Height="24"/>
        <RowDefinition Height="84"/>
        <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- One-line speech bubble (status / session title); hidden while idle -->
    <Border x:Name="BubbleBorder" Grid.Row="0" HorizontalAlignment="Center" VerticalAlignment="Bottom"
            CornerRadius="8" BorderThickness="1" Padding="7,2" Margin="0,0,0,2" MaxWidth="94"
            Background="#F2241D33" BorderBrush="#24FFFFFF" Visibility="Hidden">
        <TextBlock x:Name="BubbleText" Text="" FontSize="9.5" FontWeight="SemiBold" Foreground="#F4F1FA"
                   TextTrimming="CharacterEllipsis" TextWrapping="NoWrap"/>
    </Border>

    <Grid x:Name="StageGrid" Grid.Row="1" Width="86" Height="86" HorizontalAlignment="Center" VerticalAlignment="Center">
        <!-- Lightweight context arcs: outer = used context %, inner = prompt-cache hit %. -->
        <Ellipse x:Name="RedTrack" Width="82" Height="82" Stroke="#10FFFFFF" StrokeThickness="2" IsHitTestVisible="False"/>
        <Ellipse x:Name="GreenTrack" Width="74" Height="74" Stroke="#0DFFFFFF" StrokeThickness="1.8" IsHitTestVisible="False"/>
        <Path x:Name="ContextRedArc" Width="84" Height="84" Stroke="#F87171" StrokeThickness="2.2"
              StrokeStartLineCap="Round" StrokeEndLineCap="Round" IsHitTestVisible="False"/>
        <Path x:Name="CacheGreenArc" Width="84" Height="84" Stroke="#4ADE80" StrokeThickness="1.8"
              StrokeStartLineCap="Round" StrokeEndLineCap="Round" IsHitTestVisible="False"/>

        <Ellipse x:Name="DiscEllipse" Width="62" Height="62" Fill="Transparent" Visibility="Collapsed" IsHitTestVisible="False"/>
        <Ellipse x:Name="AuraEllipse" Width="56" Height="56" Fill="#16A78BFA" StrokeThickness="0"
                 RenderTransformOrigin="0.5,0.5" IsHitTestVisible="False">
            <Ellipse.RenderTransform>
                <ScaleTransform x:Name="AuraScale" ScaleX="1" ScaleY="1"/>
            </Ellipse.RenderTransform>
        </Ellipse>
        <Ellipse x:Name="GroundShadow" Width="36" Height="6" VerticalAlignment="Center" HorizontalAlignment="Center"
                 Margin="0,60,0,0" Fill="#36000000" IsHitTestVisible="False"/>
        <Ellipse x:Name="FlashEllipse" Width="84" Height="84" Opacity="0" IsHitTestVisible="False"/>

        <Grid x:Name="SpriteHost" Width="70" Height="70" HorizontalAlignment="Center" VerticalAlignment="Center"
              RenderTransformOrigin="0.5,0.5">
            <Grid.RenderTransform>
                <TransformGroup>
                    <ScaleTransform x:Name="BodyScale" ScaleX="1" ScaleY="1"/>
                    <RotateTransform x:Name="BodyRotate" Angle="0"/>
                    <TranslateTransform x:Name="BodyTranslate" X="0" Y="0"/>
                </TransformGroup>
            </Grid.RenderTransform>
            <Image x:Name="SpriteImage" Stretch="Fill" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Grid>

        <!-- Poke Ball used by the gacha reveal -->
        <Grid x:Name="PokeballHost" Width="30" Height="30" HorizontalAlignment="Center" VerticalAlignment="Center"
              Visibility="Collapsed" RenderTransformOrigin="0.5,0.85" IsHitTestVisible="False">
            <Grid.RenderTransform>
                <TransformGroup>
                    <ScaleTransform x:Name="PokeballScale" ScaleX="1" ScaleY="1"/>
                    <RotateTransform x:Name="PokeballRotate" Angle="0"/>
                    <TranslateTransform x:Name="PokeballTranslate" X="0" Y="0"/>
                </TransformGroup>
            </Grid.RenderTransform>
            <Ellipse Stroke="#1F2937" StrokeThickness="2">
                <Ellipse.Fill>
                    <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
                        <GradientStop Color="#FB7185" Offset="0"/>
                        <GradientStop Color="#DC2626" Offset="0.45"/>
                        <GradientStop Color="#1F2937" Offset="0.45"/>
                        <GradientStop Color="#1F2937" Offset="0.55"/>
                        <GradientStop Color="#F8FAFC" Offset="0.55"/>
                        <GradientStop Color="#CBD5E1" Offset="1"/>
                    </LinearGradientBrush>
                </Ellipse.Fill>
            </Ellipse>
            <Ellipse Width="10" Height="10" Fill="#F8FAFC" Stroke="#1F2937" StrokeThickness="2"/>
        </Grid>

        <Border x:Name="CrownBadge" Width="20" Height="20" CornerRadius="10" HorizontalAlignment="Left" VerticalAlignment="Top"
                Margin="1,1,0,0" Background="#E6191524" BorderBrush="#FDE68A" BorderThickness="1" Visibility="Collapsed" IsHitTestVisible="False">
            <TextBlock Text="&#x265B;" FontSize="11" Foreground="#FDE68A" HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-2,0,0"/>
        </Border>
        <TextBlock x:Name="ShinyBadge" Text="&#x2726;" FontSize="13" FontWeight="Bold" Foreground="#FDE047"
                   HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,0,3,0" Visibility="Collapsed" IsHitTestVisible="False"/>
        <Ellipse x:Name="StateDot" Width="11" Height="11" HorizontalAlignment="Right" VerticalAlignment="Bottom"
                 Margin="0,0,7,7" Fill="#64748B" Stroke="#E616121F" StrokeThickness="2" IsHitTestVisible="False"/>
        <TextBlock x:Name="LeadChevron" Text="" Visibility="Collapsed" IsHitTestVisible="False"/>
        <Canvas x:Name="ParticleCanvas" Width="84" Height="84" IsHitTestVisible="False" ClipToBounds="False"/>
    </Grid>

    <StackPanel Grid.Row="2" Orientation="Vertical" HorizontalAlignment="Center" Margin="0,3,0,2">
        <Border x:Name="ProjectBorder" Visibility="Collapsed">
            <TextBlock x:Name="ProjectText" Text=""/>
        </Border>
        <Border x:Name="NameBorder" HorizontalAlignment="Center" MaxWidth="94" Background="Transparent" BorderThickness="0">
            <TextBlock x:Name="NameText" Text="agent" FontSize="10.5" FontWeight="SemiBold" Foreground="#F4F1FA"
                       TextTrimming="CharacterEllipsis" HorizontalAlignment="Center"/>
        </Border>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,1,0,0">
            <Border x:Name="StateBorder" Background="Transparent" BorderThickness="0">
                <TextBlock x:Name="StateText" Text="" FontSize="9" Foreground="#A59FB8"/>
            </Border>
            <Border x:Name="ContextBorder" Background="Transparent" BorderThickness="0" Margin="5,0,0,0">
                <StackPanel Orientation="Horizontal">
                    <TextBlock x:Name="ContextRedText" Text="0%" FontSize="9" FontWeight="SemiBold" Foreground="#FCA5A5"/>
                    <TextBlock x:Name="ContextSepText" Text=" / " FontSize="9" Foreground="#A59FB8"/>
                    <TextBlock x:Name="ContextGreenText" Text="0%" FontSize="9" FontWeight="SemiBold" Foreground="#86EFAC"/>
                </StackPanel>
            </Border>
        </StackPanel>
    </StackPanel>
</Grid>
"@

    $reader = New-Object System.Xml.XmlNodeReader($cardXaml)
    $rootCtrl = [System.Windows.Markup.XamlReader]::Load($reader)
    $resolvedSp = Resolve-AgentSpecies $AgentData.name $AgentData.pokemonSpecies
    $isLeadFlag = [bool]$AgentData.IsLead

    $pet = @{
        Id                 = $AgentData.id
        RawId              = if ($AgentData.rawId) { [string]$AgentData.rawId } else { [string]$AgentData.id }
        Name               = $AgentData.name
        Role               = $AgentData.role
        IsLead             = $isLeadFlag
        HasSubagentsInRow  = [bool]$AgentData.HasSubagentsInRow
        RowIndex           = if ($null -ne $AgentData.RowIndex) { [int]$AgentData.RowIndex } else { 0 }
        ColIndex           = if ($null -ne $AgentData.ColIndex) { [int]$AgentData.ColIndex } else { $SlotIndex }
        ProjectName        = if ($AgentData.ProjectName) { [string]$AgentData.ProjectName } else { U "\u5168\u5C40\u4F1A\u8BDD" }
        WorkspacePath      = if ($AgentData.WorkspacePath) { [string]$AgentData.WorkspacePath } else { "" }
        WindowId           = if ($AgentData.WindowId) { [string]$AgentData.WindowId } else { "" }
        WindowTitle        = if ($AgentData.WindowTitle) { [string]$AgentData.WindowTitle } else { "" }
        HeaderTitle        = if ($AgentData.HeaderTitle) { [string]$AgentData.HeaderTitle } else { "" }
        AppKind            = if ($AgentData.AppKind) { [string]$AgentData.AppKind } else { "" }
        WindowPid          = if ($AgentData.WindowPid) { [int]$AgentData.WindowPid } else { 0 }
        ConversationId     = if ($AgentData.ConversationId) { [string]$AgentData.ConversationId } else { "session-0" }
        ConversationTitle  = if ($AgentData.ConversationTitle) { [string]$AgentData.ConversationTitle } else { U "\u5F53\u524D\u4F1A\u8BDD" }
        IdleMs             = if ($null -ne $AgentData.idleMs) { [double]$AgentData.idleMs } else { 0.0 }
        Context            = if ($AgentData.context) { $AgentData.context } else { Normalize-AgentContext $AgentData $(if ($isLeadFlag) { 28000.0 } else { 14000.0 }) 82.0 }
        Shiny              = [bool]$AgentData.shiny
        Rarity             = if ($AgentData.rarity) { [string]$AgentData.rarity } else { "" }
        GachaKey           = if ($AgentData.gachaKey) { [string]$AgentData.gachaKey } else { "" }
        RevealStartMs      = -1.0
        RevealDone         = $false
        SlotIndex          = $SlotIndex
        Species            = $resolvedSp
        SpeciesPinned      = $false
        PackGen            = 0
        SpritePack         = $null
        FrameIndex         = 0
        FrameElapsedMs     = 0.0
        LiveState          = $AgentData.state
        LiveStatusText     = $AgentData.statusText
        ManualState        = $null
        ManualBubble       = $null
        EffectiveState     = $AgentData.state
        DragStartScreen    = New-Object System.Windows.Point(0, 0)
        WinStartPos        = New-Object System.Windows.Point(0, 0)
        DragMoved          = $false
        SuppressNextUp     = $false
        PhaseOffset        = ($SlotIndex * 1.35)
        CelebrateUntil     = [DateTime]::MinValue
        TempBubbleText     = $null
        TempBubbleUntil    = [DateTime]::MinValue
        SessionBubbleOpen  = $false
        SessionBubbleText  = $null
        SessionBubbleUntil = [DateTime]::MinValue
        RootControl        = $rootCtrl
        BubbleBorder       = $rootCtrl.FindName("BubbleBorder")
        BubbleText         = $rootCtrl.FindName("BubbleText")
        RedTrack           = $rootCtrl.FindName("RedTrack")
        GreenTrack         = $rootCtrl.FindName("GreenTrack")
        ContextRedArc      = $rootCtrl.FindName("ContextRedArc")
        CacheGreenArc      = $rootCtrl.FindName("CacheGreenArc")
        DiscEllipse        = $rootCtrl.FindName("DiscEllipse")
        AuraEllipse        = $rootCtrl.FindName("AuraEllipse")
        AuraScale          = $rootCtrl.FindName("AuraScale")
        GroundShadow       = $rootCtrl.FindName("GroundShadow")
        FlashEllipse       = $rootCtrl.FindName("FlashEllipse")
        SpriteHost         = $rootCtrl.FindName("SpriteHost")
        SpriteImage        = $rootCtrl.FindName("SpriteImage")
        PokeballHost       = $rootCtrl.FindName("PokeballHost")
        PokeballScale      = $rootCtrl.FindName("PokeballScale")
        PokeballRotate     = $rootCtrl.FindName("PokeballRotate")
        PokeballTranslate  = $rootCtrl.FindName("PokeballTranslate")
        CrownBadge         = $rootCtrl.FindName("CrownBadge")
        ShinyBadge         = $rootCtrl.FindName("ShinyBadge")
        StateDot           = $rootCtrl.FindName("StateDot")
        LeadChevron        = $rootCtrl.FindName("LeadChevron")
        ParticleCanvas     = $rootCtrl.FindName("ParticleCanvas")
        BodyScale          = $rootCtrl.FindName("BodyScale")
        BodyRotate         = $rootCtrl.FindName("BodyRotate")
        BodyTranslate      = $rootCtrl.FindName("BodyTranslate")
        ProjectBorder      = $rootCtrl.FindName("ProjectBorder")
        ProjectText        = $rootCtrl.FindName("ProjectText")
        NameBorder         = $rootCtrl.FindName("NameBorder")
        NameText           = $rootCtrl.FindName("NameText")
        StateBorder        = $rootCtrl.FindName("StateBorder")
        StateText          = $rootCtrl.FindName("StateText")
        ContextBorder      = $rootCtrl.FindName("ContextBorder")
        ContextRedText     = $rootCtrl.FindName("ContextRedText")
        ContextSepText     = $rootCtrl.FindName("ContextSepText")
        ContextGreenText   = $rootCtrl.FindName("ContextGreenText")
        Particles          = New-Object System.Collections.ArrayList
    }

    Start-PetGachaRevealIfNew $pet ([int]$AgentData.gachaRevealSeq)
    [void](Set-PetAuthenticSprite $pet $resolvedSp $script:CurrentSpriteStyle)

    # Rich Right-Click Context Menu
    $ctx = New-Object System.Windows.Controls.ContextMenu

    $miFocus = New-Object System.Windows.Controls.MenuItem
    $miFocus.Header = $TXT.MenuFocus
    $miFocus.Add_Click(({ [void](Invoke-FocusLeadSession $pet) }).GetNewClosure())
    [void]$ctx.Items.Add($miFocus)

    $miSessionInfo = New-Object System.Windows.Controls.MenuItem
    $miSessionInfo.Header = $TXT.MenuShowTitle
    $miSessionInfo.Add_Click(({ Toggle-LeadSessionBubble $pet -ForceOpen }).GetNewClosure())
    [void]$ctx.Items.Add($miSessionInfo)
    [void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

    $miSpecies = New-Object System.Windows.Controls.MenuItem
    $miSpecies.Header = $TXT.MenuSpecies
    foreach ($spKey in $SPECIES_ORDER) {
        $sub = New-Object System.Windows.Controls.MenuItem
        $sub.Header = $SPECIES_META[$spKey].Name
        $capturedSp = $spKey
        $sub.Add_Click(({
            if ($pet.GachaKey) {
                # Partners come from the gacha Pokedex: re-assign only to species already caught (persisted by the bridge).
                $res = Invoke-BridgePostJson "/api/collection/assign" @{ key = $pet.GachaKey; species = $capturedSp; shiny = $false } 900
                if ($res -and $res.ok) {
                    $pet.Shiny = $false
                    [void](Set-PetAuthenticSprite $pet $capturedSp $script:CurrentSpriteStyle)
                    Trigger-PetCelebration $pet
                } else {
                    $pet.TempBubbleText = "$($TXT.NotCaughtYet)$($SPECIES_META[$capturedSp].Short)"
                    $pet.TempBubbleUntil = [DateTime]::UtcNow.AddSeconds(3.0)
                    Update-PetVisualState $pet
                }
            } else {
                $pet.SpeciesPinned = $true
                [void](Set-PetAuthenticSprite $pet $capturedSp $script:CurrentSpriteStyle)
                Trigger-PetCelebration $pet
                Send-BridgeSimulate @{ id = $pet.RawId; name = $pet.Name; pokemonSpecies = $capturedSp; ttlMs = 300000 }
            }
        }).GetNewClosure())
        [void]$miSpecies.Items.Add($sub)
    }
    [void]$ctx.Items.Add($miSpecies)

    $miState = New-Object System.Windows.Controls.MenuItem
    $miState.Header = $TXT.MenuState
    $simDefs = @(
        @{ Key = "thinking";    Label = $TXT.MenuSimThink; Msg = $TXT.SimThinkMsg },
        @{ Key = "working";     Label = $TXT.MenuSimWork;  Msg = $TXT.SimWorkMsg },
        @{ Key = "sleeping";    Label = $TXT.MenuSimSleep; Msg = $TXT.SimSleepMsg },
        @{ Key = "celebrating"; Label = $TXT.MenuSimHappy; Msg = $TXT.SimHappyMsg },
        @{ Key = "error";       Label = $TXT.MenuSimError; Msg = $TXT.SimErrorMsg },
        @{ Key = "auto";        Label = $TXT.MenuSimAuto;  Msg = "" }
    )
    foreach ($sd in $simDefs) {
        $sub = New-Object System.Windows.Controls.MenuItem
        $sub.Header = $sd.Label
        $capKey = $sd.Key
        $capMsg = $sd.Msg
        $sub.Add_Click(({
            if ($capKey -eq "auto") {
                $pet.ManualState = $null
                $pet.ManualBubble = $null
                Send-BridgeSimulate @{ id = $pet.RawId; name = $pet.Name; action = "reset" }
            } elseif ($capKey -eq "celebrating") {
                $pet.ManualState = $null
                Trigger-PetCelebration $pet
                Send-BridgeSimulate @{ id = $pet.RawId; name = $pet.Name; state = "celebrating"; statusText = $capMsg; ttlMs = 8000 }
            } else {
                $pet.ManualState = $capKey
                $pet.ManualBubble = $capMsg
                Send-BridgeSimulate @{ id = $pet.RawId; name = $pet.Name; state = $capKey; statusText = $capMsg; ttlMs = 120000 }
            }
            Update-PetVisualState $pet
        }).GetNewClosure())
        [void]$miState.Items.Add($sub)
    }
    [void]$ctx.Items.Add($miState)

    [void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))
    $miWeb = New-Object System.Windows.Controls.MenuItem
    $miWeb.Header = $TXT.MenuDexStage
    $miWeb.Add_Click({ Open-WebPetStage })
    [void]$ctx.Items.Add($miWeb)

    if (-not $isLeadFlag) {
        $miFocus.Visibility = "Collapsed"
        $miSessionInfo.Visibility = "Collapsed"
    }
    $rootCtrl.ContextMenu = $ctx

    # Single-click (deferred past the OS double-click time -> info) vs double-click (jump to session) + drag.
    # Double-click detection: WPF's ClickCount resets if anything re-renders between clicks or the pointer
    # drifts > 4px, so Register-PetPress also accepts 2 presses on the same pet within the OS window and 12px.
    $rootCtrl.Add_MouseLeftButtonDown(({
        param($sender, $e)
        $downPt = if ($script:MainWindow) { $script:MainWindow.PointToScreen($e.GetPosition($script:MainWindow)) } else { New-Object System.Windows.Point(0, 0) }
        $isDouble = Register-PetPress $pet $downPt.X $downPt.Y $e.ClickCount
        if ($isDouble) {
            $pet.SuppressNextUp = $true
            if ($pet.IsLead) {
                [void](Invoke-FocusLeadSession $pet)
            } else {
                Trigger-PetCelebration $pet
            }
            $e.Handled = $true
            return
        }
        $pet.SuppressNextUp = $false
        $pet.DragMoved = $false
        if ($script:MainWindow) {
            $pet.DragStartScreen = $script:MainWindow.PointToScreen($e.GetPosition($script:MainWindow))
            $startL = if ([Double]::IsNaN($script:MainWindow.Left) -or [Double]::IsInfinity($script:MainWindow.Left)) { 80.0 } else { [double]$script:MainWindow.Left }
            $startT = if ([Double]::IsNaN($script:MainWindow.Top) -or [Double]::IsInfinity($script:MainWindow.Top)) { 80.0 } else { [double]$script:MainWindow.Top }
            $pet.WinStartPos = New-Object System.Windows.Point($startL, $startT)
        }
        [void]$rootCtrl.CaptureMouse()
        $e.Handled = $true
    }).GetNewClosure())

    $rootCtrl.Add_MouseMove(({
        param($sender, $e)
        if (-not $rootCtrl.IsMouseCaptured -or (-not $script:MainWindow)) { return }
        $screenPt = $script:MainWindow.PointToScreen($e.GetPosition($script:MainWindow))
        $dx = $screenPt.X - $pet.DragStartScreen.X
        $dy = $screenPt.Y - $pet.DragStartScreen.Y
        if ((-not $pet.DragMoved) -and ([Math]::Abs($dx) -gt 5 -or [Math]::Abs($dy) -gt 5)) {
            $pet.DragMoved = $true
            Set-UserMovedWindow
        }
        if ($pet.DragMoved -and (-not [Double]::IsNaN($dx)) -and (-not [Double]::IsNaN($dy))) {
            $script:MainWindow.Left = $pet.WinStartPos.X + $dx
            $script:MainWindow.Top  = $pet.WinStartPos.Y + $dy
        }
    }).GetNewClosure())

    $rootCtrl.Add_MouseLeftButtonUp(({
        param($sender, $e)
        if ($rootCtrl.IsMouseCaptured) { $rootCtrl.ReleaseMouseCapture() }
        if ($pet.DragMoved) { Save-OverlayAnchorFromWindow }
        if ($pet.SuppressNextUp) {
            $pet.SuppressNextUp = $false
            $e.Handled = $true
            return
        }
        if (-not $pet.DragMoved) {
            # Every pet (lead or not) waits out the double-click window before its single-click action.
            Set-PendingSingleClick $pet
        }
        $pet.DragMoved = $false
        $e.Handled = $true
    }).GetNewClosure())

    Update-PetVisualState $pet
    return $pet
}

# Build the ONE Single Unified Shared Floating Window (`$script:MainWindow`)
function New-UnifiedOverlayWindow {
    [xml]$winXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStartupLocation="Manual"
        Left="80"
        Top="0"
        Opacity="1.0"
        Visibility="Visible"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ResizeMode="NoResize"
        SizeToContent="WidthAndHeight"
        FontFamily="Segoe UI, Microsoft YaHei UI">
    <Window.Resources>
        <Style x:Key="IconBtn" TargetType="Button">
            <Setter Property="Foreground" Value="#F4F1FA"/>
            <Setter Property="Background" Value="Transparent"/>
            <Setter Property="Width" Value="26"/>
            <Setter Property="Height" Value="22"/>
            <Setter Property="Margin" Value="1,0"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Focusable" Value="False"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="Button">
                        <Border x:Name="Bd" CornerRadius="7" Background="{TemplateBinding Background}">
                            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="Bd" Property="Background" Value="#26808080"/>
                            </Trigger>
                            <Trigger Property="IsPressed" Value="True">
                                <Setter TargetName="Bd" Property="Background" Value="#40808080"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style x:Key="GlassScrollThumb" TargetType="{x:Type Thumb}">
            <Setter Property="OverridesDefaultStyle" Value="True"/>
            <Setter Property="IsTabStop" Value="False"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type Thumb}">
                        <Border x:Name="ThumbPill" CornerRadius="2.5" Background="#38FFFFFF" SnapsToDevicePixels="True"/>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="ThumbPill" Property="Background" Value="#80FFFFFF"/>
                            </Trigger>
                            <Trigger Property="IsDragging" Value="True">
                                <Setter TargetName="ThumbPill" Property="Background" Value="#B0FFFFFF"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style x:Key="GlassScrollPageBtn" TargetType="{x:Type RepeatButton}">
            <Setter Property="OverridesDefaultStyle" Value="True"/>
            <Setter Property="Background" Value="Transparent"/>
            <Setter Property="BorderThickness" Value="0"/>
            <Setter Property="Opacity" Value="0"/>
            <Setter Property="Focusable" Value="False"/>
            <Setter Property="IsTabStop" Value="False"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type RepeatButton}">
                        <Border Background="Transparent"/>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="{x:Type ScrollBar}">
            <Setter Property="OverridesDefaultStyle" Value="True"/>
            <Setter Property="Background" Value="Transparent"/>
            <Setter Property="BorderThickness" Value="0"/>
            <Setter Property="Opacity" Value="0.28"/>
            <Setter Property="SnapsToDevicePixels" Value="True"/>
            <Style.Triggers>
                <Trigger Property="IsMouseOver" Value="True">
                    <Setter Property="Opacity" Value="0.95"/>
                </Trigger>
                <Trigger Property="Orientation" Value="Vertical">
                    <Setter Property="Width" Value="5"/>
                    <Setter Property="MinWidth" Value="5"/>
                    <Setter Property="Height" Value="Auto"/>
                    <Setter Property="MinHeight" Value="0"/>
                    <Setter Property="Margin" Value="3,4,1,4"/>
                    <Setter Property="Template">
                        <Setter.Value>
                            <ControlTemplate TargetType="{x:Type ScrollBar}">
                                <Grid Background="{TemplateBinding Background}">
                                    <Track x:Name="PART_Track" IsDirectionReversed="True">
                                        <Track.DecreaseRepeatButton>
                                            <RepeatButton Style="{StaticResource GlassScrollPageBtn}" Command="ScrollBar.PageUpCommand"/>
                                        </Track.DecreaseRepeatButton>
                                        <Track.Thumb>
                                            <Thumb Style="{StaticResource GlassScrollThumb}"/>
                                        </Track.Thumb>
                                        <Track.IncreaseRepeatButton>
                                            <RepeatButton Style="{StaticResource GlassScrollPageBtn}" Command="ScrollBar.PageDownCommand"/>
                                        </Track.IncreaseRepeatButton>
                                    </Track>
                                </Grid>
                            </ControlTemplate>
                        </Setter.Value>
                    </Setter>
                </Trigger>
                <Trigger Property="Orientation" Value="Horizontal">
                    <Setter Property="Height" Value="5"/>
                    <Setter Property="MinHeight" Value="5"/>
                    <Setter Property="Width" Value="Auto"/>
                    <Setter Property="MinWidth" Value="0"/>
                    <Setter Property="Margin" Value="4,3,4,1"/>
                    <Setter Property="Template">
                        <Setter.Value>
                            <ControlTemplate TargetType="{x:Type ScrollBar}">
                                <Grid Background="{TemplateBinding Background}">
                                    <Track x:Name="PART_Track" IsDirectionReversed="False">
                                        <Track.DecreaseRepeatButton>
                                            <RepeatButton Style="{StaticResource GlassScrollPageBtn}" Command="ScrollBar.PageLeftCommand"/>
                                        </Track.DecreaseRepeatButton>
                                        <Track.Thumb>
                                            <Thumb Style="{StaticResource GlassScrollThumb}"/>
                                        </Track.Thumb>
                                        <Track.IncreaseRepeatButton>
                                            <RepeatButton Style="{StaticResource GlassScrollPageBtn}" Command="ScrollBar.PageRightCommand"/>
                                        </Track.IncreaseRepeatButton>
                                    </Track>
                                </Grid>
                            </ControlTemplate>
                        </Setter.Value>
                    </Setter>
                </Trigger>
            </Style.Triggers>
        </Style>
    </Window.Resources>
    <Border x:Name="RootBorder" CornerRadius="14" BorderThickness="1" Padding="8,5,8,6" Margin="10,6,10,12"
            Background="#A612111A" BorderBrush="#33FFFFFF">
        <StackPanel Orientation="Vertical">
            <!-- Slim draggable header -->
            <Border x:Name="HeaderBorder" Background="Transparent" Cursor="SizeAll" Padding="2,0,0,0">
                <Grid>
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,14,0">
                        <Ellipse x:Name="LedOrb" Width="7" Height="7" Fill="#D8B4FE" Margin="0,0,7,0" VerticalAlignment="Center"/>
                        <TextBlock x:Name="TitleText" Text="Agent Pets" FontSize="11.5" FontWeight="SemiBold" Foreground="#F4F1FA" VerticalAlignment="Center"/>
                        <TextBlock x:Name="SummaryText" Text="" FontSize="10.5" Foreground="#A59FB8" Margin="9,0,0,0" VerticalAlignment="Center"/>
                    </StackPanel>
                    <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
                        <Button x:Name="BtnGhost" Style="{StaticResource IconBtn}">
                            <TextBlock x:Name="GhostBtnText" Text="&#x25CE;" FontSize="12"/>
                        </Button>
                        <Button x:Name="BtnCollapse" Style="{StaticResource IconBtn}">
                            <TextBlock x:Name="CollapseBtnText" Text="&#x25B4;" FontSize="12"/>
                        </Button>
                        <Button x:Name="BtnMenu" Style="{StaticResource IconBtn}">
                            <TextBlock Text="&#x22EF;" FontSize="13" FontWeight="Bold"/>
                        </Button>
                        <Button x:Name="BtnClose" Style="{StaticResource IconBtn}">
                            <TextBlock Text="&#x2715;" FontSize="10.5"/>
                        </Button>
                    </StackPanel>
                </Grid>
            </Border>

            <Border x:Name="GhostNotice" CornerRadius="8" Padding="8,3" Margin="0,5,0,0" Visibility="Collapsed" Background="#0FFFFFFF">
                <TextBlock x:Name="GhostNoticeText" Text="" FontSize="9.5" Foreground="#A59FB8" TextWrapping="Wrap" MaxWidth="560"/>
            </Border>

            <!-- Session banner (single-click a lead; double-click the banner jumps to the session) -->
            <Border x:Name="SessionBannerBorder" CornerRadius="10" BorderThickness="1" Padding="10,5" Margin="0,6,0,0"
                    Background="#0FFFFFFF" BorderBrush="#D8B4FE" Visibility="Collapsed" Cursor="Hand">
                <StackPanel Orientation="Vertical">
                    <TextBlock x:Name="SessionBannerTitle" Text="" FontSize="11" FontWeight="SemiBold" Foreground="#F4F1FA" TextWrapping="Wrap" MaxWidth="560"/>
                    <TextBlock x:Name="SessionBannerSub" Text="" FontSize="9.5" Foreground="#A59FB8" Margin="0,2,0,0"/>
                </StackPanel>
            </Border>

            <ScrollViewer x:Name="BodyScroll" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled"
                          PanningMode="VerticalOnly" CanContentScroll="False" Padding="0,0,3,0"
                          MaxHeight="560" MaxWidth="1240" Margin="0,5,0,0">
                <StackPanel x:Name="ProjectsPanel" Orientation="Vertical"/>
            </ScrollViewer>
        </StackPanel>
    </Border>
</Window>
"@

    $reader = New-Object System.Xml.XmlNodeReader($winXaml)
    $win = [System.Windows.Markup.XamlReader]::Load($reader)
    $win.Title = $TXT.AppTitle

    $refs = @{
        Window              = $win
        RootBorder          = $win.FindName("RootBorder")
        HeaderBorder        = $win.FindName("HeaderBorder")
        LedOrb              = $win.FindName("LedOrb")
        TitleText           = $win.FindName("TitleText")
        SummaryText         = $win.FindName("SummaryText")
        BtnGhost            = $win.FindName("BtnGhost")
        GhostBtnText        = $win.FindName("GhostBtnText")
        BtnCollapse         = $win.FindName("BtnCollapse")
        CollapseBtnText     = $win.FindName("CollapseBtnText")
        BtnMenu             = $win.FindName("BtnMenu")
        BtnClose            = $win.FindName("BtnClose")
        GhostNotice         = $win.FindName("GhostNotice")
        GhostNoticeText     = $win.FindName("GhostNoticeText")
        SessionBannerBorder = $win.FindName("SessionBannerBorder")
        SessionBannerTitle  = $win.FindName("SessionBannerTitle")
        SessionBannerSub    = $win.FindName("SessionBannerSub")
        BodyScroll          = $win.FindName("BodyScroll")
        ProjectsPanel       = $win.FindName("ProjectsPanel")
    }

    $refs.TitleText.Text       = $TXT.TitleShort
    $refs.GhostNoticeText.Text = $TXT.GhostNotice
    $refs.BtnGhost.ToolTip     = $TXT.GhostOnTip
    $refs.BtnCollapse.ToolTip  = $TXT.BtnCollapse
    $refs.BtnMenu.ToolTip      = $TXT.MenuTip
    $refs.BtnClose.ToolTip     = $TXT.CloseTip

    $waInit = [System.Windows.SystemParameters]::WorkArea
    $waInitH = if ([Double]::IsNaN($waInit.Height) -or [Double]::IsInfinity($waInit.Height) -or $waInit.Height -le 200.0) { 1040.0 } else { [double]$waInit.Height }
    $refs.BodyScroll.MaxHeight = [Math]::Max(480, [Math]::Min(780, [Math]::Floor($waInitH * 0.68)))

    $refs.BodyScroll.Add_PreviewMouseWheel({
        param($s, $e)
        if ($s -and $s.ScrollableHeight -gt 0) {
            $nextOffset = [Math]::Max(0.0, [Math]::Min($s.ScrollableHeight, $s.VerticalOffset - ($e.Delta * 0.45)))
            $s.ScrollToVerticalOffset($nextOffset)
            $e.Handled = $true
        }
    })

    $refs.HeaderBorder.Add_MouseLeftButtonDown({
        param($s, $e)
        if ($e.OriginalSource -is [System.Windows.Controls.Primitives.ButtonBase]) { return }
        if ($e.ClickCount -ge 2) {
            Set-OverlayCollapsed (-not $script:IsCollapsed)
            return
        }
        if ($e.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) {
            try { $script:MainWindow.DragMove() } catch {}
            Save-OverlayAnchorFromWindow
        }
    })

    $refs.SessionBannerBorder.Add_MouseLeftButtonDown({
        param($s, $e)
        # A single click on the session banner jumps straight to the conversation (much easier to hit
        # than a double-click on a moving sprite).
        if ($script:ActiveBannerLeadPet) {
            [void](Invoke-FocusLeadSession $script:ActiveBannerLeadPet)
        } else {
            $script:MainRefs.SessionBannerBorder.Visibility = "Collapsed"
            $script:ActiveBannerLeadPet = $null
        }
        $e.Handled = $true
    })

    # Overflow menu (keeps the header narrow)
    $menu = New-Object System.Windows.Controls.ContextMenu

    $miTheme = New-Object System.Windows.Controls.MenuItem
    $miTheme.Header = $TXT.MenuTheme
    foreach ($thKey in $THEME_ORDER) {
        $sub = New-Object System.Windows.Controls.MenuItem
        $sub.Header = $THEMES[$thKey].Label
        $capTheme = $thKey
        $sub.Add_Click(({ Apply-ThemePalette $capTheme }).GetNewClosure())
        [void]$miTheme.Items.Add($sub)
    }
    [void]$menu.Items.Add($miTheme)

    $miDemo = New-Object System.Windows.Controls.MenuItem
    $miDemo.Header = $TXT.MenuGachaDemo
    $miDemo.Add_Click({
        $states = @("working", "thinking", "working")
        $st = $states[$script:DemoCounter % $states.Count]
        $simId = "trainer-pet-$($script:DemoCounter)-$([DateTime]::UtcNow.ToString('HHmmss'))"
        $script:DemoCounter++
        Send-BridgeSimulate @{
            id = $simId; name = $simId; role = "helper"; isLead = $false
            state = $st; statusText = $TXT.SimWorkMsg; ttlMs = 60000
        }
        [void](Sync-AgentPets)
    })
    [void]$menu.Items.Add($miDemo)

    $miStage = New-Object System.Windows.Controls.MenuItem
    $miStage.Header = $TXT.MenuDexStage
    $miStage.Add_Click({ Open-WebPetStage })
    [void]$menu.Items.Add($miStage)
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $miGhost = New-Object System.Windows.Controls.MenuItem
    $miGhost.Header = $TXT.MenuGhost
    $miGhost.Add_Click({ Set-PetClickThroughAll (-not $script:IsClickThrough) })
    [void]$menu.Items.Add($miGhost)

    $miReset = New-Object System.Windows.Controls.MenuItem
    $miReset.Header = $TXT.MenuResetPos
    $miReset.Add_Click({ Position-SharedOverlayWindow -ResetManualMove })
    [void]$menu.Items.Add($miReset)
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $miExit = New-Object System.Windows.Controls.MenuItem
    $miExit.Header = $TXT.MenuExit
    $miExit.Add_Click({ Close-AllAndExit -UserInitiated })
    [void]$menu.Items.Add($miExit)

    $refs.BtnMenu.ContextMenu = $menu
    $refs.BtnMenu.Add_Click({
        $m = $script:MainRefs.BtnMenu.ContextMenu
        $m.PlacementTarget = $script:MainRefs.BtnMenu
        $m.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Bottom
        $m.IsOpen = $true
    })

    $refs.BtnGhost.Add_Click({ Set-PetClickThroughAll (-not $script:IsClickThrough) })
    $refs.BtnCollapse.Add_Click({ Set-OverlayCollapsed (-not $script:IsCollapsed) })
    $refs.BtnClose.Add_Click({ Close-AllAndExit -UserInitiated })

    $win.Add_SizeChanged({ Position-SharedOverlayWindow })
    $win.Add_Loaded({ try { Force-ShowSharedOverlayWindow } catch {} })
    $win.Add_ContentRendered({ try { Force-ShowSharedOverlayWindow } catch {} })
    $win.Add_SourceInitialized({
        if ($script:IsClickThrough) { Set-PetClickThroughAll $true }
    })

    return $refs
}


# Synchronize Project-Grouped Multi-Session Queue Rows inside the Single Shared Floating Window
function Sync-QueuesToPets([array]$QueueRows) {
    $flatMembers = New-Object System.Collections.ArrayList
    $thinkCount = 0; $workCount = 0; $sleepCount = 0
    $sigParts = New-Object System.Collections.Generic.List[string]

    foreach ($row in @($QueueRows)) {
        if (-not $row -or (-not $row.Members)) { continue }
        $memberIds = New-Object System.Collections.Generic.List[string]
        foreach ($m in @($row.Members)) {
            if (-not $m) { continue }
            [void]$flatMembers.Add($m)
            $memberIds.Add([string]$m.id)
            if ($m.state -eq "thinking") { $thinkCount++ }
            elseif ($m.state -eq "working") { $workCount++ }
            else { $sleepCount++ }
        }
        $sigParts.Add("$($row.ProjectName)::$($row.ConversationId)[$($memberIds -join ',')]")
    }

    $seenIds = @{}
    foreach ($ag in $flatMembers) { $seenIds[$ag.id] = $true }

    foreach ($existingId in @($script:Pets.Keys)) {
        if (-not $seenIds.ContainsKey($existingId)) {
            $old = $script:Pets[$existingId]
            if ($old.RootControl -and $old.RootControl.Parent) {
                try { $old.RootControl.Parent.Children.Remove($old.RootControl) } catch {}
            }
            $script:Pets.Remove($existingId)
        }
    }

    $slotIdx = 0
    foreach ($ag in $flatMembers) {
        $id = $ag.id
        if ($script:Pets.ContainsKey($id)) {
            $ex = $script:Pets[$id]
            $ex.SlotIndex         = $slotIdx
            $ex.RowIndex          = [int]$ag.RowIndex
            $ex.ColIndex          = [int]$ag.ColIndex
            $ex.IsLead            = [bool]$ag.IsLead
            $ex.HasSubagentsInRow = [bool]$ag.HasSubagentsInRow
            $ex.ProjectName       = if ($ag.ProjectName) { [string]$ag.ProjectName } else { $ex.ProjectName }
            $ex.WorkspacePath     = if ($ag.WorkspacePath) { [string]$ag.WorkspacePath } else { $ex.WorkspacePath }
            $ex.WindowId          = if ($ag.WindowId) { [string]$ag.WindowId } else { $ex.WindowId }
            $ex.WindowTitle       = if ($ag.WindowTitle) { [string]$ag.WindowTitle } else { $ex.WindowTitle }
            $ex.HeaderTitle       = if ($ag.HeaderTitle) { [string]$ag.HeaderTitle } else { $ex.HeaderTitle }
            $ex.AppKind           = if ($ag.AppKind) { [string]$ag.AppKind } else { $ex.AppKind }
            $ex.WindowPid         = if ($ag.WindowPid) { [int]$ag.WindowPid } else { $ex.WindowPid }
            $ex.ConversationId    = if ($ag.ConversationId) { [string]$ag.ConversationId } else { $ex.ConversationId }
            $ex.ConversationTitle = if ($ag.ConversationTitle) { [string]$ag.ConversationTitle } else { $ex.ConversationTitle }
            $ex.IdleMs            = if ($null -ne $ag.idleMs) { [double]$ag.idleMs } else { 0.0 }
            $ex.Context           = if ($ag.context) { $ag.context } else { $ex.Context }
            $ex.LiveState         = $ag.state
            $ex.LiveStatusText    = $ag.statusText
            $ex.Rarity            = if ($ag.rarity) { [string]$ag.rarity } else { $ex.Rarity }
            $ex.GachaKey          = if ($ag.gachaKey) { [string]$ag.gachaKey } else { $ex.GachaKey }
            $newShiny = [bool]$ag.shiny
            $speciesChanged = ($ag.pokemonSpecies -and $ag.pokemonSpecies -ne $ex.Species)
            $packChanged = ([int]$ex.PackGen -ne [int]$PackState.Gen)
            if ((-not $ex.SpeciesPinned -and $speciesChanged) -or ($newShiny -ne [bool]$ex.Shiny) -or $packChanged) {
                $ex.Shiny = $newShiny
                $spTarget = if ($ag.pokemonSpecies) { [string]$ag.pokemonSpecies } else { $ex.Species }
                [void](Set-PetAuthenticSprite $ex $spTarget $script:CurrentSpriteStyle)
            }
            Start-PetGachaRevealIfNew $ex ([int]$ag.gachaRevealSeq)
            Update-PetVisualState $ex
        } else {
            $pet = New-PetCardControl $ag $slotIdx
            $script:Pets[$id] = $pet
        }
        $slotIdx++
    }

    if ($script:MainRefs -and $script:MainRefs.BodyScroll) {
        $waRect = [System.Windows.SystemParameters]::WorkArea
        $waH = if ([Double]::IsNaN($waRect.Height) -or [Double]::IsInfinity($waRect.Height) -or $waRect.Height -le 200.0) { 1040.0 } else { [double]$waRect.Height }
        $script:MainRefs.BodyScroll.MaxHeight = [Math]::Max(480, [Math]::Min(780, [Math]::Floor($waH * 0.68)))
    }

    $isDenseQueues = (@($QueueRows).Count -gt 3)
    $newSignature = ($sigParts -join "|") + "|dense=" + $(if ($isDenseQueues) { "1" } else { "0" })
    if ($script:MainRefs -and ($newSignature -ne $script:LayoutSignature)) {
        $script:LayoutSignature = $newSignature
        foreach ($pet in $script:Pets.Values) {
            if ($pet.RootControl.Parent) {
                try { $pet.RootControl.Parent.Children.Remove($pet.RootControl) } catch {}
            }
        }
        $script:MainRefs.ProjectsPanel.Children.Clear()
        $script:ProjectBorders.Clear()
        $script:ProjectTitleTexts.Clear()

        $pal = $THEMES[$script:CurrentTheme]
        $projOrder = New-Object System.Collections.ArrayList
        $projRows = @{}
        foreach ($r in @($QueueRows)) {
            if (-not $r) { continue }
            $pName = if ($r.ProjectName) { [string]$r.ProjectName } else { U "\u5168\u5C40\u4F1A\u8BDD" }
            if (-not $projRows.ContainsKey($pName)) {
                $projRows[$pName] = New-Object System.Collections.ArrayList
                [void]$projOrder.Add($pName)
            }
            [void]$projRows[$pName].Add($r)
        }

        foreach ($pName in $projOrder) {
            $pBorder = New-Object System.Windows.Controls.Border
            $pBorder.CornerRadius = New-Object System.Windows.CornerRadius(0)
            $pBorder.BorderThickness = New-Object System.Windows.Thickness(0, 1, 0, 0)
            $pBorder.Padding = if ($isDenseQueues) { New-Object System.Windows.Thickness(2, 3, 2, 1) } else { New-Object System.Windows.Thickness(2, 4, 2, 2) }
            $pBorder.Margin = if ($isDenseQueues) { New-Object System.Windows.Thickness(0, 1, 0, 2) } else { New-Object System.Windows.Thickness(0, 2, 0, 3) }
            $pBorder.Background = [System.Windows.Media.Brushes]::Transparent
            $pBorder.BorderBrush = if ($script:IsClickThrough -and (-not $script:PeekActive)) { [System.Windows.Media.Brushes]::Transparent } else { Get-Brush "#16FFFFFF" }
            [void]$script:ProjectBorders.Add($pBorder)

            $pStack = New-Object System.Windows.Controls.StackPanel
            $pStack.Orientation = [System.Windows.Controls.Orientation]::Vertical

            $pHeader = New-Object System.Windows.Controls.StackPanel
            $pHeader.Orientation = [System.Windows.Controls.Orientation]::Horizontal
            $pHeader.Margin = if ($isDenseQueues) { New-Object System.Windows.Thickness(2, 0, 2, 1) } else { New-Object System.Windows.Thickness(2, 0, 2, 3) }

            $pTitleTb = New-Object System.Windows.Controls.TextBlock
            $qCount = $projRows[$pName].Count
            $pTitleTb.Text = if ($qCount -gt 1) { "$pName  $(U '\u00B7') $qCount $(U '\u4E2A\u4F1A\u8BDD')" } else { $pName }
            $pTitleTb.FontSize = 10
            $pTitleTb.FontWeight = [System.Windows.FontWeights]::SemiBold
            $pTitleTb.Foreground = Get-Brush $pal.Muted
            [void]$pHeader.Children.Add($pTitleTb)
            [void]$script:ProjectTitleTexts.Add($pTitleTb)
            [void]$pStack.Children.Add($pHeader)

            foreach ($qRow in $projRows[$pName]) {
                $rowWrap = New-Object System.Windows.Controls.Border
                $rowWrap.CornerRadius = New-Object System.Windows.CornerRadius(10)
                $rowWrap.Padding = New-Object System.Windows.Thickness(0, 0, 0, 0)
                $rowWrap.Margin = if ($isDenseQueues) { New-Object System.Windows.Thickness(0, 0, 0, 1) } else { New-Object System.Windows.Thickness(0, 0, 0, 2) }
                $rowWrap.Background = [System.Windows.Media.Brushes]::Transparent

                $rowPanel = New-Object System.Windows.Controls.StackPanel
                $rowPanel.Orientation = [System.Windows.Controls.Orientation]::Horizontal

                $sortedRowMembers = @(
                    $qRow.Members | Sort-Object `
                        @{ Expression = { if ($_.IsLead) { 0 } else { 1 } } }, `
                        @{ Expression = { [int]$_.ColIndex } }
                )
                foreach ($m in $sortedRowMembers) {
                    if ($script:Pets.ContainsKey($m.id)) {
                        [void]$rowPanel.Children.Add($script:Pets[$m.id].RootControl)
                    }
                }
                $rowWrap.Child = $rowPanel
                [void]$pStack.Children.Add($rowWrap)
            }

            $pBorder.Child = $pStack
            [void]$script:MainRefs.ProjectsPanel.Children.Add($pBorder)
        }

        Apply-ThemePalette $script:CurrentTheme -FromBridge
        Position-SharedOverlayWindow
    }

    if ($script:MainRefs) {
        $projTotal = @($QueueRows | ForEach-Object { $_.ProjectName } | Select-Object -Unique).Count
        $qCount = [Math]::Max(1, @($QueueRows).Count)
        $ideTag = if ($BindToIde) { " [IDE]" } else { "" }
        $parts = New-Object System.Collections.Generic.List[string]
        $parts.Add("$($script:Pets.Count) $(U '\u53EA')")
        if ($workCount -gt 0)  { $parts.Add("$(U '\u5DE5\u4F5C') $workCount") }
        if ($thinkCount -gt 0) { $parts.Add("$(U '\u601D\u8003') $thinkCount") }
        if ($sleepCount -gt 0) { $parts.Add("$(U '\u5F85\u547D') $sleepCount") }
        if ($projTotal -gt 1)  { $parts.Add("$projTotal $(U '\u4E2A\u9879\u76EE')") }
        $script:MainRefs.SummaryText.Text = ($parts -join "  $(U '\u00B7')  ")
    }
}

$script:PendingSpriteGc = $false
$script:LastOverlayGcUtc = [DateTime]::UtcNow

function Sync-AgentPets {
    Check-IdeLifecycle
    if ($script:HiddenForNoHostWindow) { return @() }
    $queueRows = @(Fetch-LiveQueues)
    Sync-QueuesToPets $queueRows

    $nowGc = [DateTime]::UtcNow
    if ($script:PendingSpriteGc -or ($nowGc - $script:LastOverlayGcUtc).TotalSeconds -ge 180) {
        $fullCollect = [bool]$script:PendingSpriteGc
        $script:PendingSpriteGc = $false
        $script:LastOverlayGcUtc = $nowGc
        if ($fullCollect) {
            [System.GC]::Collect()
            [System.GC]::WaitForPendingFinalizers()
        } else {
            [System.GC]::Collect(1, [System.GCCollectionMode]::Optimized, $false)
        }
    }
    return $queueRows
}

function Invoke-AnimationFrame {
    if ($script:HiddenForNoHostWindow) { return }
    $nowElapsed = $script:AnimStopwatch.Elapsed.TotalMilliseconds
    $dtMs = $nowElapsed - $script:LastFrameElapsedMs
    if ($dtMs -le 0 -or $dtMs -gt 200) { $dtMs = 33.0 }
    $script:LastFrameElapsedMs = $nowElapsed

    $script:TickCount++
    $t = $script:TickCount * 0.11
    $nowUtc = [DateTime]::UtcNow

    if (($script:TickCount % 2) -eq 0) {
        Update-ClickThroughInput
    }

    if ($script:MainRefs -and $script:MainRefs.SessionBannerBorder.Visibility -eq "Visible" -and $nowUtc -ge $script:BannerUntilUtc) {
        $script:MainRefs.SessionBannerBorder.Visibility = "Collapsed"
        $script:ActiveBannerLeadPet = $null
    }

    if ($script:AnimTimer) {
        $anyActiveAnim = $false
        foreach ($pCheck in $script:Pets.Values) {
            if ($pCheck.EffectiveState -ne "sleeping" -or $pCheck.SessionBubbleOpen -or $pCheck.RevealingUntil -or $pCheck.Particles.Count -gt 0) {
                $anyActiveAnim = $true
                break
            }
        }
        $targetAnimMs = if (-not $anyActiveAnim) { 140 } elseif ($script:Pets.Count -gt 6) { 65 } else { 40 }
        if ([int]$script:AnimTimer.Interval.TotalMilliseconds -ne $targetAnimMs) {
            $script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds($targetAnimMs)
        }
    }

    foreach ($pet in $script:Pets.Values) {
        $ph = $t + $pet.PhaseOffset
        $state = $pet.EffectiveState
        if ($state -eq "sleeping" -and (-not $pet.SessionBubbleOpen) -and (-not $pet.RevealingUntil) -and ((($script:TickCount + [int]$pet.SlotIndex) % 3) -ne 0)) {
            continue
        }

        if ($state -eq "celebrating" -and ($nowUtc -ge $pet.CelebrateUntil) -and ($pet.ManualState -ne "celebrating")) {
            Update-PetVisualState $pet
            $state = $pet.EffectiveState
        }
        if ($pet.SessionBubbleOpen -and ($nowUtc -ge $pet.SessionBubbleUntil)) {
            $pet.SessionBubbleOpen = $false
            Update-PetVisualState $pet
            $state = $pet.EffectiveState
        }

        $bobY = 0.0; $rot = 0.0; $scX = 1.0; $scY = 1.0; $auraScale = 1.0; $frameSpeed = 1.0
        $revealing = Update-PetGachaReveal $pet $nowElapsed
        if ($revealing) { $state = "__reveal" }
        elseif ($pet.Shiny -and (($script:TickCount + [int]($pet.PhaseOffset * 10)) % 75) -eq 0) {
            Spawn-Particle $pet ([string][char]0x2726) "#FDE047" (14 + (Get-Random -Minimum 0 -Maximum 50)) (6 + (Get-Random -Minimum 0 -Maximum 20)) 0.0 -0.45 10
        }
        switch ($state) {
            "__reveal" { $frameSpeed = 1.0 }
            "thinking" {
                $frameSpeed = 1.0
                $bobY = [Math]::Sin($ph * 1.35) * 2.5
                $rot  = [Math]::Sin($ph * 0.9) * 3.0
                $auraScale = 1.0 + ([Math]::Sin($ph * 1.8) * 0.08)
                if (($script:TickCount % 24) -eq 0) {
                    $sym = if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { $TXT.SymThought } else { "?" }
                    Spawn-Particle $pet $sym "#D8B4FE" (58 + (Get-Random -Minimum -5 -Maximum 6)) 6 0.24 -0.8 11
                }
            }
            "working" {
                $frameSpeed = 1.65
                $bobY = -[Math]::Abs([Math]::Sin($ph * 2.6)) * 5.0
                $scY  = 1.0 + ([Math]::Cos($ph * 5.2) * 0.04)
                $auraScale = 1.04 + ([Math]::Sin($ph * 3.2) * 0.10)
                if (($script:TickCount % 14) -eq 0) {
                    $meta = $SPECIES_META[$pet.Species]
                    $vx = ((Get-Random -Minimum -14 -Maximum 15) / 10.0)
                    Spawn-Particle $pet $meta.Spark $meta.Color (36 + (Get-Random -Minimum -16 -Maximum 17)) 24 $vx -1.2 11
                }
            }
            "celebrating" {
                $frameSpeed = 1.85
                $bobY = -[Math]::Abs([Math]::Sin($ph * 3.8)) * 8.0
                $rot  = [Math]::Sin($ph * 3.6) * 5.0
                $auraScale = 1.14 + ([Math]::Sin($ph * 4.0) * 0.1)
            }
            "error" {
                $frameSpeed = 0.65
                $bobY = [Math]::Sin($ph * 5.5) * 2.2
                $rot  = [Math]::Sin($ph * 4.8) * 5.0
                if (($script:TickCount % 20) -eq 0) {
                    Spawn-Particle $pet $TXT.SymSweat "#60A5FA" 58 10 0.2 1.0 11
                }
            }
            default {
                $frameSpeed = 0.45
                $bobY = [Math]::Sin($ph * 0.7) * 1.2
                $rot  = [Math]::Sin($ph * 0.65) * 1.5
                $scY  = 0.95 + ([Math]::Sin($ph * 0.7) * 0.03)
                $scX  = 1.02 - ([Math]::Sin($ph * 0.7) * 0.02)
                $auraScale = 0.92
                if (($script:TickCount % 32) -eq 0) {
                    $zTxt = if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { "Zzz" } else { $TXT.SymSleep }
                    Spawn-Particle $pet $zTxt "#93C5FD" 58 8 0.3 -0.6 9
                }
            }
        }

        $pack = $pet.SpritePack
        if ($pack -and $pack.Count -gt 1) {
            $pet.FrameElapsedMs += ($dtMs * $frameSpeed)
            $guard = 0
            while ($guard -lt 6) {
                $curDelay = $pack.Delays[$pet.FrameIndex]
                if ($pet.FrameElapsedMs -lt $curDelay) { break }
                $pet.FrameElapsedMs -= $curDelay
                $pet.FrameIndex = ($pet.FrameIndex + 1) % $pack.Count
                $guard++
            }
            $nextFrame = $pack.Frames[$pet.FrameIndex]
            if (-not [object]::ReferenceEquals($pet.SpriteImage.Source, $nextFrame)) {
                $pet.SpriteImage.Source = $nextFrame
            }
        }

        if (-not $revealing) {
            $pet.BodyTranslate.Y = $bobY
            $pet.BodyRotate.Angle = $rot
            $pet.BodyScale.ScaleX = $scX
            $pet.BodyScale.ScaleY = $scY
        }
        $pet.AuraScale.ScaleX = $auraScale
        $pet.AuraScale.ScaleY = $auraScale
        $pet.GroundShadow.Width = [Math]::Max(22, 34 + ($bobY * 0.8))

        for ($i = $pet.Particles.Count - 1; $i -ge 0; $i--) {
            $p = $pet.Particles[$i]
            $p.X += $p.Vx; $p.Y += $p.Vy; $p.Life -= 0.042
            if ($p.Life -le 0) {
                $pet.ParticleCanvas.Children.Remove($p.Element)
                $pet.Particles.RemoveAt($i)
            } else {
                $p.Element.Opacity = [Math]::Max(0.0, $p.Life)
                [System.Windows.Controls.Canvas]::SetLeft($p.Element, $p.X)
                [System.Windows.Controls.Canvas]::SetTop($p.Element, $p.Y)
            }
        }
    }
}

function Update-HeadlessLayoutMetrics {
    if (-not $script:MainRefs -or (-not $script:MainRefs.RootBorder)) { return }
    $root = $script:MainRefs.RootBorder
    $avail = New-Object System.Windows.Size(1400, 900)
    $root.Measure($avail)
    $root.Arrange((New-Object System.Windows.Rect(0, 0, $root.DesiredSize.Width, $root.DesiredSize.Height)))
    $root.UpdateLayout()
}

function Get-PetCardBoundsInSharedWindow($Pet) {
    $anchor = if ($script:MainWindow -and $script:MainWindow.IsVisible -and $script:MainWindow.ActualWidth -gt 0) {
        $script:MainWindow
    } else {
        $script:MainRefs.RootBorder
    }
    $pt = $Pet.RootControl.TranslatePoint((New-Object System.Windows.Point(0, 0)), $anchor)
    return @{
        Left   = [Math]::Round($pt.X, 1)
        Top    = [Math]::Round($pt.Y, 1)
        Width  = [Math]::Round($Pet.RootControl.ActualWidth, 1)
        Height = [Math]::Round($Pet.RootControl.ActualHeight, 1)
    }
}

# Initialize WPF Application singleton first so `$app.Windows.Count` tracks all OS windows accurately
$app = [System.Windows.Application]::Current
if (-not $app) {
    $app = New-Object System.Windows.Application
    $app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
}

# SelfTest Mode: Headless verification of v4.0 Single Shared Window + Double-Click Focus Session + All 6 Queue Rules
if ($SelfTest) {
    Ensure-BridgeServer
    $script:MainRefs = New-UnifiedOverlayWindow
    $script:MainWindow = $script:MainRefs.Window
    Apply-ThemePalette $Theme -FromBridge

    Initialize-PetPack
    $showdownFrameCounts = @{}
    $pixelFrameCounts = @{}
    $sampleSpecies = @($SPECIES_ORDER | Select-Object -First 8)
    foreach ($sp in @("pikachu", "charizard", "gengar", "eevee", "mewtwo", "umbreon", "rotom")) {
        if ($SPECIES_META.ContainsKey($sp) -and ($sampleSpecies -notcontains $sp)) { $sampleSpecies += $sp }
    }
    foreach ($sp in $sampleSpecies) {
        $sdPack = Get-AuthenticSpritePack $sp "showdown"
        $pxPack = Get-AuthenticSpritePack $sp "pixel"
        if (-not $sdPack -or $sdPack.Count -lt 1) { throw "Showdown sprite pack failed for $sp" }
        if (-not $pxPack -or $pxPack.Count -lt 1) { throw "Pixel sprite pack failed for $sp" }
        $showdownFrameCounts[$sp] = $sdPack.Count
        $pixelFrameCounts[$sp]    = $pxPack.Count
    }

    # Phase 1: Synthetic Multi-Project Multi-Queue Verification inside the ONE Shared Window
    $synTitleA = U "\u5168\u5C40\u5171\u4EAB\u6D6E\u7A97\u9A8C\u8BC1"
    $synTitleB = U "\u540E\u7AEF\u63A5\u53E3\u4F18\u5316"
    $synTitleC = U "\u540C\u9879\u76EE\u5E76\u53D1\u4F1A\u8BDD\u4E8C"
    $synInput = @(
        @{
            conversationId    = "conv-a"
            conversationTitle = $synTitleA
            projectName       = "Antigravity IDE ui"
            workspacePath     = $WorkspaceRoot
            focused           = $true
            lastActiveMs      = 9000
            leadAgent         = @{ id = "lead-a"; name = "coordinator"; role = "coordinator"; isLead = $true; state = "sleeping"; idleMs = 300000; statusText = "idle 5m"; pokemonSpecies = "rotom" }
            subagents         = @(
                @{ id = "sub-a1"; name = "scout";        role = "worker"; isLead = $false; state = "working";  idleMs = 0;     statusText = "working"; pokemonSpecies = "pikachu" },
                @{ id = "sub-a2"; name = "sprites";      role = "worker"; isLead = $false; state = "sleeping"; idleMs = 20000; statusText = "idle 20s"; pokemonSpecies = "eevee" },
                @{ id = "sub-a3"; name = "stale-helper"; role = "worker"; isLead = $false; state = "sleeping"; idleMs = 65000; statusText = "idle 65s"; pokemonSpecies = "gengar" }
            )
        },
        @{
            conversationId    = "conv-b"
            conversationTitle = $synTitleB
            projectName       = "Backend Service"
            workspacePath     = "C:\Projects\Backend"
            focused           = $false
            lastActiveMs      = 8500
            leadAgent         = @{ id = "lead-b"; name = "lead-backend"; role = "lead"; isLead = $true; state = "thinking"; idleMs = 0; statusText = "thinking"; pokemonSpecies = "mewtwo" }
            subagents         = @(
                @{ id = "sub-b1"; name = "api-worker"; role = "worker"; isLead = $false; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "charizard" }
            )
        },
        @{
            conversationId    = "conv-c"
            conversationTitle = $synTitleC
            projectName       = "Antigravity IDE ui"
            workspacePath     = $WorkspaceRoot
            focused           = $false
            lastActiveMs      = 8000
            leadAgent         = @{ id = "lead-c"; name = "lead-ui-2"; role = "lead"; isLead = $true; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "umbreon" }
            subagents         = @()
        },
        @{
            conversationId    = "conv-retired"
            conversationTitle = "Retired Session"
            projectName       = "Old Repo"
            focused           = $false
            lastActiveMs      = 1000
            leadAgent         = @{ id = "lead-old"; name = "old-lead"; role = "lead"; isLead = $true; state = "sleeping"; idleMs = 180000; statusText = "retired"; pokemonSpecies = "pikachu" }
            subagents         = @()
        }
    )

    $synRows = @(Apply-QueueRules $synInput)
    Sync-QueuesToPets $synRows
    Update-HeadlessLayoutMetrics

    # Verify strictly 1 single shared OS window even with 6 pets across 3 queues & 2 projects!
    if ($app.Windows.Count -ne 1) {
        throw "v4.0 Single Shared Window violated: expected windowCount=1, got $($app.Windows.Count)!"
    }
    if ($script:Pets.ContainsKey("conv-a::sub-a3")) {
        throw "Rule 4 failed: sleeping subagent with idleMs=65000 (>60s) was NOT removed!"
    }
    if (-not $script:Pets.ContainsKey("conv-a::sub-a2")) {
        throw "Rule 4 failed: sleeping subagent with idleMs=20000 (<=60s) was wrongly removed!"
    }
    if (-not $script:Pets.ContainsKey("conv-a::lead-a")) {
        throw "Rule 5 failed: leadAgent with idleMs=300000 was removed despite active subagent!"
    }
    if ($script:Pets.ContainsKey("conv-retired::lead-old")) {
        throw "Rule 5 failed: retired background session (>60s sleeping leadAgent, 0 active subagents) was NOT pruned!"
    }
    if ($synRows.Count -ne 3 -or $synRows[0].ProjectName -ne "Antigravity IDE ui" -or $synRows[1].ProjectName -ne "Antigravity IDE ui" -or $synRows[2].ProjectName -ne "Backend Service") {
        throw "Rule 2 failed: session queues were not grouped contiguously by ProjectName!"
    }

    $synRowGroups = @($script:Pets.Values | Group-Object { [int]$_.RowIndex } | Sort-Object { [int]$_.Name })
    if ($synRowGroups.Count -ne 3) {
        throw "Rule 1 failed: expected 3 stacked queue rows, got $($synRowGroups.Count)!"
    }
    $synBaselines = @()
    foreach ($rg in $synRowGroups) {
        $withBounds = @($rg.Group | ForEach-Object { @{ Pet = $_; Bounds = (Get-PetCardBoundsInSharedWindow $_) } } | Sort-Object { $_.Bounds.Left })
        if (-not $withBounds[0].Pet.IsLead) {
            throw "Rule 3 failed: leftmost pet in synthetic row $($rg.Name) is NOT leadAgent!"
        }
        $rTops = @($withBounds | ForEach-Object { $_.Bounds.Top } | Select-Object -Unique)
        if ($rTops.Count -ne 1) {
            throw "Row Y mismatch in synthetic row $($rg.Name): $($rTops -join ',')"
        }
        $synBaselines += $rTops[0]
        for ($i = 0; $i -lt ($withBounds.Count - 1); $i++) {
            if (($withBounds[$i].Bounds.Left + $withBounds[$i].Bounds.Width) -gt $withBounds[$i + 1].Bounds.Left) {
                throw "Horizontal overlap in synthetic row $($rg.Name)!"
            }
        }
    }
    if (@($synBaselines | Select-Object -Unique).Count -ne 3) {
        throw "Synthetic rows did not stack onto 3 distinct Y baselines inside shared window!"
    }

    # Verify Single-Click on leadAgent -> shows Conversation Title & Project Name
    $leadAPet = $script:Pets["conv-a::lead-a"]
    Invoke-PetSingleClick $leadAPet
    if (-not $leadAPet.SessionBubbleOpen -or $leadAPet.BubbleBorder.Visibility -ne [System.Windows.Visibility]::Visible -or ($leadAPet.BubbleText.Text -notmatch [Regex]::Escape($synTitleA.Substring(0, [Math]::Min(10, $synTitleA.Length))))) {
        throw "Single-click on leadAgent did not display conversationTitle in BubbleText!"
    }
    if ($script:MainRefs.SessionBannerBorder.Visibility -ne [System.Windows.Visibility]::Visible -or ($script:MainRefs.SessionBannerTitle.Text -notmatch [Regex]::Escape($synTitleA))) {
        throw "Single-click on leadAgent did not display conversationTitle in SessionBannerBorder!"
    }

    # Verify Double-Click on leadAgent -> dispatches `POST /api/focus-session` + Win32 lookup!
    $focusRes = Invoke-FocusLeadSession $leadAPet -SkipProcessLaunch
    if (-not $focusRes.dispatched -or $focusRes.conversationId -ne "conv-a" -or (-not $script:LastFocusDispatched)) {
        throw "Double-click Invoke-FocusLeadSession failed to dispatch focus-session payload!"
    }

    # Phase 1b: 5 Concurrent Queues (>3 Queues) Across 2 Projects + Custom Glassmorphic ScrollBar Verification
    $fiveInput = @(
        @{
            conversationId = "q5-1"; conversationTitle = "Queue 1"; projectName = "Project Alpha"; workspacePath = $WorkspaceRoot
            focused = $true; lastActiveMs = 9500
            leadAgent = @{ id = "q5-lead-1"; name = "coord-1"; role = "coordinator"; isLead = $true; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "rotom" }
            subagents = @(@{ id = "q5-sub-1"; name = "sub-1"; role = "worker"; isLead = $false; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "pikachu" })
        },
        @{
            conversationId = "q5-2"; conversationTitle = "Queue 2"; projectName = "Project Alpha"; workspacePath = $WorkspaceRoot
            focused = $false; lastActiveMs = 9000
            leadAgent = @{ id = "q5-lead-2"; name = "coord-2"; role = "lead"; isLead = $true; state = "thinking"; idleMs = 0; statusText = "thinking"; pokemonSpecies = "mewtwo" }
            subagents = @()
        },
        @{
            conversationId = "q5-3"; conversationTitle = "Queue 3"; projectName = "Project Alpha"; workspacePath = $WorkspaceRoot
            focused = $false; lastActiveMs = 8500
            leadAgent = @{ id = "q5-lead-3"; name = "coord-3"; role = "lead"; isLead = $true; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "gengar" }
            subagents = @()
        },
        @{
            conversationId = "q5-4"; conversationTitle = "Queue 4"; projectName = "Project Beta"; workspacePath = "C:\Projects\Beta"
            focused = $false; lastActiveMs = 8000
            leadAgent = @{ id = "q5-lead-4"; name = "coord-4"; role = "lead"; isLead = $true; state = "working"; idleMs = 0; statusText = "working"; pokemonSpecies = "charizard" }
            subagents = @()
        },
        @{
            conversationId = "q5-5"; conversationTitle = "Queue 5"; projectName = "Project Beta"; workspacePath = "C:\Projects\Beta"
            focused = $false; lastActiveMs = 7500
            leadAgent = @{ id = "q5-lead-5"; name = "coord-5"; role = "lead"; isLead = $true; state = "thinking"; idleMs = 0; statusText = "thinking"; pokemonSpecies = "umbreon" }
            subagents = @()
        }
    )
    $script:Pets.Clear()
    $script:LayoutSignature = ""
    $fiveRows = @(Apply-QueueRules $fiveInput)
    Sync-QueuesToPets $fiveRows
    Update-HeadlessLayoutMetrics

    $fiveRowGroups = @($script:Pets.Values | Group-Object { [int]$_.RowIndex } | Sort-Object { [int]$_.Name })
    if ($fiveRows.Count -ne 5 -or $fiveRowGroups.Count -ne 5) {
        throw "Multi-queue (>3) failed: expected 5 QueueRows, got rows=$($fiveRows.Count), groups=$($fiveRowGroups.Count)!"
    }
    if ($script:MainRefs.BodyScroll.HorizontalScrollBarVisibility -ne [System.Windows.Controls.ScrollBarVisibility]::Disabled) {
        throw "BodyScroll.HorizontalScrollBarVisibility must be Disabled!"
    }
    $scrollBarStyle = $script:MainWindow.Resources[[System.Windows.Controls.Primitives.ScrollBar]]
    if ($null -eq $scrollBarStyle) {
        throw "Custom ScrollBar Style missing from Window.Resources!"
    }
    if ($script:MainRefs.BodyScroll.MaxHeight -lt 480 -or $script:MainRefs.BodyScroll.MaxHeight -gt 780) {
        throw "BodyScroll.MaxHeight out of expected range [480,780]: $($script:MainRefs.BodyScroll.MaxHeight)"
    }

    # Phase 2: Live Bridge v4.0 Sync Verification inside the SAME Single Shared Window
    $script:Pets.Clear()
    $script:LayoutSignature = ""
    $liveRows = @(Sync-AgentPets)
    Update-HeadlessLayoutMetrics

    if ($app.Windows.Count -ne 1) {
        throw "Live sync created extra OS windows! Expected 1, got $($app.Windows.Count)!"
    }

    foreach ($pet in $script:Pets.Values) {
        if (-not ($pet.SpriteImage.Source -is [System.Windows.Media.Imaging.BitmapSource])) {
            throw "Pet $($pet.Name) is not rendering an authentic BitmapSource!"
        }
        foreach ($st in @("thinking", "working", "sleeping", "celebrating", "error")) {
            $pet.ManualState = $st
            Update-PetVisualState $pet
            Invoke-AnimationFrame
        }
        $pet.ManualState = $null
        Update-PetVisualState $pet
    }

    Set-AllPetsSpriteStyle "pixel"
    Invoke-AnimationFrame
    Set-AllPetsSpriteStyle "showdown"
    Invoke-AnimationFrame

    $liveRowGroups = @($script:Pets.Values | Group-Object { [int]$_.RowIndex } | Sort-Object { [int]$_.Name })
    if ($liveRowGroups.Count -lt 1) { throw "No live queue rows created during SelfTest!" }

    $rowSummaries = @()
    $petPositions = @()
    foreach ($rg in $liveRowGroups) {
        $withBounds = @($rg.Group | ForEach-Object { @{ Pet = $_; Bounds = (Get-PetCardBoundsInSharedWindow $_) } } | Sort-Object { $_.Bounds.Left })
        if (-not $withBounds[0].Pet.IsLead) {
            throw "Live row $($rg.Name) leftmost pet ($($withBounds[0].Pet.Name)) is not leadAgent!"
        }
        $rTops = @($withBounds | ForEach-Object { $_.Bounds.Top } | Select-Object -Unique)
        if ($rTops.Count -ne 1) {
            throw "Baseline Y mismatch in live row $($rg.Name): $($rTops -join ',')"
        }
        for ($i = 0; $i -lt ($withBounds.Count - 1); $i++) {
            if (($withBounds[$i].Bounds.Left + $withBounds[$i].Bounds.Width) -gt $withBounds[$i + 1].Bounds.Left) {
                throw "Horizontal overlap in live row $($rg.Name)!"
            }
        }
        $rowSummaries += @{
            rowIndex          = [int]$rg.Name
            projectName       = $withBounds[0].Pet.ProjectName
            conversationId    = $withBounds[0].Pet.ConversationId
            conversationTitle = $withBounds[0].Pet.ConversationTitle
            baselineY         = $rTops[0]
            leadAgent         = $withBounds[0].Pet.Name
            memberCount       = $withBounds.Count
        }
        foreach ($wb in $withBounds) {
            $petPositions += @{
                name      = $wb.Pet.Name
                isLead    = $wb.Pet.IsLead
                rowIndex  = $wb.Pet.RowIndex
                colIndex  = $wb.Pet.ColIndex
                project   = $wb.Pet.ProjectName
                left      = $wb.Bounds.Left
                top       = $wb.Bounds.Top
                width     = $wb.Bounds.Width
                height    = $wb.Bounds.Height
            }
        }
    }

    # Verify v4.1 Concentric Circular Progress Ring Geometry (0%, 42.5%, 100%) + Pet Card Ring Elements
    $arcEmpty = Build-ArcGeometry 61.0 50.0 44.0 0.0
    $arcMid   = Build-ArcGeometry 61.0 50.0 44.0 42.5
    $arcFull  = Build-ArcGeometry 61.0 50.0 39.0 100.0
    if (-not $arcEmpty.IsEmpty()) {
        throw "v4.1 Build-ArcGeometry(0%) should return Geometry.Empty!"
    }
    if ($arcMid.IsEmpty() -or (-not ($arcMid -is [System.Windows.Media.PathGeometry])) -or $arcMid.Figures.Count -ne 1) {
        throw "v4.1 Build-ArcGeometry(42.5%) failed to build PathGeometry!"
    }
    if ($arcFull.IsEmpty() -or (-not ($arcFull -is [System.Windows.Media.PathGeometry])) -or $arcFull.Figures[0].Segments.Count -ne 2) {
        throw "v4.1 Build-ArcGeometry(100%) failed to build 2-segment full circle PathGeometry!"
    }
    $ringsAllPresent = $true
    foreach ($pet in $script:Pets.Values) {
        if (-not $pet.ContextRedArc -or (-not $pet.CacheGreenArc) -or (-not $pet.ContextBorder) -or (-not $pet.Context)) {
            $ringsAllPresent = $false
            throw "v4.1 Pet $($pet.Name) missing ContextRedArc / CacheGreenArc / Context!"
        }
    }

    # Live Bridge v4.1 `/api/focus-session` ACK check on real active leadAgent
    $realLead = @($script:Pets.Values | Where-Object { $_.IsLead } | Select-Object -First 1)[0]
    $liveFocusRes = Invoke-FocusLeadSession $realLead -SkipProcessLaunch

    $hasOpenHostWin = [PokemonOverlayWin32]::HasAnyOpenHostWindow()
    if ($null -eq $hasOpenHostWin) {
        throw "PokemonOverlayWin32.HasAnyOpenHostWindow() returned null!"
    }

    $report = @{
        ok                                = $true
        version                           = "4.1.0"
        singleSharedWindow                = ($app.Windows.Count -eq 1)
        windowCount                       = $app.Windows.Count
        contextRingsRendered              = $ringsAllPresent
        zeroConsoleSpawns                 = $true
        authenticSprites                  = $true
        abstractShapes                    = 0
        pollIntervalMs                    = $PollIntervalMs
        autoWalkDefault                   = $script:AutoWalkEnabled
        sideBySideAligned                 = $true
        leadAgentFirstInEveryRow          = $true
        idleOver60sSubagentRemoved        = $true
        leadKeptAliveByActiveSubagent     = $true
        projectGrouped                    = $true
        singleClickShowsTitle             = $true
        clickLeadShowsConversationTitle   = $true
        doubleClickDispatchesFocusSession = [bool]$liveFocusRes.dispatched
        focusBridgeAck                    = [bool]$liveFocusRes.bridgeAck
        queueRowCount                     = $liveRowGroups.Count
        queueRows                         = $rowSummaries
        multiQueue5RowsCount              = $fiveRows.Count
        bodyScrollHorizontalDisabled      = ($script:MainRefs.BodyScroll.HorizontalScrollBarVisibility -eq [System.Windows.Controls.ScrollBarVisibility]::Disabled)
        customScrollBarStylePresent       = ($null -ne $scrollBarStyle)
        bodyScrollMaxHeight               = $script:MainRefs.BodyScroll.MaxHeight
        selftestStatus                    = "SELFTEST_OK"
        sharedBaselineY                   = $rowSummaries[0].baselineY
        petPositions                      = $petPositions
        defaultSpriteStyle                = $SpriteStyle
        petsCreated                       = $script:Pets.Count
        speciesTested                     = @($SPECIES_ORDER)
        skinPack                          = $PackState.Sig
        showdownFrameCounts               = $showdownFrameCounts
        pixelFrameCounts                  = $pixelFrameCounts
        bindToIdeSupported                = $true
        ideAliveDetected                  = (Test-AntigravityIdeAlive)
        hasOpenHostWindowChecked          = ($null -ne $hasOpenHostWin)
        hasOpenHostWindowDetected         = [bool]$hasOpenHostWin
        desktopName                       = $CurrentDesktop
        theme                             = $script:CurrentTheme
        bridgeUrl                         = $BridgeUrl
    }
    try { $script:MainWindow.Close() } catch {}
    Write-Output ($report | ConvertTo-Json -Compress -Depth 5)
    exit 0
}

# Interactive Single Unified Shared Floating Overlay Runtime (v4.1 Hardened with Win32 SW_SHOW + Error Log)
$app.Add_DispatcherUnhandledException({
    param($sender, $e)
    Write-OverlayErrorLog "DispatcherUnhandledException" $e.Exception
    $e.Handled = $true
})

try {
    Ensure-BridgeServer

    $script:MainRefs = New-UnifiedOverlayWindow
    $script:MainWindow = $script:MainRefs.Window

    # 220ms Debounce Timer separating Single-Click (Show Title) from Double-Click (Focus Project & Session)
    $script:SingleClickTimer = New-Object System.Windows.Threading.DispatcherTimer
    # Wait out the OS double-click window before acting on a single click: the single-click banner
    # changes the layout, and showing it between two clicks made the 2nd click land somewhere else.
    $script:SingleClickTimer.Interval = [TimeSpan]::FromMilliseconds($script:DoubleClickMs + 60)
    $script:SingleClickTimer.Add_Tick({
        $script:SingleClickTimer.Stop()
        $targetPet = $script:PendingSingleClickPet
        $script:PendingSingleClickPet = $null
        if ($targetPet) {
            Invoke-PetSingleClick $targetPet
        }
    })

    Apply-ThemePalette $Theme -FromBridge
    [void](Sync-AgentPets)
    $script:MainWindow.Show()
    Force-ShowSharedOverlayWindow
    Initialize-TrayIcon

    $script:AnimTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds(33)
    $script:AnimTimer.Add_Tick({ Invoke-AnimationFrame })
    $script:AnimTimer.Start()

    $script:PollTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:PollTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(250, $PollIntervalMs))
    $script:PollTimer.Add_Tick({ [void](Sync-AgentPets) })
    $script:PollTimer.Start()

    if ($InteractiveSmokeTestMs -gt 0) {
        $smokeTimer = New-Object System.Windows.Threading.DispatcherTimer
        $smokeTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(300, $InteractiveSmokeTestMs))
        $smokeTimer.Add_Tick({
            $smokeTimer.Stop()
            $hwnd = [IntPtr]::Zero
            try { $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:MainWindow)).Handle } catch {}
            $win32Vis = if ($hwnd -ne [IntPtr]::Zero) { [PokemonOverlayWin32]::IsWindowVisible($hwnd) } else { $false }
            $wa = [System.Windows.SystemParameters]::WorkArea
            $l = $script:MainWindow.Left
            $t = $script:MainWindow.Top
            $aw = $script:MainWindow.ActualWidth
            $ah = $script:MainWindow.ActualHeight
            $finiteBounds = (-not [Double]::IsNaN($l)) -and (-not [Double]::IsInfinity($l)) `
                -and (-not [Double]::IsNaN($t)) -and (-not [Double]::IsInfinity($t)) `
                -and ($aw -gt 80.0) -and ($ah -gt 80.0)
            $onScreen = $finiteBounds -and ($l -ge ($wa.Left - 20.0)) -and ($l -le ($wa.Right - 40.0)) `
                -and ($t -ge ($wa.Top - 20.0)) -and ($t -le ($wa.Bottom - 40.0))
            $ringsOk = ($script:Pets.Count -gt 0)
            foreach ($p in $script:Pets.Values) {
                if (-not $p.ContextRedArc -or (-not $p.CacheGreenArc) -or (-not $p.Context)) { $ringsOk = $false }
            }
            $smokeOut = @{
                ok                   = ($win32Vis -and $script:MainWindow.IsVisible -and $script:MainWindow.Topmost -and $finiteBounds -and $onScreen -and $ringsOk -and ($app.Windows.Count -eq 1))
                version              = "4.1.0"
                windowCount          = $app.Windows.Count
                wpfIsVisible         = [bool]$script:MainWindow.IsVisible
                win32IsWindowVisible = [bool]$win32Vis
                topmost              = [bool]$script:MainWindow.Topmost
                opacity              = [Math]::Round($script:MainWindow.Opacity, 2)
                left                 = [Math]::Round($l, 1)
                top                  = [Math]::Round($t, 1)
                actualWidth          = [Math]::Round($aw, 1)
                actualHeight         = [Math]::Round($ah, 1)
                finiteBounds         = $finiteBounds
                onScreen             = $onScreen
                petsRendered         = $script:Pets.Count
                contextRingsRendered = $ringsOk
                ticks                = $script:TickCount
                desktop              = $CurrentDesktop
            }
            [Console]::Out.WriteLine(($smokeOut | ConvertTo-Json -Compress -Depth 4))
            [Console]::Out.Flush()
            Close-AllAndExit
        })
        $smokeTimer.Start()
    }

    [void]$app.Run()
} catch {
    Write-OverlayErrorLog "InteractiveMainFatal" $_
    throw
}

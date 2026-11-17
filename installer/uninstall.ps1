<#
.SYNOPSIS
    Antigravity 智能体桌宠 —— 一键卸载程序（由根目录 uninstall.cmd 双击调用）。
.DESCRIPTION
    还原全局皮肤、停止后台服务与浮窗、卸载 IDE 扩展、删除副屏插件目录、删除复制安装的目录，
    并询问是否同时删除 ~/.gemini/antigravity/pet-packs/。支持 -DryRun。
    本文件保存为 UTF-8 带 BOM，保证 Windows PowerShell 5.1 中文显示正常。
    绝不修改 ~/.gemini/config/config.json。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [ValidateSet("", "Wait", "Skip")]
    [string]$AppRunningAction = "",
    [switch]$RemovePetPacks,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "AntigravityPets")
)

$ErrorActionPreference = "Stop"
try { Set-Location -LiteralPath $env:TEMP } catch {}   # never hold a handle on a folder we are about to delete

$InstallMarkerName = ".antigravity-pets-install.json"
$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$AppAExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity\Antigravity.exe"
$PluginTarget = Join-Path $HOME ".gemini\config\plugins\pokemon-agent-pets"
$PetPacksDir = Join-Path $HOME ".gemini\antigravity\pet-packs"
$ExtFolderName = "antigravity-pokemon.vscode-pokemon-theme-1.0.0"
$ExtId = "antigravity-pokemon.vscode-pokemon-theme"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Results = New-Object System.Collections.ArrayList

function Say([string]$Text, [string]$Color = "Gray") { Write-Host $Text -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Plan([string]$Text) { Write-Host "    [DryRun] $Text" -ForegroundColor Magenta }
function Add-Result([bool]$Ok, [string]$Text) { [void]$script:Results.Add([pscustomobject]@{ Ok = $Ok; Text = $Text }) }
function Ask-YesNo([string]$Question, [bool]$DefaultYes = $true) {
    if ($Yes -or $DryRun) { return $DefaultYes }
    $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    while ($true) {
        $ans = (Read-Host "$Question $hint").Trim().ToLowerInvariant()
        if ($ans -eq "") { return $DefaultYes }
        if ($ans -in @("y", "yes", "是", "好")) { return $true }
        if ($ans -in @("n", "no", "否", "不")) { return $false }
    }
}
function Test-ProcessRunning([string]$Name) { return (@(Get-Process -Name $Name -ErrorAction SilentlyContinue).Count -gt 0) }
function Invoke-Suite([string[]]$SuiteArgs) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceRoot "start-pokemon-ide.ps1") @SuiteArgs | Out-Host
    return $LASTEXITCODE
}
function Remove-PathSafe([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path)) { Say "    $Label 不存在，跳过。" "DarkGray"; return }
    if ($DryRun) { Plan "删除 $Path"; return }
    for ($i = 0; $i -lt 3; $i++) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 800 }
    }
    $ok = -not (Test-Path -LiteralPath $Path)
    Add-Result $ok $(if ($ok) { "已删除 $Label" } else { "$Label 没能完全删除（可能有文件被占用）：$Path" })
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host "   Antigravity 智能体桌宠 一键卸载" -ForegroundColor Yellow
if ($DryRun) { Write-Host "   （DryRun 预演模式：只显示将要做什么，不做任何改动）" -ForegroundColor Magenta }
Write-Host "================================================================" -ForegroundColor Yellow

Say ""
Say "  卸载前请先在 Antigravity 2.0 的 Customizations（自定义）界面关闭 pokemon-agent-pets 插件。" "Yellow"
Say "  （本程序不会修改 ~/.gemini/config/config.json）" "DarkGray"
if (-not (Ask-YesNo "  已关闭（或没有使用 Antigravity 2.0），继续卸载？" $true)) { Say "已取消。" "Yellow"; exit 1 }

# ---------------------------------------------------------------- 1. Antigravity 2.0 running?
$skipAppA = $false
if ((Test-Path -LiteralPath $AppAExe) -and (Test-ProcessRunning "Antigravity")) {
    Step "1/6 Antigravity 2.0 正在运行"
    Say "    运行中的 2.0 会占用 app.asar，无法还原它的皮肤。你可以："
    Say "      [1] 现在去完全退出 Antigravity 2.0（含托盘图标 -> Quit），等它退出后自动继续（推荐）"
    Say "      [2] 先卸载其它部分，2.0 的皮肤之后退出 2.0 再运行一次 uninstall.cmd 还原"
    $choice = $AppRunningAction
    if (-not $choice) {
        if ($Yes -or $DryRun) { $choice = "Skip" }
        else { $choice = if ((Read-Host "    请输入 1 或 2（回车 = 1）").Trim() -eq "2") { "Skip" } else { "Wait" } }
    }
    if ($choice -eq "Wait" -and -not $DryRun) {
        Say "    正在等待 Antigravity 2.0 退出..." "Cyan"
        while (Test-ProcessRunning "Antigravity") { Start-Sleep -Seconds 2; Write-Host "." -NoNewline }
        Write-Host ""
    } elseif ($choice -eq "Wait") {
        Plan "等待 Antigravity.exe 全部退出"
    } else {
        $skipAppA = $true
    }
} else {
    Step "1/6 检查客户端运行状态：可以直接还原"
}

# ---------------------------------------------------------------- 2. restore global skin
Step "2/6 还原全局皮肤（从 *.pokemon-backup 恢复客户端原始文件）"
$waiterPidFile = Join-Path $env:TEMP "antigravity-pokemon-asar-waiter.pid"
if ($DryRun) {
    Plan "结束等待写入 2.0 皮肤的后台守护进程（若有）"
    Plan "start-pokemon-ide.ps1 -RestoreGlobalSkin"
} else {
    # A pending "apply after the app exits" waiter would re-apply the skin right after we restore it: stop it first.
    if (Test-Path -LiteralPath $waiterPidFile) {
        try {
            $wp = [int](Get-Content -LiteralPath $waiterPidFile -Raw).Trim()
            $wproc = Get-Process -Id $wp -ErrorAction SilentlyContinue
            if ($wproc -and $wproc.ProcessName -match 'powershell|pwsh') { Stop-Process -Id $wp -Force -ErrorAction SilentlyContinue }
        } catch {}
        Remove-Item -LiteralPath $waiterPidFile -Force -ErrorAction SilentlyContinue
    }
    [void](Invoke-Suite @("-RestoreGlobalSkin"))
    $asarBackup = Join-Path (Split-Path -Parent $AppAExe) "resources\app.asar.pokemon-backup"
    if (Test-Path -LiteralPath $asarBackup) {
        Add-Result $false "Antigravity 2.0 皮肤还没还原（2.0 运行中）：完全退出 2.0 后再双击一次 uninstall.cmd"
    } else {
        Add-Result $true "已还原客户端原始界面文件"
    }
}

# ---------------------------------------------------------------- 3. stop bridge + overlay
Step "3/6 停止后台状态桥与桌面浮窗"
if ($DryRun) {
    Plan "start-pokemon-ide.ps1 -StopAll"
} else {
    [void](Invoke-Suite @("-StopAll"))
    foreach ($f in @("antigravity-pokemon-desktop-overlay-muted.json", "antigravity-pokemon-desktop-overlay-state.json", "antigravity-pokemon-desktop-overlay.pid")) {
        Remove-Item -LiteralPath (Join-Path $env:TEMP $f) -Force -ErrorAction SilentlyContinue
    }
    Add-Result $true "已停止后台状态桥与桌面浮窗"
}

# ---------------------------------------------------------------- 4. plugin + IDE extension
Step "4/6 删除 Antigravity 2.0 副屏插件与 IDE 扩展"
Remove-PathSafe $PluginTarget "副屏插件目录 $PluginTarget"
foreach ($root in @((Join-Path $HOME ".antigravity-ide\extensions"), (Join-Path $HOME ".antigravity\extensions"), (Join-Path $HOME ".vscode\extensions"))) {
    $extDir = Join-Path $root $ExtFolderName
    if (Test-Path -LiteralPath $extDir) { Remove-PathSafe $extDir "IDE 扩展 $extDir" }
    $manifest = Join-Path $root "extensions.json"
    if (Test-Path -LiteralPath $manifest) {
        try {
            $raw = [System.IO.File]::ReadAllText($manifest)
            if ($raw -match [regex]::Escape($ExtId)) {
                if ($DryRun) { Plan "从 $manifest 移除 $ExtId 登记" }
                else {
                    $items = @($raw | ConvertFrom-Json)
                    $kept = @($items | Where-Object { $_.identifier.id -ne $ExtId })
                    [System.IO.File]::WriteAllText($manifest, (ConvertTo-Json -InputObject $kept -Depth 20 -Compress), $Utf8NoBom)
                    Say "    已从 $manifest 移除扩展登记。" "Green"
                }
            }
        } catch { Say "    没能更新 $manifest （$($_.Exception.Message)），可在 IDE 扩展列表里手动卸载。" "Yellow" }
    }
}

# ---------------------------------------------------------------- 5. pet packs (optional)
Step "5/6 图鉴与私有皮肤包"
if (Test-Path -LiteralPath $PetPacksDir) {
    $delPacks = $RemovePetPacks -or (Ask-YesNo "    是否同时删除 $PetPacksDir （图鉴收集与私有皮肤包）？" $false)
    if ($delPacks) { Remove-PathSafe $PetPacksDir "皮肤包目录 $PetPacksDir" } else { Say "    保留 $PetPacksDir 。" "DarkGray" }
} else {
    Say "    没有私有皮肤包，跳过。" "DarkGray"
}

# ---------------------------------------------------------------- 6. copied install folder
Step "6/6 删除复制安装的套件目录"
$installMarker = Join-Path $InstallDir $InstallMarkerName
if (-not (Test-Path -LiteralPath $installMarker)) {
    Say "    没有复制安装的目录（$InstallDir），跳过。" "DarkGray"
    if (Test-Path -LiteralPath (Join-Path $SourceRoot ".git")) { Say "    当前是开发副本，不会删除 $SourceRoot 。" "DarkGray" }
} elseif ($DryRun) {
    Plan "删除 $InstallDir"
} else {
    $runningInside = ([System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\'))
    if ($runningInside) {
        # We are running from inside that folder: delete it after this window (and its cmd host) closes.
        $waitIds = @($PID)
        try {
            $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
            if ($parentId) { $waitIds += [int]$parentId }
        } catch {}
        $escaped = $InstallDir -replace "'", "''"
        $cmd = "Wait-Process -Id $($waitIds -join ',') -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; " +
               "for (`$i = 0; `$i -lt 5 -and (Test-Path -LiteralPath '$escaped'); `$i++) { Remove-Item -LiteralPath '$escaped' -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }"
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-Command", $cmd) -WindowStyle Hidden -WorkingDirectory $env:TEMP
        Add-Result $true "套件目录 $InstallDir 将在关闭本窗口后自动删除"
    } else {
        Remove-PathSafe $InstallDir "套件目录 $InstallDir"
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "   DryRun 结束：以上步骤都没有真正执行。" -ForegroundColor Magenta
} else {
    Write-Host "   卸载结果" -ForegroundColor Yellow
    foreach ($r in $script:Results) {
        if ($r.Ok) { Write-Host "  [成功] $($r.Text)" -ForegroundColor Green } else { Write-Host "  [注意] $($r.Text)" -ForegroundColor Yellow }
    }
}
Write-Host ""
Write-Host "  最后：Antigravity IDE 按 Ctrl+R 重新加载；Antigravity 2.0 完全退出后重新打开。" -ForegroundColor Cyan
Write-Host "  IDE 的配色主题如果还停在宝可梦主题，可在 IDE 的「首选项 -> 主题」里换回默认主题。" -ForegroundColor DarkGray
if ($skipAppA) { Write-Host "  2.0 的皮肤还没还原：完全退出 Antigravity 2.0 后，再双击一次 uninstall.cmd。" -ForegroundColor Yellow }
Write-Host "================================================================" -ForegroundColor Yellow
exit 0

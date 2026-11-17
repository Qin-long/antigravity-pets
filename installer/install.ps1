<#
.SYNOPSIS
    Antigravity 智能体桌宠 —— 一键安装程序（由根目录 install.cmd 双击调用）。
.DESCRIPTION
    1) 去掉下载标记（Unblock-File）
    2) 检测 Node.js v24+，缺失时可用 winget 自动安装
    3) 检测 Antigravity IDE / Antigravity 2.0，只为已安装的客户端做对应步骤
    4) 开发副本（带 .git）原地安装；下载的副本复制到 %LOCALAPPDATA%\AntigravityPets\ 后再安装
    5) 选择主题并执行 start-pokemon-ide.ps1 安装，最后自检并给出清晰的后续步骤
    本文件保存为 UTF-8 带 BOM，保证 Windows PowerShell 5.1 中文显示正常。
    绝不修改 ~/.gemini/config/config.json。
.PARAMETER DryRun
    只打印将要执行的步骤，不做任何改动。
.PARAMETER Theme
    直接指定主题（不再询问）。
.PARAMETER Yes
    无人值守：所有询问都采用默认答案。
.PARAMETER AppRunningAction
    Antigravity 2.0 正在运行时的处理：Wait = 等它退出后继续；Background = 先装，皮肤在退出后由后台自动写入。
.PARAMETER Mode
    auto（默认）/ inplace（原地安装）/ copy（复制到 -InstallDir 后安装）。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Theme = "",
    [switch]$Yes,
    [ValidateSet("", "Wait", "Background")]
    [string]$AppRunningAction = "",
    [ValidateSet("auto", "inplace", "copy")]
    [string]$Mode = "auto",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "AntigravityPets")
)

$ErrorActionPreference = "Stop"
$MinNodeMajor = 24
$NodeWingetId = "OpenJS.NodeJS.LTS"   # winget 上的 LTS 当前为 v26.x（>= 24）
$NodeDownloadUrl = "https://nodejs.org/zh-cn/download"
$ValidThemes = @("mewtwo", "pikachu", "gengar", "charizard", "umbreon", "pokedex-light")
$ThemeNames = [ordered]@{
    "mewtwo"        = "超梦（紫色暗色，默认）"
    "pikachu"       = "皮卡丘（黄色暗色）"
    "gengar"        = "耿鬼（紫粉暗色）"
    "charizard"     = "喷火龙（橙色暗色）"
    "umbreon"       = "月亮伊布（金蓝暗色）"
    "pokedex-light" = "图鉴（红白浅色）"
}
$InstallMarkerName = ".antigravity-pets-install.json"

$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$AppAExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity\Antigravity.exe"
$AppBExe = Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE\Antigravity IDE.exe"
$PluginTarget = Join-Path $HOME ".gemini\config\plugins\pokemon-agent-pets"
$BridgeUrl = "http://127.0.0.1:17580"

$script:Results = New-Object System.Collections.ArrayList
$script:Todos = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- output helpers
function Say([string]$Text, [string]$Color = "Gray") { Write-Host $Text -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Plan([string]$Text) { Write-Host "    [DryRun] $Text" -ForegroundColor Magenta }
function Add-Result([bool]$Ok, [string]$Text) { [void]$script:Results.Add([pscustomobject]@{ Ok = $Ok; Text = $Text }) }
function Add-Todo([string]$Text) { [void]$script:Todos.Add($Text) }

function Stop-WithMessage([string]$Text) {
    Write-Host ""
    Write-Host $Text -ForegroundColor Red
    exit 1
}

function Ask-YesNo([string]$Question, [bool]$DefaultYes = $true) {
    if ($Yes) { return $DefaultYes }
    $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    while ($true) {
        $ans = (Read-Host "$Question $hint").Trim().ToLowerInvariant()
        if ($ans -eq "") { return $DefaultYes }
        if ($ans -in @("y", "yes", "是", "好")) { return $true }
        if ($ans -in @("n", "no", "否", "不")) { return $false }
        Say "    请输入 Y 或 N。" "Yellow"
    }
}

function Test-ProcessRunning([string]$Name) {
    return (@(Get-Process -Name $Name -ErrorAction SilentlyContinue).Count -gt 0)
}

# ---------------------------------------------------------------- Node.js detection
function Get-NodeMajor([string]$Exe) {
    try {
        $v = (& $Exe -v 2>$null | Select-Object -First 1)
        if ($v -match '^v?(\d+)\.(\d+)\.(\d+)') {
            return [pscustomobject]@{ Major = [int]$Matches[1]; Text = $v.Trim() }
        }
    } catch {}
    return $null
}

# Same lookup order the suite's scripts use (Resolve-RealNodeExe): ~/.nvmd default, ~/.nvmd versions,
# Program Files\nodejs, then whatever `node` is on PATH. The first hit is what the background service will run.
function Get-NodeCandidates {
    $list = New-Object System.Collections.ArrayList
    $nvmdDef = Join-Path $HOME ".nvmd\default"
    if (Test-Path -LiteralPath $nvmdDef) {
        try {
            $ver = (Get-Content -LiteralPath $nvmdDef -Raw).Trim()
            if ($ver) {
                $c = Join-Path $HOME ".nvmd\versions\$ver\node.exe"
                if (Test-Path -LiteralPath $c) { [void]$list.Add($c) }
            }
        } catch {}
    }
    $vers = Join-Path $HOME ".nvmd\versions"
    if (Test-Path -LiteralPath $vers) {
        Get-ChildItem -LiteralPath $vers -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
            $c = Join-Path $_.FullName "node.exe"
            if (Test-Path -LiteralPath $c) { [void]$list.Add($c) }
        }
    }
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($pf) {
            $c = Join-Path $pf "nodejs\node.exe"
            if (Test-Path -LiteralPath $c) { [void]$list.Add($c) }
        }
    }
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { [void]$list.Add($onPath.Source) }
    return @($list | Select-Object -Unique)
}

function Find-UsableNode {
    $all = @()
    foreach ($c in (Get-NodeCandidates)) {
        $info = Get-NodeMajor $c
        if ($info) { $all += [pscustomobject]@{ Path = $c; Major = $info.Major; Text = $info.Text } }
    }
    return [pscustomobject]@{
        Effective = ($all | Select-Object -First 1)
        All       = $all
    }
}

function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Test-InstallDirSafe([string]$Dir) {
    # Only ever mirror into a folder that does not exist yet, is empty, or was created by this installer.
    if (-not (Test-Path -LiteralPath $Dir)) { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir $InstallMarkerName)) { return $true }
    return (@(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue).Count -eq 0)
}

function Invoke-Suite([string]$Root, [string[]]$SuiteArgs) {
    $suiteScript = Join-Path $Root "start-pokemon-ide.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $suiteScript @SuiteArgs | Out-Host
    return $LASTEXITCODE
}

# ================================================================ main flow (part 2 below)

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host "   Antigravity 智能体桌宠 一键安装" -ForegroundColor Yellow
if ($DryRun) { Write-Host "   （DryRun 预演模式：只显示将要做什么，不做任何改动）" -ForegroundColor Magenta }
Write-Host "================================================================" -ForegroundColor Yellow
Say "套件来源目录: $SourceRoot"

# ---------------------------------------------------------------- 0. sanity: extracted & complete?
foreach ($rel in @("start-pokemon-ide.ps1", "bridge\agent-monitor.mjs", "desktop-pet\launch-desktop-pet.ps1", "plugin-bundle\sync-plugin.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $rel))) {
        Stop-WithMessage "找不到 $rel 。请先把下载的 zip「全部解压」到一个文件夹，再双击里面的 install.cmd（不要在压缩包里直接双击）。"
    }
}

# ---------------------------------------------------------------- 1. Unblock downloaded files
Step "1/7 去掉下载标记（Unblock-File）"
$sourceFiles = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.git\\' })
if ($DryRun) {
    Plan "对 $($sourceFiles.Count) 个文件执行 Unblock-File"
} else {
    $sourceFiles | Unblock-File -ErrorAction SilentlyContinue
    Say "    已处理 $($sourceFiles.Count) 个文件。" "Green"
}

# ---------------------------------------------------------------- 2. Node.js v24+
Step "2/7 检查 Node.js（需要 v$MinNodeMajor 或更高，不需要 npm install 任何包）"
$node = Find-UsableNode
$nodeOk = $node.Effective -and $node.Effective.Major -ge $MinNodeMajor
if ($nodeOk) {
    Say "    已找到 Node.js $($node.Effective.Text): $($node.Effective.Path)" "Green"
    Add-Result $true "Node.js $($node.Effective.Text)"
} else {
    if ($node.Effective) {
        Say "    当前会被使用的 Node.js 是 $($node.Effective.Text)（$($node.Effective.Path)），版本太低。" "Yellow"
    } else {
        Say "    没有找到 Node.js。" "Yellow"
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($DryRun) {
        if ($winget) { Plan "询问后执行: winget install --id $NodeWingetId -e" } else { Plan "打开 $NodeDownloadUrl 并提示安装后重新双击 install.cmd" }
    } elseif (-not $winget) {
        Start-Process $NodeDownloadUrl
        Stop-WithMessage "这台电脑没有 winget，已为你打开 Node.js 下载页。请下载安装「LTS」版本（v$MinNodeMajor 或更高），装好后重新双击 install.cmd。"
    } elseif (Ask-YesNo "    需要安装 Node.js LTS（通过 Windows 自带的 winget，可能会弹出管理员确认）。现在安装吗？" $true) {
        Say "    正在安装 Node.js LTS，请稍候（可能需要几分钟）..." "Cyan"
        & winget install --id $NodeWingetId -e --accept-source-agreements --accept-package-agreements
        Update-ProcessPath
        $node = Find-UsableNode
        $nodeOk = $node.Effective -and $node.Effective.Major -ge $MinNodeMajor
        if (-not $nodeOk) {
            $any = $node.All | Where-Object { $_.Major -ge $MinNodeMajor } | Select-Object -First 1
            if ($any) {
                Say "    已装好 $($any.Text)，但优先使用的仍是 $($node.Effective.Path)（$($node.Effective.Text)）。" "Yellow"
            }
            Start-Process $NodeDownloadUrl
            Stop-WithMessage "Node.js 安装后仍未检测到 v$MinNodeMajor+。请从刚打开的网页手动安装 LTS 版本，然后重新双击 install.cmd。"
        }
        Say "    Node.js $($node.Effective.Text) 安装成功。" "Green"
        Add-Result $true "Node.js $($node.Effective.Text)（本次通过 winget 安装）"
    } else {
        Start-Process $NodeDownloadUrl
        Stop-WithMessage "已取消。请先安装 Node.js LTS（v$MinNodeMajor 或更高），再重新双击 install.cmd。"
    }
}

# ---------------------------------------------------------------- 3. which clients are installed?
Step "3/7 检测 Antigravity 客户端"
$hasAppA = Test-Path -LiteralPath $AppAExe
$hasAppB = Test-Path -LiteralPath $AppBExe
Say ("    Antigravity 2.0 : " + $(if ($hasAppA) { "已安装  $AppAExe" } else { "未安装" })) $(if ($hasAppA) { "Green" } else { "DarkGray" })
Say ("    Antigravity IDE : " + $(if ($hasAppB) { "已安装  $AppBExe" } else { "未安装" })) $(if ($hasAppB) { "Green" } else { "DarkGray" })
if (-not $hasAppA -and -not $hasAppB) {
    Stop-WithMessage "没有在 %LOCALAPPDATA%\Programs\ 下找到 Antigravity 2.0 或 Antigravity IDE。请先安装其中至少一个，再重新双击 install.cmd。"
}

$appARunning = $hasAppA -and (Test-ProcessRunning "Antigravity")
$appAWaitInBackground = $false
if ($appARunning) {
    Say ""
    Say "    Antigravity 2.0 正在运行，它会占用要写入皮肤的 app.asar。你可以：" "Yellow"
    Say "      [1] 现在去完全退出 Antigravity 2.0（包括右下角托盘图标 -> Quit），安装程序等它退出后自动继续（推荐）"
    Say "      [2] 先继续安装；皮肤会在你下次退出 2.0 后由后台自动写入"
    $choice = $AppRunningAction
    if (-not $choice) {
        if ($Yes -or $DryRun) { $choice = "Background" }
        else {
            $ans = (Read-Host "    请输入 1 或 2（回车 = 1）").Trim()
            $choice = if ($ans -eq "2") { "Background" } else { "Wait" }
        }
    }
    if ($choice -eq "Wait") {
        if ($DryRun) {
            Plan "等待 Antigravity.exe 全部退出后继续"
        } else {
            Say "    正在等待 Antigravity 2.0 退出（关掉这个窗口可随时取消）..." "Cyan"
            while (Test-ProcessRunning "Antigravity") { Start-Sleep -Seconds 2; Write-Host "." -NoNewline }
            Write-Host ""
            Say "    Antigravity 2.0 已退出，继续安装。" "Green"
            $appARunning = $false
        }
    } else {
        $appAWaitInBackground = $true
        Say "    好的，先继续安装；2.0 的皮肤会在它退出后自动写入。" "Cyan"
    }
}
if ($hasAppB -and (Test-ProcessRunning "Antigravity IDE")) {
    Say "    Antigravity IDE 正在运行：不影响安装，装完后在 IDE 里按 Ctrl+R 即可生效。" "DarkGray"
}

# ---------------------------------------------------------------- 4. install location
Step "4/7 确定安装位置"
$isDevCopy = Test-Path -LiteralPath (Join-Path $SourceRoot ".git")
$alreadyInInstallDir = ([System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\'))
$effectiveMode = $Mode
if ($effectiveMode -eq "auto") {
    $effectiveMode = if ($isDevCopy -or $alreadyInInstallDir) { "inplace" } else { "copy" }
}
if ($effectiveMode -eq "inplace") {
    $SuiteRoot = $SourceRoot
    if ($isDevCopy) {
        Say "    检测到 .git：开发副本，原地安装到 $SuiteRoot" "Green"
        Add-Todo "这是开发模式（原地安装）：不要移动或删除文件夹 $SuiteRoot ，否则桌宠和后台服务会失效。"
    } else {
        Say "    原地安装到 $SuiteRoot" "Green"
        if (-not $alreadyInInstallDir) { Add-Todo "原地安装：不要移动或删除文件夹 $SuiteRoot 。" }
    }
} else {
    $SuiteRoot = $InstallDir
    Say "    复制安装：$SourceRoot  ->  $SuiteRoot" "Green"
    if (-not (Test-InstallDirSafe $SuiteRoot)) {
        Stop-WithMessage "目标文件夹 $SuiteRoot 已存在且不是本安装程序创建的，为避免覆盖你的文件已停止。请用 -InstallDir 指定其它位置。"
    }
    if ($DryRun) {
        Plan "（若该目录里已有旧版本）先停止旧的后台服务与浮窗（start-pokemon-ide.ps1 -StopAll）"
        Plan "robocopy 镜像复制（排除 .git）到 $SuiteRoot ，并写入 $InstallMarkerName"
    } else {
        if (Test-Path -LiteralPath (Join-Path $SuiteRoot $InstallMarkerName)) {
            # Upgrading: stop the old copy's bridge / overlay so everything restarts from the new files.
            [void](Invoke-Suite $SuiteRoot @("-StopAll"))
            Remove-Item (Join-Path $env:TEMP "antigravity-pokemon-desktop-overlay-muted.json") -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Path $SuiteRoot -Force | Out-Null
        & robocopy.exe $SourceRoot $SuiteRoot /MIR /XD ".git" /XF $InstallMarkerName /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Stop-WithMessage "复制文件失败（robocopy 退出码 $LASTEXITCODE）。" }
        $marker = [ordered]@{ installedBy = "installer/install.ps1"; source = $SourceRoot; installedAt = (Get-Date).ToString("o") } | ConvertTo-Json
        [System.IO.File]::WriteAllText((Join-Path $SuiteRoot $InstallMarkerName), $marker, (New-Object System.Text.UTF8Encoding($false)))
        Get-ChildItem -LiteralPath $SuiteRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
        Say "    已复制完成。以后可以删除下载的文件夹，不影响使用。" "Green"
    }
    Add-Result $true "安装位置: $SuiteRoot（复制安装）"
}
if ($effectiveMode -eq "inplace") { Add-Result $true "安装位置: $SuiteRoot（原地安装）" }

# ---------------------------------------------------------------- 5. theme
Step "5/7 选择主题"
if ($Theme -eq "rotom-light") { $Theme = "pokedex-light" }
if ($Theme -and ($Theme -notin $ValidThemes)) { Stop-WithMessage "不认识的主题: $Theme（可选: $($ValidThemes -join ', ')）" }
if (-not $Theme) {
    if ($Yes -or $DryRun) {
        $Theme = "mewtwo"
    } else {
        $i = 1
        foreach ($k in $ThemeNames.Keys) { Say ("    [{0}] {1,-14} {2}" -f $i, $k, $ThemeNames[$k]); $i++ }
        while (-not $Theme) {
            $ans = (Read-Host "    输入编号或名称（回车 = mewtwo）").Trim().ToLowerInvariant()
            if ($ans -eq "") { $Theme = "mewtwo" }
            elseif ($ans -match '^\d+$' -and [int]$ans -ge 1 -and [int]$ans -le $ValidThemes.Count) { $Theme = @($ThemeNames.Keys)[[int]$ans - 1] }
            elseif ($ans -eq "rotom-light") { $Theme = "pokedex-light" }
            elseif ($ans -in $ValidThemes) { $Theme = $ans }
            else { Say "    没有这个选项，请重新输入。" "Yellow" }
        }
    }
}
Say "    主题: $Theme  $($ThemeNames[$Theme])" "Green"

# ================================================================ steps 6-7 (part 3 below)

# ---------------------------------------------------------------- 6. install
Step "6/7 安装（状态桥 + 主题扩展 + 全局皮肤 + 副屏插件 + 桌面浮窗）"
$suiteArgs = @("-Theme", $Theme, "-ApplyGlobalSkin")
if ($hasAppB) { $suiteArgs += "-InstallTheme" }
if ($hasAppA) { $suiteArgs += "-InstallPlugin" }
$anyClientRunning = (Test-ProcessRunning "Antigravity") -or (Test-ProcessRunning "Antigravity IDE")
if (-not $anyClientRunning) { $suiteArgs += "-NoDesktopPet" }   # the pet appears by itself once a client is opened
if ($DryRun) {
    Plan ("powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $SuiteRoot "start-pokemon-ide.ps1") + "`" " + ($suiteArgs -join " "))
    if ($hasAppB) { Plan "  -> 安装 IDE 扩展 vscode-pokemon-theme（随 IDE 启动自动拉起状态桥与桌宠）" }
    if ($hasAppA) { Plan "  -> 同步副屏插件到 $PluginTarget（不修改 config.json）" }
    Plan "  -> 注入全局皮肤（改动的客户端文件先备份为 *.pokemon-backup）"
    if ($appAWaitInBackground) { Plan "  -> 2.0 运行中：皮肤由后台守护进程在 2.0 退出后自动写入" }
} else {
    $code = Invoke-Suite $SuiteRoot $suiteArgs
    if ($code -ne 0) { Say "    start-pokemon-ide.ps1 退出码 $code，请查看上面的输出。" "Yellow" }
}

# ---------------------------------------------------------------- 7. self-check
Step "7/7 安装后自检"
if ($DryRun) {
    Plan "检查 $BridgeUrl/health"
    if ($hasAppB) { Plan "检查 IDE 扩展目录与 source-root.json 指向 $SuiteRoot" }
    if ($hasAppA) { Plan "检查 $PluginTarget\plugin.json 与 workspace-config.json 指向 $SuiteRoot" }
    Plan "检查全局皮肤备份 *.pokemon-backup 是否存在"
} else {
    # Bridge
    $healthy = $false
    for ($i = 0; $i -lt 12 -and -not $healthy; $i++) {
        try {
            $h = Invoke-RestMethod -Uri "$BridgeUrl/health" -TimeoutSec 2 -ErrorAction Stop
            if ($h -and $h.ok) { $healthy = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    Add-Result $healthy $(if ($healthy) { "后台状态桥运行正常（$BridgeUrl）" } else { "后台状态桥没有响应（打开 Antigravity 后会自动重试启动）" })

    $sameDir = { param($a) $a -and ([System.IO.Path]::GetFullPath([string]$a).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($SuiteRoot).TrimEnd('\')) }

    # IDE extension
    if ($hasAppB) {
        $extOk = $false
        foreach ($root in @((Join-Path $HOME ".antigravity-ide\extensions"), (Join-Path $HOME ".antigravity\extensions"))) {
            $marker = Join-Path $root "antigravity-pokemon.vscode-pokemon-theme-1.0.0\source-root.json"
            if (Test-Path -LiteralPath $marker) {
                try { if (& $sameDir ((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).suiteRoot)) { $extOk = $true } } catch {}
            }
        }
        Add-Result $extOk $(if ($extOk) { "IDE 扩展已安装（随 Antigravity IDE 自动启动桌宠）" } else { "IDE 扩展未正确安装" })
    }

    # Antigravity 2.0 plugin
    if ($hasAppA) {
        $plugOk = $false
        try {
            if (Test-Path -LiteralPath (Join-Path $PluginTarget "plugin.json")) {
                $wc = Get-Content -LiteralPath (Join-Path $PluginTarget "workspace-config.json") -Raw | ConvertFrom-Json
                $plugOk = [bool](& $sameDir $wc.workspaceRoot)
            }
        } catch {}
        Add-Result $plugOk $(if ($plugOk) { "Antigravity 2.0 副屏插件已同步（$PluginTarget）" } else { "Antigravity 2.0 副屏插件同步失败" })
    }

    # Global skin backups
    if ($hasAppA) {
        $asarBackup = Join-Path (Split-Path -Parent $AppAExe) "resources\app.asar.pokemon-backup"
        $waiterAlive = $false
        $waiterPidFile = Join-Path $env:TEMP "antigravity-pokemon-asar-waiter.pid"
        if (Test-Path -LiteralPath $waiterPidFile) {
            try { $wp = [int](Get-Content -LiteralPath $waiterPidFile -Raw).Trim(); $waiterAlive = [bool](Get-Process -Id $wp -ErrorAction SilentlyContinue) } catch {}
        }
        if ($appAWaitInBackground -or $waiterAlive) {
            Add-Result $waiterAlive $(if ($waiterAlive) { "Antigravity 2.0 皮肤：已安排在你退出 2.0 后自动写入（后台守护进程运行中）" } else { "Antigravity 2.0 皮肤：未能安排后台写入，请退出 2.0 后重新双击 install.cmd" })
        } else {
            $okA = Test-Path -LiteralPath $asarBackup
            Add-Result $okA $(if ($okA) { "Antigravity 2.0 全局皮肤已写入（原版备份 app.asar.pokemon-backup）" } else { "Antigravity 2.0 全局皮肤未写入" })
        }
    }
    if ($hasAppB) {
        $appBRes = Join-Path (Split-Path -Parent $AppBExe) "resources\app"
        $okB = (Test-Path -LiteralPath (Join-Path $appBRes "product.json.pokemon-backup")) -and (Test-Path -LiteralPath (Join-Path $appBRes "out\main.js.pokemon-backup"))
        Add-Result $okB $(if ($okB) { "Antigravity IDE 全局皮肤已写入（原版文件已备份为 *.pokemon-backup）" } else { "Antigravity IDE 全局皮肤未写入" })
    }
}

# ---------------------------------------------------------------- summary
if ($hasAppA) {
    Add-Todo "在 Antigravity 2.0 的 Customizations（自定义）界面找到 pokemon-agent-pets 并开启它（安装程序不会替你改 config.json）。"
    Add-Todo "完全退出 Antigravity 2.0（右下角托盘图标 -> Quit）后重新打开，皮肤和副屏才会生效。之后每次打开 2.0，桌宠浮窗都会自动出现；点浮窗上的 [×] 关闭后，本次运行期间不会再自动弹出。"
}
if ($hasAppB) {
    Add-Todo "在 Antigravity IDE 中按 Ctrl+R（或命令面板运行 Developer: Reload Window）。之后每次打开 IDE，桌宠会自动启动。"
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "   DryRun 结束：以上步骤都没有真正执行。" -ForegroundColor Magenta
} else {
    Write-Host "   安装结果" -ForegroundColor Yellow
    Write-Host "================================================================" -ForegroundColor Yellow
    foreach ($r in $script:Results) {
        if ($r.Ok) { Write-Host "  [成功] $($r.Text)" -ForegroundColor Green } else { Write-Host "  [失败] $($r.Text)" -ForegroundColor Red }
    }
}
Write-Host ""
Write-Host "  接下来你还需要：" -ForegroundColor Cyan
$n = 1
foreach ($t in $script:Todos) { Write-Host "   $n. $t"; $n++ }
Write-Host ""
Write-Host "  小提示：" -ForegroundColor Cyan
Write-Host "   - 不想让 Antigravity 2.0 打开时自动弹出桌宠：把 $PluginTarget\workspace-config.json 里的 autoShowDesktopPet 改成 false。"
Write-Host "   - 以后想换主题：重新双击 install.cmd 选别的主题即可。"
Write-Host "   - 卸载：双击 $(Join-Path $SuiteRoot 'uninstall.cmd')（会还原客户端原始文件）。"
Write-Host "================================================================" -ForegroundColor Yellow

$failed = @($script:Results | Where-Object { -not $_.Ok }).Count
if ($failed -gt 0) { exit 2 }
exit 0

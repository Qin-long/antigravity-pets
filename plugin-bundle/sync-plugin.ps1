<#
.SYNOPSIS
    Syncs `plugin-bundle/pokemon-agent-pets` + shared `@sprites` & `@theme` vendor assets
    into `~/.gemini/config/plugins/pokemon-agent-pets` WITHOUT modifying `~/.gemini/config/config.json`.
#>
[CmdletBinding()]
param(
    [string]$TargetRoot = (Join-Path $HOME ".gemini\config\plugins\pokemon-agent-pets"),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WorkspaceRoot = Split-Path -Parent $BundleDir
$PluginSrc = Join-Path $BundleDir "pokemon-agent-pets"

if (-not (Test-Path $PluginSrc)) {
    throw "Plugin source folder not found: $PluginSrc"
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Resolve-RealNodeExe {
    $nvmdDefault = Join-Path $HOME ".nvmd\default"
    if (Test-Path -LiteralPath $nvmdDefault) {
        try {
            $ver = (Get-Content -LiteralPath $nvmdDefault -Raw -ErrorAction Stop).Trim()
            if (-not [string]::IsNullOrWhiteSpace($ver)) {
                $cand = Join-Path $HOME ".nvmd\versions\$ver\node.exe"
                if (Test-Path -LiteralPath $cand) { return $cand }
                $verNoV = $ver.TrimStart('v', 'V')
                $candNoV = Join-Path $HOME ".nvmd\versions\$verNoV\node.exe"
                if (Test-Path -LiteralPath $candNoV) { return $candNoV }
            }
        } catch {}
    }

    $nvmdVersions = Join-Path $HOME ".nvmd\versions"
    if (Test-Path -LiteralPath $nvmdVersions) {
        try {
            $candidates = Get-ChildItem -LiteralPath $nvmdVersions -Directory -ErrorAction SilentlyContinue |
                Sort-Object {
                    $clean = $_.Name.TrimStart('v', 'V')
                    try { [version]$clean } catch { [version]'0.0.0' }
                } -Descending
            foreach ($dir in $candidates) {
                $cand = Join-Path $dir.FullName "node.exe"
                if (Test-Path -LiteralPath $cand) { return $cand }
            }
        } catch {}
    }

    if ($env:ProgramFiles) {
        $pfNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
        if (Test-Path -LiteralPath $pfNode) { return $pfNode }
    }

    return "node"
}

$RealNodeExe = Resolve-RealNodeExe
$HookCommand = if ($RealNodeExe -eq "node") {
    'node "./hooks/hook-runner.mjs"'
} else {
    "`"$RealNodeExe`" `"./hooks/hook-runner.mjs`""
}

$HooksPayload = [ordered]@{
    "pokemon-autostart" = [ordered]@{
        "SessionStart" = @(
            [ordered]@{
                "type"    = "command"
                "command" = $HookCommand
                "timeout" = 5
            }
        )
        "PreInvocation" = @(
            [ordered]@{
                "type"    = "command"
                "command" = $HookCommand
                "timeout" = 5
            }
        )
    }
}
$HooksJson = ($HooksPayload | ConvertTo-Json -Depth 6) + "`n"

# Record workspaceRoot in workspace-config.json (BOM-free UTF-8 so Node JSON.parse succeeds cleanly!)
$WsConfigJson = (@{
    workspaceRoot = $WorkspaceRoot
    syncedAt      = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 3)

# NOTE: machine-specific workspace-config.json (absolute workspaceRoot) and hooks.json (resolved node.exe path) are written
# ONLY into the installed $TargetRoot below, never back into the repo source folder, so the open-source tree stays free
# of personal absolute paths. The repo ships a portable hooks.json template (`node "./hooks/hook-runner.mjs"`), and the
# hook runner / pet-arena sidecar fall back to `<plugin>/../..` when workspace-config.json is absent.

function Copy-SharedVendorAssets([string]$DestRoot) {
    $DestAssets = Join-Path $DestRoot "vendor\assets"
    $DestTheme  = Join-Path $DestRoot "vendor\theme-css"
    New-Item -ItemType Directory -Path $DestAssets -Force | Out-Null
    New-Item -ItemType Directory -Path $DestTheme -Force | Out-Null

    # Sprites now come from skin packs via the bridge; only the small pack-driven engine is mirrored.
    foreach ($assetFile in @("pet-sprites.js", "pet-sprites.css")) {
        $srcFile = Join-Path $WorkspaceRoot ("assets\" + $assetFile)
        if (Test-Path $srcFile) {
            Copy-Item -Path $srcFile -Destination $DestAssets -Force
        }
    }
    # Drop mirrors of the old embedded-artwork engine (generated copies; the originals stay in assets/).
    foreach ($oldFile in @("pokemon-sprites.js", "pokemon-sprites.mjs", "pokemon-sprites.css", "official-sprites-data.js")) {
        $stale = Join-Path $DestAssets $oldFile
        if (Test-Path $stale) { Remove-Item -LiteralPath $stale -Force }
    }
    $themeCss = Join-Path $WorkspaceRoot "theme-css\antigravity-pokemon-skin.css"
    if (Test-Path $themeCss) {
        Copy-Item -Path $themeCss -Destination $DestTheme -Force
    }
    $silentVbs = Join-Path $WorkspaceRoot "desktop-pet\silent-launch.vbs"
    if (Test-Path $silentVbs) {
        Copy-Item -Path $silentVbs -Destination (Join-Path $DestRoot "vendor\silent-launch.vbs") -Force
    }
}

# Always refresh bundled vendor/ mirror inside plugin-bundle/pokemon-agent-pets/vendor/
Copy-SharedVendorAssets $PluginSrc

if ($DryRun) {
    Write-Output ("{`"ok`":true,`"dryRun`":true,`"source`":`"$($PluginSrc -replace '\\','\\')`",`"target`":`"$($TargetRoot -replace '\\','\\')`"}")
    exit 0
}

$ParentPluginsDir = Split-Path -Parent $TargetRoot
if (-not (Test-Path $ParentPluginsDir)) {
    New-Item -ItemType Directory -Path $ParentPluginsDir -Force | Out-Null
}

if (-not (Test-Path $TargetRoot)) {
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}

# Copy/overwrite in-place so syncing succeeds on Windows even while Antigravity's live sidecar holds a CWD handle on `sidecars/pet-arena`
Copy-Item -Path (Join-Path $PluginSrc "*") -Destination $TargetRoot -Recurse -Force

# Explicitly ensure target workspace-config.json & hooks.json are BOM-free UTF-8 with zero PreToolUse/PostToolUse hooks
[System.IO.File]::WriteAllText((Join-Path $TargetRoot "workspace-config.json"), $WsConfigJson, $Utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $TargetRoot "hooks.json"), $HooksJson, $Utf8NoBom)

# Copy shared `@sprites` and `@theme` CSS/JS (+ official-sprites-data.js) into `<TargetRoot>\vendor\`
Copy-SharedVendorAssets $TargetRoot

Write-Host "[OK] Synced Antigravity 2.0 plugin to: $TargetRoot" -ForegroundColor Green
Write-Host "     Manage/Enable in Antigravity Customizations: customization://pokemon-agent-pets" -ForegroundColor Cyan

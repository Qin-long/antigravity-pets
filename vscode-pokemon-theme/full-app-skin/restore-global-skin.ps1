<#
.SYNOPSIS
    Restores Antigravity 2.0 (App A) and Antigravity IDE (App B) to their exact original unpatched state.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function U([string]$Escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($Escaped)
}

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PatchEngine = Join-Path $ScriptDir 'patch-engine.mjs'

if (-not (Test-Path $PatchEngine)) {
    throw "Patch engine missing: $PatchEngine"
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

$RealNodeExe = Resolve-RealNodeExe

Write-Host (U "\u267B\uFE0F [Global Skin] \u6B63\u5728\u8FD8\u539F Antigravity \u539F\u751F\u754C\u9762\u4E0E\u6821\u9A8C\u548C\u5907\u4EFD...") -ForegroundColor Cyan

$JsonResult = & $RealNodeExe $PatchEngine restore
if ($LASTEXITCODE -ne 0) {
    throw "patch-engine.mjs restore failed with exit code $LASTEXITCODE"
}

$Parsed = $JsonResult | ConvertFrom-Json

if ($Parsed.appA -and [string]$Parsed.appA.asar -eq 'locked') {
    Write-Host (U "\u26A0\uFE0F [App A: Antigravity 2.0] app \u6B63\u5728\u8FD0\u884C\uFF0Capp.asar \u88AB\u5360\u7528\uFF0C\u6CA1\u80FD\u8FD8\u539F\u3002\u8BF7\u5B8C\u5168\u9000\u51FA Antigravity app \u540E\u518D\u6267\u884C\u4E00\u6B21\u8FD8\u539F\u3002") -ForegroundColor Yellow
} elseif ($Parsed.appA -and $Parsed.appA.restored) {
    Write-Host ((U "\u2705 [App A: Antigravity 2.0] \u5DF2\u4ECE app.asar.pokemon-backup \u8FD8\u539F\u539F\u7248 app.asar: ") + $Parsed.appA.path) -ForegroundColor Green
} else {
    Write-Host (U "\u2139\uFE0F [App A: Antigravity 2.0] \u5DF2\u5904\u4E8E\u539F\u751F\u672A\u4FEE\u6539\u72B6\u6001") -ForegroundColor DarkGray
}

if ($Parsed.appB -and $Parsed.appB.restored) {
    Write-Host ((U "\u2705 [App B: Antigravity IDE] \u5DF2\u4ECE .pokemon-backup \u5B8C\u6574\u8FD8\u539F HTML\u3001out/main.js \u4E0E product.json: ") + $Parsed.appB.path) -ForegroundColor Green
} else {
    Write-Host (U "\u2139\uFE0F [App B: Antigravity IDE] \u5DF2\u5904\u4E8E\u539F\u751F\u672A\u4FEE\u6539\u72B6\u6001") -ForegroundColor DarkGray
}

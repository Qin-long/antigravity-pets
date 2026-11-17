@echo off
setlocal
title Antigravity Pets - Install
REM Double-click to install Antigravity Pets (desktop pets + skins) for Antigravity IDE / Antigravity 2.0.
REM All logic lives in installer\install.ps1 (pass -DryRun to preview without changing anything).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
pause
endlocal

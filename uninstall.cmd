@echo off
setlocal
title Antigravity Pets - Uninstall
REM Double-click to uninstall Antigravity Pets and restore the original Antigravity client files.
REM All logic lives in installer\uninstall.ps1 (pass -DryRun to preview without changing anything).
set "UNINSTALL_PS1=%~dp0installer\uninstall.ps1"
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UNINSTALL_PS1%" %*
echo.
pause
endlocal

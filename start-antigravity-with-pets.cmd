@echo off
setlocal
REM ============================================================================
REM Antigravity IDE + Authentic Floating Pokemon Pets One-Click Bound Launcher
REM Zero-console silent launch via wscript.exe //B //Nologo silent-launch.vbs
REM ============================================================================

set "SUITE_DIR=%~dp0"
if "%SUITE_DIR:~-1%"=="\" set "SUITE_DIR=%SUITE_DIR:~0,-1%"
set "SILENT_VBS=%SUITE_DIR%\desktop-pet\silent-launch.vbs"
set "WSCRIPT_EXE=%SystemRoot%\System32\wscript.exe"

set "AGY_EXE=%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
if not exist "%AGY_EXE%" set "AGY_EXE=%USERPROFILE%\AppData\Local\Programs\Antigravity\Antigravity.exe"
if not exist "%AGY_EXE%" set "AGY_EXE=%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"

if exist "%AGY_EXE%" (
    "%WSCRIPT_EXE%" //B //Nologo "%SILENT_VBS%" "%AGY_EXE%" %*
)

"%WSCRIPT_EXE%" //B //Nologo "%SILENT_VBS%" "%SUITE_DIR%\desktop-pet\launch-desktop-pet.ps1" -BindToIde
exit /b 0

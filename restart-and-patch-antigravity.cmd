@echo off
setlocal enabledelayedexpansion
set "RES_DIR=%LOCALAPPDATA%\Programs\antigravity\resources"
set "APP_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
set "CUR_ASAR=%RES_DIR%\app.asar"
set "NEW_ASAR=%RES_DIR%\app.asar.pokemon-new"
set "OLD_ASAR=%RES_DIR%\app.asar.pokemon-old"

echo [1/4] Stopping all Antigravity.exe processes...
taskkill /F /IM Antigravity.exe >nul 2>&1

if not exist "%NEW_ASAR%" (
    echo [ERROR] Staged file not found: "%NEW_ASAR%" > "%TEMP%\antigravity-pokemon-swap.log"
    exit /b 1
)

echo [2/4] Waiting for file lock release and swapping app.asar...
set "SWAPPED=0"
for /L %%i in (1,1,15) do (
    if exist "%OLD_ASAR%" del /F /Q "%OLD_ASAR%" >nul 2>&1
    if exist "%CUR_ASAR%" move /Y "%CUR_ASAR%" "%OLD_ASAR%" >nul 2>&1
    move /Y "%NEW_ASAR%" "%CUR_ASAR%" >nul 2>&1
    if not exist "%NEW_ASAR%" if exist "%CUR_ASAR%" (
        set "SWAPPED=1"
        goto :swapped_ok
    )
    ping -n 2 127.0.0.1 >nul
    taskkill /F /IM Antigravity.exe >nul 2>&1
)

:swapped_ok
if "%SWAPPED%"=="0" (
    if not exist "%CUR_ASAR%" if exist "%OLD_ASAR%" move /Y "%OLD_ASAR%" "%CUR_ASAR%" >nul 2>&1
    echo [ERROR] Failed to swap app.asar because another process is still holding it. > "%TEMP%\antigravity-pokemon-swap.log"
    exit /b 1
)

if exist "%OLD_ASAR%" del /F /Q "%OLD_ASAR%" >nul 2>&1
echo [OK] Swapped app.asar at %DATE% %TIME% > "%TEMP%\antigravity-pokemon-swap.log"
echo [3/4] Verified: app.asar updated successfully!

echo [4/4] Relaunching Antigravity...
if exist "%APP_EXE%" (
    start "" "%APP_EXE%"
)
echo Done!
exit /b 0

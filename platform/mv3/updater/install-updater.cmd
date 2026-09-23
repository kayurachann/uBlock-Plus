@echo off
rem uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
rem Installs the automatic updater for the current Windows user.
rem ExecutionPolicy Bypass applies only to this PowerShell process.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-updater.ps1" %*
if errorlevel 1 (
    echo.
    echo The updater was not installed. See the message above.
    pause
    exit /b 1
)
echo.
pause

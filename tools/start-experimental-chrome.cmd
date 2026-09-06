@echo off
rem uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
rem ExecutionPolicy Bypass applies only to this PowerShell process.
rem It does not change any saved Windows or Chrome policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-experimental-chrome.ps1"
if errorlevel 1 pause

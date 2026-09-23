@echo off
rem uBlock Plus+ - GPL-3.0-or-later. See LICENSE.txt.
rem Chrome native messaging launcher for the uBlock Plus+ updater. The whole
rem command is on one line so that replacing this file while it runs is safe.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ublock-plus-updater.ps1" -NativeHost -CallerOrigin "%~1" & exit /b

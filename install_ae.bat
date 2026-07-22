@echo off
title AutoCaps - After Effects Installer
echo Starting AutoCaps installation for Adobe After Effects...
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_ae.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Installation failed. Please read the error message above.
    pause
    exit /b %errorlevel%
)
echo.
echo [SUCCESS] AutoCaps for After Effects installed!
echo IMPORTANT: one manual step remains - see README_AE.txt for the
echo one-time Output Module Template setup, then restart After Effects.
pause
exit

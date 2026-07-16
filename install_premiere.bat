@echo off
title AutoCaps - Premiere Pro Installer
echo Starting AutoCaps installation for Adobe Premiere Pro...
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_premiere.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Installation failed. Please read the error message above.
    pause
    exit /b %errorlevel%
)
echo.
echo [SUCCESS] AutoCaps installed successfully!
pause
exit
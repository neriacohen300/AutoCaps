@echo off
title AutoCaps - DaVinci Resolve Installer
echo Starting AutoCaps installation for DaVinci Resolve...
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_resolve.ps1"
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
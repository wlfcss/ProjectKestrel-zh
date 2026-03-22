@echo off
REM ========================================
REM LingjianLite - Interactive Installer Builder
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo LingjianLite Installer Builder
echo ========================================
echo.

set PROJECT_ROOT=%~dp0..
set INNO_COMPILER="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

REM Build default release name and version
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy.MM.dd.HH.mm\""') do set "RELEASE_TS=%%I"
set "DEFAULT_RELEASE_NAME=LingjianLite a%RELEASE_TS%"
set "DEFAULT_APP_VERSION=alpha-%RELEASE_TS%"

set "RELEASE_NAME="
set /p RELEASE_NAME=Enter installer release name [%DEFAULT_RELEASE_NAME%]: 
if "%RELEASE_NAME%"=="" set "RELEASE_NAME=%DEFAULT_RELEASE_NAME%"

set "APP_VERSION="
set /p APP_VERSION=Enter app version [%DEFAULT_APP_VERSION%]: 
if "%APP_VERSION%"=="" set "APP_VERSION=%DEFAULT_APP_VERSION%"

echo.
echo Using release name: %RELEASE_NAME%
echo Using app version:  %APP_VERSION%
echo.

REM Export for headless script
set "RELEASE_TS=%RELEASE_TS%"
set "RELEASE_NAME=%RELEASE_NAME%"
set "APP_VERSION=%APP_VERSION%"

REM Delegate to headless build script
call "%~dp0build_installer_headless.bat"
if %ERRORLEVEL% NEQ 0 goto :fail

pause
exit /b 0

:fail
echo.
echo [ERROR] Build stopped due to a failure.
echo.
pause
exit /b 1

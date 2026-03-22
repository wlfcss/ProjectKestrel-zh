@echo off
REM ========================================
REM LingjianLite - Headless Build Script (Windows)
REM Builds unified LingjianLite onedir bundle + Inno Setup installer
REM Called by CI (GitHub Actions) or run locally without prompts
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo LingjianLite Headless Builder (Windows) - INNO SETUP STEP
echo ========================================
echo.

set PROJECT_ROOT=%~dp0..
set INNO_COMPILER="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

REM Allow caller to inject version strings; otherwise auto-generate
if not defined RELEASE_TS (
    for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy.MM.dd.HH.mm\""') do set "RELEASE_TS=%%I"
)
if not defined RELEASE_NAME set "RELEASE_NAME=LingjianLite a%RELEASE_TS%"
if not defined APP_VERSION   set "APP_VERSION=alpha-%RELEASE_TS%"

echo Using release name: %RELEASE_NAME%
echo Using app version:  %APP_VERSION%
echo.

REM Change to project root
cd /d "%PROJECT_ROOT%"

REM Read VERSION.txt from repo root and copy to analyzer folder
if exist "VERSION.txt" (
    echo [OK] Reading VERSION.txt from repo root
    copy "VERSION.txt" "analyzer\VERSION.txt" /Y
    echo [OK] VERSION.txt copied to analyzer\
) else (
    echo [WARNING] VERSION.txt not found in repo root, generating one...
    (
        echo %APP_VERSION%
    ) > "analyzer\VERSION.txt"
    echo [OK] Generated VERSION.txt in analyzer\
)

REM ----------------------------------------
REM Activate Python virtual environment
REM ----------------------------------------
if exist ".venv\Scripts\activate.bat" (
    call ".venv\Scripts\activate.bat"
    echo [OK] Activated .venv
) else (
    echo [WARNING] .venv not found - using system/activated Python
)


echo.
echo ========================================
echo Checking Inno Setup ...
echo ========================================
echo.

if not exist %INNO_COMPILER% (
    echo [ERROR] Inno Setup 6 not found at %INNO_COMPILER%
    echo Please install from: https://jrsoftware.org/isinfo.php
    exit /b 1
)
echo [OK] Inno Setup 6 found

if not exist "dist\installer" mkdir "dist\installer"

echo.
echo ========================================
echo Building Inno Setup installer ...
echo ========================================
echo.

%INNO_COMPILER% ^
    /DReleaseName="%RELEASE_NAME%" ^
    /DAppVersion="%APP_VERSION%" ^
    "packaging\kestrel_installer.iss"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Inno Setup build failed!
    exit /b 1
)

echo.
echo ========================================
echo Build complete!
echo ========================================
echo.
for %%F in ("dist\installer\*.exe") do (
    echo Installer: %%~nxF  ^(%%~zF bytes^)
)
echo.
exit /b 0
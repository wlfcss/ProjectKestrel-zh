@echo off
REM ========================================
REM Project Kestrel - Headless Build Script (Windows)
REM Builds unified ProjectKestrel onedir bundle + Inno Setup installer
REM Called by CI (GitHub Actions) or run locally without prompts
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo Project Kestrel Headless Builder (Windows) - PYINSTALLER STEP
echo ========================================
echo.

set PROJECT_ROOT=%~dp0..
set INNO_COMPILER="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

REM Allow caller to inject version strings; otherwise auto-generate
if not defined RELEASE_TS (
    for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy.MM.dd.HH.mm\""') do set "RELEASE_TS=%%I"
)
if not defined RELEASE_NAME set "RELEASE_NAME=Project Kestrel a%RELEASE_TS%"
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
        echo Build: %RELEASE_TS%
        echo Version: %APP_VERSION%
    ) > "analyzer\VERSION.txt"
    echo [OK] Generated VERSION.txt in analyzer\
)

REM ----------------------------------------
REM Activate Python virtual environment
REM ----------------------------------------
if exist ".venv2\Scripts\activate.bat" (
    call ".venv2\Scripts\activate.bat"
    echo [OK] Activated .venv2
) else (
    echo [WARNING] .venv2 not found - using system/activated Python
)

echo.
echo ========================================
echo Running PyInstaller (onedir) ...
echo ========================================
echo.

pushd analyzer || exit /b 1
python -m PyInstaller ProjectKestrel.spec
popd

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] PyInstaller build failed!
    exit /b 1
)

if not exist "analyzer\dist\ProjectKestrel\ProjectKestrel.exe" (
    echo [ERROR] ProjectKestrel.exe not found after build.
    exit /b 1
)
echo [OK] PyInstaller onedir build complete: analyzer\dist\ProjectKestrel\



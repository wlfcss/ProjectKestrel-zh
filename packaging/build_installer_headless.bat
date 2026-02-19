@echo off
REM ========================================
REM Project Kestrel - Headless Build Script (Windows)
REM Builds unified ProjectKestrel onedir bundle + Inno Setup installer
REM Called by CI (GitHub Actions) or run locally without prompts
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo Project Kestrel Headless Builder (Windows)
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

REM Write version info into the analyzer folder
(
    echo Build: %RELEASE_TS%
    echo Version: %APP_VERSION%
) > "analyzer\VERSION.txt"
echo [OK] VERSION.txt written to analyzer\

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

python -m PyInstaller --onedir ^
    --paths=. ^
    --runtime-hook "analyzer/runtime_hook.py" ^
    --hidden-import pywebview ^
    --add-data "analyzer/models;models" ^
    --add-data "analyzer/gui_app.py;." ^
    --add-data "analyzer/gui_helpers.py;." ^
    --add-data "analyzer/cli.py;." ^
    --add-data "analyzer/VERSION.txt;." ^
    --add-data "analyzer/kestrel_analyzer;kestrel_analyzer" ^
    --add-data "analyzer/visualizer.html;." ^
    --add-data "analyzer/logo.png;." ^
    --add-data "analyzer/logo.ico;." ^
    --collect-all msvc-runtime ^
    --collect-binaries torch ^
    --collect-binaries onnxruntime ^
    --collect-binaries tensorflow ^
    --name "ProjectKestrel" ^
    --distpath "analyzer/dist" ^
    --workpath "analyzer/build" ^
    --specpath "analyzer" ^
    analyzer/visualizer.py

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

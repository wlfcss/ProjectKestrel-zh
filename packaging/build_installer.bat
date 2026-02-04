@echo off
REM ========================================
REM Project Kestrel Installer Builder
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo Project Kestrel Installer Builder
echo ========================================
echo.

set PROJECT_ROOT=%~dp0..
set INNO_COMPILER="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

REM Build default release name: Project Kestrel aYYYY.MM.DD.HH.MM
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy.MM.dd.HH.mm\""') do set "RELEASE_TS=%%I"
set "DEFAULT_RELEASE_NAME=Project Kestrel a%RELEASE_TS%"
set "RELEASE_NAME="
set /p RELEASE_NAME=Enter installer release name [%DEFAULT_RELEASE_NAME%]: 
if "%RELEASE_NAME%"=="" set "RELEASE_NAME=%DEFAULT_RELEASE_NAME%"
echo Using release name: %RELEASE_NAME%

set "DEFAULT_APP_VERSION=alpha-%RELEASE_TS%"
set "APP_VERSION="
set /p APP_VERSION=Enter app version [%DEFAULT_APP_VERSION%]: 
if "%APP_VERSION%"=="" set "APP_VERSION=%DEFAULT_APP_VERSION%"
echo Using app version: %APP_VERSION%

REM Change to project root directory
cd /d "%PROJECT_ROOT%"

echo Checking prerequisites...
echo.

REM Check if Inno Setup is installed
if not exist %INNO_COMPILER% (
    echo [ERROR] Inno Setup 6 not found at %INNO_COMPILER%
    echo.
    echo Please install Inno Setup 6 from: https://jrsoftware.org/isinfo.php
    echo.
    pause
    exit /b 1
)
echo [OK] Inno Setup 6 found

REM Check if analyzer build exists
if not exist "analyzer\dist\kestrel_analyzer.exe" (
    echo [ERROR] Analyzer executable not found at:
    echo        analyzer\dist\kestrel_analyzer.exe
    echo.
    echo Please build the analyzer first.
    echo.
    pause
    exit /b 1
)
echo [OK] Analyzer executable found

REM Check if visualizer build exists  
if not exist "visualizer\dist\visualizer.exe" (
    echo [ERROR] Visualizer executable not found at:
    echo        visualizer\dist\visualizer.exe
    echo.
    echo Please build the visualizer first.
    echo.
    pause
    exit /b 1
)
echo [OK] Visualizer executable found

REM Check if LICENSE exists
if not exist "LICENSE" (
    echo [WARNING] LICENSE file not found - creating placeholder
    echo MIT License > "LICENSE"
)

REM Create output directory
if not exist "dist\installer" (
    echo Creating output directory...
    mkdir "dist\installer"
)

echo.
echo ========================================
echo Building installer...
echo ========================================
echo.

REM Run Inno Setup compiler from packaging directory
%INNO_COMPILER% /DReleaseName="%RELEASE_NAME%" /DAppVersion="%APP_VERSION%" "packaging\kestrel_installer.iss"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo Installer built successfully!
    echo ========================================
    echo.
    echo Output location:
    echo %CD%\dist\installer\
    echo.
    
    REM List the output file
    for %%F in ("dist\installer\*.exe") do (
        echo Created: %%~nxF
        echo Size: %%~zF bytes
    )

    echo.
    echo.
    echo ========================================
    echo Moving build artifacts to dist...
    echo ========================================
    echo.

    move /Y "analyzer\dist\kestrel_analyzer.exe" "release\kestrel_analyzer.exe"
    move /Y "analyzer\build\kestrel_analyzer_build\kestrel_analyzer.pkg" "release\kestrel_analyzer.pkg"
    move /Y "visualizer\dist\visualizer.exe" "release\visualizer.exe"
    move /Y "visualizer\build\visualizer\visualizer.pkg" "release\visualizer.pkg"

) else (
    echo.
    echo [ERROR] Installer build failed!
    echo Check the error messages above for details.
    echo.
)

pause

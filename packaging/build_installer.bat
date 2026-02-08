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
set RELEASE_ROOT=%PROJECT_ROOT%\release
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

REM Create VERSION.txt and copy into analyzer/visualizer
set "VERSION_FILE=VERSION.txt"
(
    echo Build: %RELEASE_TS%
    echo Version: %APP_VERSION%
) > "%VERSION_FILE%"
copy /Y "%VERSION_FILE%" "analyzer\VERSION.txt" >nul
copy /Y "%VERSION_FILE%" "visualizer\VERSION.txt" >nul

REM Create release directory based on version
set "RELEASE_DIR=%RELEASE_ROOT%\%APP_VERSION%"
if not exist "%RELEASE_ROOT%" mkdir "%RELEASE_ROOT%"
if not exist "%RELEASE_DIR%" mkdir "%RELEASE_DIR%"

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

call :handle_component analyzer "kestrel_analyzer.exe" "analyzer.spec" "analyzer_build"
if %ERRORLEVEL% NEQ 0 goto :fail

call :handle_component visualizer "visualizer.exe" "visualizer.spec" "visualizer_build"
if %ERRORLEVEL% NEQ 0 goto :fail

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
%INNO_COMPILER% /DReleaseName="%RELEASE_NAME%" /DAppVersion="%APP_VERSION%" /DReleaseDir="%RELEASE_DIR%" "packaging\kestrel_installer.iss"

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
    echo Moving build artifacts to release...
    echo ========================================
    echo.

    move /Y "dist\installer\*.exe" "%RELEASE_DIR%\" >nul
    echo [OK] Installer moved to %RELEASE_DIR%
) else (
    echo.
    echo [ERROR] Installer build failed!
    echo Check the error messages above for details.
    echo.
)

pause
exit /b 0

:fail
echo.
echo [ERROR] Build stopped due to an earlier failure.
echo.
pause
exit /b 1

:handle_component
set "COMPONENT_NAME=%~1"
set "COMPONENT_EXE=%~2"
set "COMPONENT_SPEC=%~3"
set "COMPONENT_BUILD_LABEL=%~4"

echo.
echo ========================================
echo %COMPONENT_NAME% build selection
echo ========================================
choice /C BN /N /M "%COMPONENT_NAME%: Build new (B) or use existing (N)? "
if errorlevel 2 goto :use_existing

call :ensure_venv
if %ERRORLEVEL% NEQ 0 exit /b 1

pushd "%COMPONENT_NAME%"
pyinstaller "%COMPONENT_SPEC%"
if %ERRORLEVEL% NEQ 0 (
    popd
    exit /b 1
)
popd

set "DIST_EXE=%COMPONENT_NAME%\dist\%COMPONENT_EXE%"
if not exist "%DIST_EXE%" (
    echo [ERROR] %COMPONENT_NAME% executable not found at %DIST_EXE%
    exit /b 1
)
move /Y "%DIST_EXE%" "%RELEASE_DIR%\%COMPONENT_EXE%" >nul

if exist "%COMPONENT_NAME%\build\%COMPONENT_NAME%" (
    move /Y "%COMPONENT_NAME%\build\%COMPONENT_NAME%" "%RELEASE_DIR%\%COMPONENT_BUILD_LABEL%" >nul
)

exit /b 0

:use_existing
call :select_release_dir SELECTED_RELEASE
if %ERRORLEVEL% NEQ 0 exit /b 1

set "SOURCE_EXE=%RELEASE_ROOT%\%SELECTED_RELEASE%\%COMPONENT_EXE%"
if not exist "%SOURCE_EXE%" (
    echo [ERROR] %COMPONENT_NAME% executable not found at %SOURCE_EXE%
    exit /b 1
)
copy /Y "%SOURCE_EXE%" "%RELEASE_DIR%\%COMPONENT_EXE%" >nul
exit /b 0

:ensure_venv
set "VENV_OK="
if defined VIRTUAL_ENV (
    echo %VIRTUAL_ENV% | findstr /I "\\.venv2" >nul && set "VENV_OK=1"
)
if not defined VENV_OK (
    if exist "%PROJECT_ROOT%\.venv2\Scripts\activate.bat" (
        call "%PROJECT_ROOT%\.venv2\Scripts\activate.bat"
    ) else (
        echo [WARNING] .venv2 not found at %PROJECT_ROOT%\.venv2
    )
)
exit /b 0

:select_release_dir
setlocal enabledelayedexpansion
if not exist "%RELEASE_ROOT%" (
    echo [ERROR] Release folder not found at %RELEASE_ROOT%
    endlocal & exit /b 1
)

set /a idx=0
for /d %%D in ("%RELEASE_ROOT%\*") do (
    set /a idx+=1
    set "rel!idx!=%%~nxD"
    echo !idx!^) %%~nxD
)

if !idx! EQU 0 (
    echo [ERROR] No release directories found in %RELEASE_ROOT%
    endlocal & exit /b 1
)

set /p sel=Choose release number: 
for /f "delims=0123456789" %%A in ("!sel!") do set "sel="
if not defined sel (
    echo [ERROR] Invalid selection.
    endlocal & exit /b 1
)
if !sel! GTR !idx! (
    echo [ERROR] Selection out of range.
    endlocal & exit /b 1
)

set "chosen=!rel%sel%!"
endlocal & set "%~1=%chosen%" & exit /b 0

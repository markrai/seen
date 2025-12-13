@echo off
REM Seen Tauri Application Launcher
REM This checks for all prerequisites, builds what's missing, and launches the Tauri app

cd /d "%~dp0"

set "ROOT_DIR=%~dp0"
set "FRONTEND_DIR=%ROOT_DIR%frontend"
set "TAURI_EXE=%FRONTEND_DIR%\src-tauri\target\release\seen-frontend.exe"
set "BUILD_SCRIPT=%ROOT_DIR%build_tauri.bat"

echo ========================================
echo Seen Tauri Application Launcher
echo ========================================
echo.

REM In dev, stale Tauri bundles are the #1 source of "works in Docker but not in Tauri".
REM Default behavior: rebuild everything (backend sidecar + frontend + Tauri bundle).
REM Pass --no-build to skip rebuilding and just launch the existing executable.
if /I "%1"=="--no-build" goto :launch_only

echo Building latest Tauri bundle...
call "%BUILD_SCRIPT%"
if errorlevel 1 (
    echo ERROR: Build failed.
    pause
    exit /b 1
)

:launch_only
if not exist "%TAURI_EXE%" (
    echo ERROR: Tauri executable not found: %TAURI_EXE%
    echo Run: %BUILD_SCRIPT%
    pause
    exit /b 1
)

REM Launch the Tauri application
echo ========================================
echo Launching Seen Tauri Application...
echo ========================================
echo.

REM Launch the Tauri application
start "" "%TAURI_EXE%"

REM Wait a moment to see if process starts
timeout /t 3 /nobreak >nul

REM Check if process is running
tasklist /FI "IMAGENAME eq seen-frontend.exe" 2>NUL | find /I /N "seen-frontend.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Application launched successfully!
    echo The backend will start automatically as a sidecar process.
    echo.
    echo To stop the application, close the window or use Task Manager.
    echo.
) else (
    echo.
    echo ERROR: Application failed to launch or crashed immediately.
    echo.
    echo This usually means there's a configuration error.
    echo Please check the Tauri configuration files:
    echo   - frontend\src-tauri\tauri.conf.json
    echo   - frontend\src-tauri\capabilities\default.json
    echo.
    echo You may need to rebuild after fixing configuration:
    echo   run_with_tauri.bat
    echo.
    pause
)

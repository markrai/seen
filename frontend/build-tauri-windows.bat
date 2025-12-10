@echo off
REM Build Seen Frontend as Windows EXE using Tauri
REM This creates a standalone Windows executable

echo Building Seen Frontend for Windows...
echo.

REM Check if the executable is running and terminate it if needed
echo Checking for running instances...
tasklist /FI "IMAGENAME eq seen-frontend.exe" 2>NUL | find /I /N "seen-frontend.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Found running instance of seen-frontend.exe, terminating...
    taskkill /F /IM seen-frontend.exe >NUL 2>&1
    timeout /t 1 /nobreak >NUL
    echo Process terminated.
    echo.
)

REM Enable backend-powered file browser for Docker/WSL compatibility
set "VITE_ENABLE_FILE_BROWSER=1"

REM Build the frontend first
echo Step 1: Building frontend bundle...
echo File browser enabled: %VITE_ENABLE_FILE_BROWSER%
call npm run build
if errorlevel 1 (
    echo Frontend build failed!
    exit /b 1
)

echo.
echo Step 2: Building Tauri Windows executable...
call npm run tauri:build
if errorlevel 1 (
    echo Tauri build failed!
    exit /b 1
)

echo.
echo Build complete!
echo.
echo The Windows executable is located at:
echo src-tauri\target\release\seen-frontend.exe
echo.
echo You can also find an installer at:
echo src-tauri\target\release\bundle\nsis\seen-frontend_0.8.0_x64-setup.exe
echo.


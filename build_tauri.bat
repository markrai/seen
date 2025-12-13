@echo off
REM Build Seen as a complete Tauri Windows application
REM This builds the backend, frontend, and bundles them together as a standalone Windows executable

cd /d "%~dp0"
set ROOT_DIR=%~dp0
set FRONTEND_DIR=%~dp0frontend

REM Hardening:
REM - TAURI_CONFIG is a JSON override string (NOT a config file path). Clear it to avoid stale global values after repo renames.
set "TAURI_CONFIG="
REM - Repo renames can leave stale absolute paths inside compiled build artifacts; clean Tauri's Rust target output.
if exist "%FRONTEND_DIR%\src-tauri\target" (
  rmdir /s /q "%FRONTEND_DIR%\src-tauri\target"
)

echo Building Seen Tauri Application (Windows)...
echo This will build the backend, frontend, and create a standalone Windows executable.
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
tasklist /FI "IMAGENAME eq seen-backend.exe" 2>NUL | find /I /N "seen-backend.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Found running instance of seen-backend.exe, terminating...
    taskkill /F /IM seen-backend.exe >NUL 2>&1
    timeout /t 1 /nobreak >NUL
    echo Process terminated.
    echo.
)

REM Step 1: Build the backend binary
echo ========================================
echo Step 1: Building backend binary...
echo ========================================
cd /d "%ROOT_DIR%"
if not exist "Cargo.toml" (
    echo Error: Backend Cargo.toml not found at %ROOT_DIR%
    pause
    exit /b 1
)

REM Always build backend (incremental; ensures sidecar contains latest fixes)
echo Building backend...
cargo build --release
if errorlevel 1 (
    echo Backend build failed!
    pause
    exit /b 1
)
echo Backend build complete.

REM Step 2: Copy backend to Tauri binaries directory
echo.
echo ========================================
echo Step 2: Copying backend to Tauri binaries directory...
echo ========================================
if not exist "%FRONTEND_DIR%\src-tauri\binaries" mkdir "%FRONTEND_DIR%\src-tauri\binaries"

copy /Y "%ROOT_DIR%\target\release\seen_backend.exe" "%FRONTEND_DIR%\src-tauri\binaries\seen-backend-x86_64-pc-windows-msvc.exe"
if errorlevel 1 (
    echo Error: Failed to copy backend binary to Tauri binaries directory
    pause
    exit /b 1
)

REM Verify the copy succeeded
if not exist "%FRONTEND_DIR%\src-tauri\binaries\seen-backend-x86_64-pc-windows-msvc.exe" (
    echo Error: Backend binary verification failed - file not found after copy
    pause
    exit /b 1
)

echo Backend binary copied successfully to:
echo   %FRONTEND_DIR%\src-tauri\binaries\seen-backend-x86_64-pc-windows-msvc.exe

REM Step 3: Build the frontend bundle
echo.
echo ========================================
echo Step 3: Building frontend bundle...
echo ========================================
cd /d "%FRONTEND_DIR%"
if not exist "package.json" (
    echo Error: Frontend package.json not found at %FRONTEND_DIR%
    pause
    exit /b 1
)

REM IMPORTANT:
REM - VITE_BUILD_TAURI=1 disables the dialog API stub in vite.config.ts so the native folder picker works.
REM - VITE_ENABLE_FILE_BROWSER is for Docker/WSL web deployments only; keep it OFF for desktop.
set "VITE_BUILD_TAURI=1"
set "VITE_ENABLE_FILE_BROWSER=0"
echo VITE_BUILD_TAURI=%VITE_BUILD_TAURI%
echo File browser enabled (Docker/web only): %VITE_ENABLE_FILE_BROWSER%

call npm run build:tauri
if errorlevel 1 (
    echo Frontend build failed!
    pause
    exit /b 1
)
echo Frontend build complete.

REM Step 4: Build Tauri Windows executable
echo.
echo ========================================
echo Step 4: Building Tauri Windows executable...
echo ========================================
call npm run tauri:build
if errorlevel 1 (
    echo Tauri build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo Build complete!
echo ========================================
echo.
echo The Windows executable is located at:
echo   %FRONTEND_DIR%\src-tauri\target\release\seen-frontend.exe
echo.
echo You can also find an installer at:
echo   %FRONTEND_DIR%\src-tauri\target\release\bundle\nsis\Seen_0.9.1_x64-setup.exe
echo.
echo Note: The backend is bundled as a sidecar and will start automatically with the Tauri app.
echo.
pause


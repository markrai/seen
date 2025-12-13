@echo off
REM Build Seen Frontend as Windows EXE using Tauri
REM This creates a standalone Windows executable that includes both frontend and backend

cd /d "%~dp0"
set FRONTEND_DIR=%~dp0
set BACKEND_DIR=%~dp0\..

echo Building Seen Frontend + Backend for Windows (Tauri)...
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

REM Step 1: Build the backend binary
echo Step 1: Building backend binary...
cd /d "%BACKEND_DIR%"
if not exist "Cargo.toml" (
    echo Error: Backend Cargo.toml not found at %BACKEND_DIR%
    pause
    exit /b 1
)

REM Check if backend is already built
if not exist "target\release\seen_backend.exe" (
    echo Backend executable not found, building...
    cargo build --release
    if errorlevel 1 (
        echo Backend build failed!
        pause
        exit /b 1
    )
) else (
    echo Backend executable already exists, skipping build.
    echo (Delete target\release\seen_backend.exe to force rebuild)
)

REM Step 2: Copy backend to Tauri binaries directory
echo.
echo Step 2: Copying backend to Tauri binaries directory...
cd /d "%FRONTEND_DIR%"
if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"

copy /Y "%BACKEND_DIR%\target\release\seen_backend.exe" "src-tauri\binaries\seen-backend-x86_64-pc-windows-msvc.exe" >nul
if errorlevel 1 (
    echo Error: Failed to copy backend binary to Tauri binaries directory
    pause
    exit /b 1
)
echo Backend binary copied successfully.

REM Step 3: Build the frontend bundle
echo.
echo Step 3: Building frontend bundle...
REM Enable backend-powered file browser for Docker/WSL compatibility
set "VITE_ENABLE_FILE_BROWSER=1"
echo File browser enabled: %VITE_ENABLE_FILE_BROWSER%

call npm run build
if errorlevel 1 (
    echo Frontend build failed!
    pause
    exit /b 1
)

REM Step 4: Build Tauri Windows executable
echo.
echo Step 4: Building Tauri Windows executable...
call npm run tauri:build
if errorlevel 1 (
    echo Tauri build failed!
    pause
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
echo Note: The backend is bundled as a sidecar and will start automatically with the Tauri app.
echo.


@echo off
REM Run the built Seen Frontend Windows executable
REM This launches the Tauri application from the release build

cd /d "%~dp0"

set "EXE_PATH=src-tauri\target\release\seen-frontend.exe"

echo Checking for Tauri executable...
echo Current directory: %CD%
echo.

REM Check if file exists
if exist "%EXE_PATH%" (
    echo Found Tauri executable!
    echo.
    echo Launching Seen Frontend...
    echo.
    
    REM Launch the Tauri application
    start "" "%EXE_PATH%"
    
    if errorlevel 1 (
        echo Error: Failed to launch the application.
        pause
        exit /b 1
    )
    
    echo Application launched successfully!
    echo The backend will start automatically as a sidecar process.
    echo.
    echo To stop the application, close the window or use Task Manager.
    echo.
) else (
    echo Error: Executable not found at:
    echo   %CD%\%EXE_PATH%
    echo.
    echo Please build the application first using:
    echo   build-tauri-windows.bat
    echo   (from the frontend directory)
    echo.
    echo Or from the root directory:
    echo   build_tauri.bat
    echo.
    pause
    exit /b 1
)

@echo off
REM Run the built Seen Frontend Windows executable
REM This launches the Tauri application from the release build

set EXE_PATH=src-tauri\target\release\seen-frontend.exe

if not exist "%EXE_PATH%" (
    echo Error: Executable not found at %EXE_PATH%
    echo.
    echo Please build the application first using build-tauri-windows.bat
    exit /b 1
)

echo Launching Seen Frontend...
echo.
start "" "%EXE_PATH%"


@echo off
REM Seen Backend - Windows Native Runner
REM This runs Seen natively on Windows (not in Docker) for proper file watcher support

set FLASH_ROOT=%USERPROFILE%\Pictures
set FLASH_ROOT_HOST=%USERPROFILE%\Pictures
set FLASH_DATA=%~dp0seen-data
set FLASH_PORT=9161
set RUST_LOG=info

REM Create data directory if it doesn't exist
if not exist "%FLASH_DATA%" mkdir "%FLASH_DATA%"

echo Starting Seen Backend (Windows Native)...
echo Pictures folder: %FLASH_ROOT%
echo Data folder: %FLASH_DATA%
echo Port: %FLASH_PORT%
echo.
echo Access the API at: http://localhost:%FLASH_PORT%
echo Press Ctrl+C to stop
echo.

target\release\seen_backend.exe


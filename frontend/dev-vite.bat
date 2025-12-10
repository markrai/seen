@echo off
cd /d "%~dp0"

REM Enable backend-powered file browser for Docker/WSL compatibility
set "VITE_ENABLE_FILE_BROWSER=1"

echo Starting Seen frontend development server (Vite)...
echo.
echo Backend API: http://localhost:9161
echo Frontend will be available at: http://localhost:5173
echo File browser enabled: %VITE_ENABLE_FILE_BROWSER%
echo.
echo Press Ctrl+C to stop
echo.

call npm run dev


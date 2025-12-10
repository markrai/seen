@echo off
REM Script to build the frontend and copy it to the backend's frontend directory

setlocal

echo Building frontend...
cd /d "%~dp0\..\nazr-frontend-web"

if not exist "package.json" (
    echo Error: Frontend directory not found at ..\nazr-frontend-web
    echo Please ensure the frontend project is at the correct location.
    pause
    exit /b 1
)

REM Build the frontend
call npm run build
if errorlevel 1 (
    echo Error: Frontend build failed
    pause
    exit /b 1
)

echo.
echo Copying frontend files to backend...
cd /d "%~dp0"

REM Create frontend directory if it doesn't exist
if not exist "frontend" mkdir frontend
if not exist "frontend\assets" mkdir frontend\assets

REM Copy all files from dist to frontend
xcopy /E /Y /I "..\nazr-frontend-web\dist\*" "frontend\"

echo.
echo Frontend files copied successfully!
echo You can now run the backend and it will serve the frontend.
echo.

pause


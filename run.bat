@echo off
cd /d "%~dp0"

echo Starting Nazr backend with Docker Compose...
echo Using docker-compose.windows.yml
echo.

REM Check if facial recognition feature is requested
set CARGO_BUILD_FLAGS=
if "%1"=="--facial-recognition" (
    set CARGO_BUILD_FLAGS=--features facial-recognition
    echo Building with facial recognition feature enabled...
) else if "%1"=="--help" (
    echo Usage: run.bat [--facial-recognition]
    echo.
    echo Options:
    echo   --facial-recognition    Build with facial recognition feature enabled
    echo   --help                  Show this help message
    echo.
    exit /b 0
)

echo This will:
echo - Build the Docker image
if not "%CARGO_BUILD_FLAGS%"=="" (
    echo - With features: %CARGO_BUILD_FLAGS%
)
echo - Start the service on port 8080
echo - Mount your Pictures folder: %USERPROFILE%\Pictures
echo - Store data in: .\nazr-data
echo.

REM CARGO_BUILD_FLAGS environment variable is automatically passed to docker compose
docker compose -f docker-compose.windows.yml up --build

if errorlevel 1 (
    echo.
    echo Failed to start Docker Compose.
    echo Make sure Docker is running and try again.
    pause
    exit /b 1
)


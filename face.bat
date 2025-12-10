@echo off
cd /d "%~dp0"

echo Starting Seen backend with Docker Compose (Facial Recognition Mode)...
echo Using docker-compose.custom.yml
echo.

REM Always enable facial recognition feature
set CARGO_BUILD_FLAGS=--features facial-recognition
echo Building with facial recognition feature enabled...

echo This will:
echo - Build the Docker image
echo - With features: %CARGO_BUILD_FLAGS%
echo - Start the service on port 8080
echo - Mount your Pictures folder: %USERPROFILE%\Pictures
echo - Store data in: .\seen-data
echo - Use all available CPU cores
echo.

REM CARGO_BUILD_FLAGS environment variable is automatically passed to docker compose
docker compose -f docker-compose.custom.yml up --build

if errorlevel 1 (
    echo.
    echo Failed to start Docker Compose.
    echo Make sure Docker is running and try again.
    pause
    exit /b 1
)


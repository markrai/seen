@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "IMAGE_NAME=seen-frontend-dev"
set "CONTAINER_NAME=seen-frontend-dev"
set "PORT=3000"

if "%VITE_ENABLE_FILE_BROWSER%"=="" (
    set "ENABLE_FILE_BROWSER=1"
) else (
    set "ENABLE_FILE_BROWSER=%VITE_ENABLE_FILE_BROWSER%"
)

if "%VITE_API_BASE_URL%"=="" (
    set "API_URL=http://localhost:9161"
) else (
    set "API_URL=%VITE_API_BASE_URL%"
)

echo Building Seen frontend Docker image: %IMAGE_NAME%
echo Using backend API: %API_URL%
echo File browser enabled flag: %ENABLE_FILE_BROWSER%
echo.

docker build --no-cache --build-arg VITE_API_BASE_URL=%API_URL% --build-arg VITE_ENABLE_FILE_BROWSER=%ENABLE_FILE_BROWSER% -t %IMAGE_NAME% .
if errorlevel 1 (
    echo Docker build failed.
    goto :end
)

echo.
echo Stopping previous container (if any)...
docker rm -f %CONTAINER_NAME% >nul 2>&1

echo Starting container %CONTAINER_NAME% on port %PORT% ...
echo (Ctrl+C to stop)
docker run --rm -it ^
    --name %CONTAINER_NAME% ^
    -p %PORT%:80 ^
    -e VITE_API_BASE_URL=%API_URL% ^
    -e VITE_ENABLE_FILE_BROWSER=%ENABLE_FILE_BROWSER% ^
    -e BACKEND_HOST=host.docker.internal ^
    %IMAGE_NAME%

:end
endlocal


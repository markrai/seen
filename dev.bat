@echo off
cd /d "%~dp0"

echo Starting Seen backend with Docker Compose (Development Mode)...
echo Using docker-compose.custom.yml
echo.

REM Build frontend (Vite) so backend can serve dist assets
echo Building frontend...
pushd "%~dp0frontend" >nul
if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
    if errorlevel 1 (
        echo Frontend npm install failed.
        popd >nul
        exit /b 1
    )
)
call npm run build
if errorlevel 1 (
    echo Frontend build failed.
    popd >nul
    exit /b 1
)
popd >nul
echo Frontend build complete.
echo.

REM Check if facial recognition feature is requested
set CARGO_BUILD_FLAGS=
if "%1"=="--facial-recognition" (
    set CARGO_BUILD_FLAGS=--features facial-recognition
    echo Building with facial recognition feature enabled...
) else if "%1"=="--help" (
    echo Usage: dev.bat [--facial-recognition]
    echo.
    echo Options:
    echo   --facial-recognition    Build with facial recognition feature enabled
    echo   --help                  Show this help message
    echo.
    exit /b 0
)

REM Calculate CPU limit (80% of available logical processors)
REM Use PowerShell for modern Windows compatibility
for /f %%i in ('powershell -Command "[System.Environment]::ProcessorCount" 2^>nul') do set TOTAL_CORES=%%i
if "%TOTAL_CORES%"=="" (
    echo Warning: Could not detect CPU cores, defaulting to 4
    set TOTAL_CORES=4
)
REM Calculate 80% (multiply by 0.8, round up)
set CPU_LIMIT=1
REM Round up: multiply by 8, add 9, then divide by 10 (ceiling rounding)
set /a CPU_LIMIT=(%TOTAL_CORES% * 8 + 9) / 10 2>nul
if errorlevel 1 set CPU_LIMIT=1
if "%CPU_LIMIT%"=="" set CPU_LIMIT=1
if "%CPU_LIMIT%"=="0" set CPU_LIMIT=1

REM Calculate RAM limit (75% of available RAM, minimum 4 GB)
REM Use PowerShell for modern Windows compatibility
for /f %%i in ('powershell -Command "$mem = Get-CimInstance Win32_PhysicalMemory ^| Measure-Object -Property capacity -Sum; [math]::Round($mem.Sum / 1GB, 0)" 2^>nul') do set TOTAL_RAM_GB=%%i
if "%TOTAL_RAM_GB%"=="" (
    echo Warning: Could not detect RAM, defaulting to 8 GB
    set RAM_LIMIT_GB=8
) else (
    REM Calculate 75% of RAM
    set RAM_LIMIT_GB=4
    set /a RAM_LIMIT_GB=%TOTAL_RAM_GB% * 75 / 100 2>nul
    if errorlevel 1 set RAM_LIMIT_GB=4
    if "%RAM_LIMIT_GB%"=="" set RAM_LIMIT_GB=4
    if "%RAM_LIMIT_GB%"=="0" set RAM_LIMIT_GB=4
)

REM Export as environment variables for docker-compose
set SEEN_CPU_LIMIT=%CPU_LIMIT%.0
set SEEN_MEMORY_LIMIT=%RAM_LIMIT_GB%G

REM Detect NVIDIA GPU availability
echo Detecting GPU capabilities...
set HAS_NVIDIA_GPU=0
for /f %%i in ('powershell -ExecutionPolicy Bypass -File "detect-nvidia-gpu.ps1" 2^>nul') do set HAS_NVIDIA_GPU=%%i

if "%HAS_NVIDIA_GPU%"=="1" (
    echo NVIDIA GPU detected - using CUDA-enabled Dockerfile
    set SEEN_DOCKERFILE=Dockerfile.cuda
    set SEEN_USE_GPU=1
) else (
    echo No NVIDIA GPU detected - using standard Dockerfile
    set SEEN_DOCKERFILE=Dockerfile
    set SEEN_USE_GPU=0
)

REM Create temporary docker-compose file with correct dockerfile
echo Creating temporary docker-compose configuration...
powershell -ExecutionPolicy Bypass -File "adjust-docker-compose.ps1" -Dockerfile "%SEEN_DOCKERFILE%" -UseGPU:%SEEN_USE_GPU% 2>nul

if not exist docker-compose.custom.tmp.yml (
    echo Warning: Failed to create temporary docker-compose file, using original
    set COMPOSE_FILE=docker-compose.custom.yml
) else (
    set COMPOSE_FILE=docker-compose.custom.tmp.yml
)

echo Resource allocation:
echo - CPU limit: %SEEN_CPU_LIMIT% cores (80%% of %TOTAL_CORES% available cores)
echo - Memory limit: %SEEN_MEMORY_LIMIT% (75%% of available RAM, minimum 4 GB)
echo - Dockerfile: %SEEN_DOCKERFILE%
echo.
echo This will:
echo - Build the Docker image
if not "%CARGO_BUILD_FLAGS%"=="" (
    echo - With features: %CARGO_BUILD_FLAGS%
)
echo - Start the service on port 8080
echo - Mount your Pictures folder: %USERPROFILE%\Pictures
echo - Store data in: .\seen-data
echo.

REM CARGO_BUILD_FLAGS environment variable is automatically passed to docker compose
docker compose -f %COMPOSE_FILE% up --build
if errorlevel 1 (
    REM Clean up temporary file before exiting
    if exist docker-compose.custom.tmp.yml del docker-compose.custom.tmp.yml 2>nul
    echo.
    echo Failed to start Docker Compose.
    echo Make sure Docker is running and try again.
    pause
    exit /b 1
)

REM Clean up temporary file on success
if exist docker-compose.custom.tmp.yml del docker-compose.custom.tmp.yml 2>nul


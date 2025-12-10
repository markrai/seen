@echo off
echo Building with profiling symbols...
echo.

REM Build release with debug symbols for profiling
set RUSTFLAGS=-C debuginfo=2
cargo build --release

echo.
echo Build complete!
echo.
echo To profile:
echo 1. Windows: Use Superluminal (https://superluminal.eu/)
echo 2. Or use Windows Performance Toolkit
echo 3. Run: target\release\seen_backend.exe
echo.
echo For benchmarks:
echo   cargo bench
echo.


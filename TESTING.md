# Testing Guide

## Quick Start

Run tests in Docker (recommended for all platforms):

```bash
docker compose -f docker-compose.test.yml up --build
```

## Test Requirements

Tests require a Linux environment with:
- libvips (for image processing)
- ffmpeg (for video processing)
- Rust toolchain
- All project dependencies

## Why Docker?

Seen is a Docker-based application designed for Linux deployment. Tests are written to run in the same environment as production:

- ✅ Consistent test environment across all platforms
- ✅ Matches production deployment
- ✅ No platform-specific workarounds needed
- ✅ Tests all features including libvips

## Running Tests

### All Tests

```bash
docker compose -f docker-compose.test.yml up --build
```

### Specific Test Suite

```bash
# Smoke test
docker compose -f docker-compose.test.yml run --rm test cargo test --test smoke

# Integration tests
docker compose -f docker-compose.test.yml run --rm test cargo test --test '*'

# Unit tests only
docker compose -f docker-compose.test.yml run --rm test cargo test --lib
```

### With Different Features

```bash
# Without facial-recognition
docker compose -f docker-compose.test.yml run --rm test cargo test --no-default-features

# With all features (default)
docker compose -f docker-compose.test.yml run --rm test cargo test --all-features
```

### Verbose Output

```bash
docker compose -f docker-compose.test.yml run --rm test cargo test --verbose
```

## Test Structure

- **Unit tests**: `src/**/*.rs` (inline `#[cfg(test)]` modules)
- **Integration tests**: `tests/*.rs`
- **Test utilities**: `tests/common/mod.rs`

## CI/CD

Tests run automatically on:
- Push to main/master/develop branches
- Pull requests
- See `.github/workflows/test.yml` for details

## Troubleshooting

### Tests fail with "libvips not found"

You're likely running tests natively on Windows/macOS. Use Docker instead:

```bash
docker compose -f docker-compose.test.yml up --build
```

### Tests timeout

Some integration tests may need more time. Increase timeout or check test logs:

```bash
docker compose -f docker-compose.test.yml run --rm test cargo test --test smoke -- --nocapture
```

### Cache issues

Clear Docker volumes and rebuild:

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up --build
```


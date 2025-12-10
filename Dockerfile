FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev ffmpeg pkg-config clang && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Use available CPU cores for parallel compilation (can be overridden with build arg)
# Defaults to number of available processors, but can be limited via CARGO_BUILD_JOBS build arg
ARG CARGO_BUILD_JOBS
# Accept build args for cargo features
ARG CARGO_BUILD_FLAGS=""
RUN if [ -z "$CARGO_BUILD_JOBS" ]; then \
        export CARGO_BUILD_JOBS=$(nproc); \
    else \
        export CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS; \
    fi && \
    echo "Building with $CARGO_BUILD_JOBS parallel jobs" && \
    cargo build --release ${CARGO_BUILD_FLAGS} -j $CARGO_BUILD_JOBS

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvips ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV RUST_LOG=info
# Note: libvips EXIF warnings are harmless - images still process correctly
# These warnings occur when libvips encounters non-standard EXIF metadata
# They can be filtered from logs if desired, but don't affect functionality
COPY --from=builder /app/target/release/seen_backend /usr/local/bin/seen_backend
EXPOSE 8080
ENTRYPOINT ["seen_backend"]

FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev ffmpeg pkg-config clang && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Use available CPU cores for parallel compilation (can be overridden with build arg)
# Defaults to number of available processors, but can be limited via CARGO_BUILD_JOBS build arg
ARG CARGO_BUILD_JOBS
# Accept build args for cargo features
ARG CARGO_BUILD_FLAGS=""
RUN if [ -z "$CARGO_BUILD_JOBS" ]; then \
        export CARGO_BUILD_JOBS=$(nproc); \
    else \
        export CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS; \
    fi && \
    echo "Building with $CARGO_BUILD_JOBS parallel jobs" && \
    cargo build --release ${CARGO_BUILD_FLAGS} -j $CARGO_BUILD_JOBS

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvips ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV RUST_LOG=info
# Note: libvips EXIF warnings are harmless - images still process correctly
# These warnings occur when libvips encounters non-standard EXIF metadata
# They can be filtered from logs if desired, but don't affect functionality
COPY --from=builder /app/target/release/seen_backend /usr/local/bin/seen_backend
EXPOSE 8080
ENTRYPOINT ["seen_backend"]
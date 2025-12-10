# GPU Acceleration for Video Thumbnails

Seen supports GPU-accelerated video frame extraction using ffmpeg hardware acceleration. This can significantly improve performance when processing video files.

## Supported Accelerators

- **CUDA** (NVIDIA GPUs on Linux/Windows)
- **QSV** (Intel Quick Sync Video on Linux)
- **D3D11VA** (Windows DirectX 11 Video Acceleration)
- **VideoToolbox** (macOS)

## Configuration

### Environment Variables

- `GPU_ACCEL`: Set to `auto` (default), `off`, `cuda`, `qsv`, `d3d11va`, or `videotoolbox`
- `GPU_LOG=1`: Enable logging of GPU acceleration status

### Auto-Detection

By default, Seen automatically detects available GPU accelerators at startup. It checks:
1. Available hardware accelerators via `ffmpeg -hwaccels`
2. Required GPU scaling filters (e.g., `scale_cuda`, `scale_qsv`)
3. **Physical device presence** - verifies actual GPU hardware, not just libraries:
   - **CUDA**: Uses `nvidia-smi` to detect NVIDIA GPU devices
   - **QSV**: Checks `/dev/dri` and uses `vainfo` to verify Intel GPU devices
   - **OpenCL**: Uses `clinfo` to detect OpenCL-capable devices (logged for diagnostics)
4. Falls back to CPU if no GPU acceleration is available or no physical devices are found

## Docker Setup

### NVIDIA (CUDA)

**Requirements:**
- NVIDIA GPU with CUDA support
- `nvidia-container-toolkit` installed on the host
- ffmpeg built with CUDA support

**docker-compose.yml:**
```yaml
services:
  seen:
    # ... other config ...
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    environment:
      - GPU_ACCEL=auto  # or 'cuda' to force CUDA
```

**Note:** The base Docker image uses standard Debian ffmpeg which may not include CUDA support. For CUDA, you'll need to:
1. Use a custom Dockerfile with CUDA-enabled ffmpeg, or
2. Use a base image that includes CUDA support (e.g., `nvidia/cuda`)

### Intel QSV (Linux)

**Requirements:**
- Intel GPU with Quick Sync Video support
- VAAPI drivers installed on the host
- ffmpeg built with QSV/VAAPI support

**docker-compose.yml:**
```yaml
services:
  seen:
    # ... other config ...
    devices:
      - /dev/dri:/dev/dri:ro  # Mount DRI devices for GPU access
    environment:
      - GPU_ACCEL=auto  # or 'qsv' to force QSV
```

### Windows (D3D11VA)

**Requirements:**
- Windows host with DirectX 11 support
- Docker Desktop with GPU support enabled
- ffmpeg with D3D11VA support (usually included in Windows builds)

**docker-compose.yml:**
```yaml
services:
  seen:
    # ... other config ...
    environment:
      - GPU_ACCEL=auto  # or 'd3d11va' to force D3D11VA
```

**Note:** D3D11VA provides hardware decoding but uses CPU for scaling. Still provides performance benefits for video decoding.

### macOS (VideoToolbox)

**Requirements:**
- macOS host
- ffmpeg with VideoToolbox support (usually included in Homebrew builds)

**docker-compose.yml:**
```yaml
services:
  seen:
    # ... other config ...
    environment:
      - GPU_ACCEL=auto  # or 'videotoolbox' to force VideoToolbox
```

**Note:** VideoToolbox provides hardware decoding but uses CPU for scaling.

## Verification

### Check GPU Status

1. **Via Diagnostic Endpoint:**
   ```bash
   curl http://localhost:9161/diag/ffmpeg
   ```
   Returns JSON with:
   - `ffmpeg_version`: ffmpeg version string
   - `hwaccels`: List of available hardware accelerators
   - `filters`: List of available GPU scaling filters
   - `gpu_config`: Current GPU configuration including:
     - `accel`: Detected accelerator type
     - `enabled`: Whether GPU is currently enabled
     - `consecutive_failures`: Number of consecutive GPU failures
     - `auto_disabled`: Whether GPU was auto-disabled due to failures
     - `device_counts`: Physical device counts:
       - `cuda`: Number of CUDA devices found
       - `intel_gpu`: Whether Intel GPU devices are present
       - `opencl`: Number of OpenCL devices found

3. **Via Logs:**
   ```bash
   docker logs seen | grep -i gpu
   ```
   Or set `GPU_LOG=1` environment variable for detailed GPU logging.

### Performance Monitoring

The performance dashboard tracks GPU vs CPU usage:
- `gpu_usage.jobs_gpu`: Number of video thumbnails processed with GPU
- `gpu_usage.jobs_cpu`: Number of video thumbnails processed with CPU

## Troubleshooting

### GPU Not Detected

1. **Check ffmpeg capabilities:**
   ```bash
   docker exec seen ffmpeg -hide_banner -hwaccels
   ```

2. **Check available filters:**
   ```bash
   docker exec seen ffmpeg -hide_banner -filters | grep scale
   ```

3. **Verify GPU access in container:**
   - For NVIDIA: `docker exec seen nvidia-smi` (if nvidia-smi is available)
   - For Intel: `docker exec seen ls -la /dev/dri/`

### Fallback Behavior

Seen automatically falls back to CPU if:
- GPU acceleration fails (e.g., unsupported codec)
- GPU command times out (>10 seconds)
- GPU is not available

This ensures reliability even if GPU setup is incomplete.

## Performance Impact

GPU acceleration primarily benefits:
- **Video decoding**: Hardware-accelerated video decoding is significantly faster
- **Video scaling** (CUDA/QSV only): GPU-based scaling can be faster for large videos

Expected improvements:
- **CUDA**: 2-5x faster video thumbnail generation
- **QSV**: 1.5-3x faster video thumbnail generation
- **D3D11VA/VideoToolbox**: 1.5-2x faster (decode only, CPU scaling)

Actual performance depends on:
- Video codec and resolution
- GPU model and capabilities
- System load


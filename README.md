<img width="5000" height="2000" alt="Seen" src="https://github.com/user-attachments/assets/46edf055-c081-4e42-8b85-a77018d9fd54" />

# Seen SQLite v0.8.0 

## Why?

*Pure speed*. Seen is built on Rust, which provides us with a significant advantage in raw performance, memory safety, and concurrency for I/O and CPU-heavy tasks. It's light weight, which means faster deployments.

*Customization*. Most media management apps are opinionated, by design. Which organization strategy should the app follow: Metadata over folder structure? Should a *delete* only remove from the gallery, or the file system? We want to put these choices *in your hands*, offering sensible "set it, and forget it" preferences. 

*Superior Organization*. Life is way too short to be spending on editing metatags, renaming countless files, and coming up with complicated folder structures. Why not let the software do the heavy lifting, and simply *enjoy* your photos.

*Choice.* For single-user simplicity, the **SQLite** backend steps away from a microservice architecture, to a self-contained binary. The ingestion pipeline is clear and modular for future extensibility. For even more scalability, there is also a **PostgreSQL** version.

*Decoupled architecture.* The backend deploys separately from the frontend, and is client agnostic. You can even create your own, and it will work with Seen's backend.

*Quirky - in all the good ways.* A search box which accepts wildcards. Advanced filters to specifically search for WhatsApp or Google Pixel media. Extract audio from video. Ability to transcode older video formats such as MPG, 3GP, WMV,  AVI, etc. Image burst capture of video.

## Facial Recognition 

Detect and mange individuals in your photo library. This feature uses InsightFace models (SCRFD for detection, ArcFace for recognition) via ONNX Runtime.

### Requirements

- **Models**: The feature automatically downloads InsightFace models (~100MB total) on first run
- **Memory**: Models require ~200-300MB RAM when loaded
- **Storage**: Models are cached in `data/models/` directory

## Docker Images

All Docker images are available on Docker Hub at `markraidc/seen-backend`:

### x86_64/AMD64 Images

**With Facial Recognition:**
- `markraidc/seen-backend:0.8.0` (~867MB)
- `markraidc/seen-backend:latest` (~867MB)

**Without Facial Recognition:**
- `markraidc/seen-backend:0.8.0-no-face` (~829MB)
- `markraidc/seen-backend:latest-no-face` (~829MB)

### ARM64 Images

**With Facial Recognition:**
- `markraidc/seen-backend:0.8.0-arm64` (~214MB)
- `markraidc/seen-backend:latest-arm64` (~214MB)

**Without Facial Recognition:**
- `markraidc/seen-backend:0.8.0-no-face-arm64` (~214MB)
- `markraidc/seen-backend:latest-no-face-arm64` (~214MB)

### Pulling Images

```bash
# x86_64 with facial recognition
docker pull markraidc/seen-backend:latest

# x86_64 without facial recognition
docker pull markraidc/seen-backend:latest-no-face

# ARM64 with facial recognition
docker pull markraidc/seen-backend:latest-arm64

# ARM64 without facial recognition
docker pull markraidc/seen-backend:latest-no-face-arm64
```

---

## Deployment Options

Seen can be deployed **with** or **without** facial recognition support:

### **With Facial Recognition (Default)**

Use the standard Docker Compose files:
- `docker-compose.synology.yml`
- `docker-compose.ugreen.yml`
- `docker-compose.windows.yml`

**Benefits:**
- ✅ Full facial recognition features
- ✅ Person detection and clustering
- ✅ Face tagging and organization

**Requirements:**
- ~200MB additional binary size
- ~200-300MB additional RAM for models
- ~100MB storage for model cache

### **Without Facial Recognition (Lightweight)**

Use the `-no-face` Docker Compose files:
- `docker-compose.synology-no-face.yml`
- `docker-compose.ugreen-no-face.yml`
- `docker-compose.windows-no-face.yml`

**Benefits:**
- ✅ Smaller binary size (~200MB reduction)
- ✅ Lower memory usage (~200-300MB less RAM needed)
- ✅ Faster build times
- ✅ No model downloads required
- ✅ Ideal for resource-constrained devices

**Trade-offs:**
- ❌ No facial recognition features
- ❌ No person detection or tagging

**Memory Requirements:**
- **With facial recognition**: 1GB+ recommended
- **Without facial recognition**: 384MB-768MB sufficient

---

### Windows Development

The `docker-compose.windows.yml` file automatically uses your Windows user's Pictures folder (`%USERPROFILE%\Pictures`).

Start the service:
```bash
docker compose -f docker-compose.windows.yml up --build
```

If you want to use a different photo directory, edit `docker-compose.windows.yml` and change the volume path:
```yaml
volumes:
  - C:/path/to/your/photos:/photos:ro
  - ./seen-data:/flash-data:rw
```

#### Lightweight Deployment (Without Facial Recognition)

To deploy without facial recognition support (saves ~200-300MB RAM):

```bash
docker compose -f docker-compose.windows-no-face.yml up --build
```

This version:
- Uses only 1.5GB RAM instead of 2GB
- Smaller binary size
- Faster build times
- No facial recognition features

#### Windows Native Build (EXE)

Build a native Windows executable for better file watcher support:

```bash
cargo build --release
```

**Output:** `target\release\seen_backend.exe`

**Run with batch file (recommended):**
```bash
run-seen-windows.bat
```

The batch file automatically uses your Windows user's Pictures folder (`%USERPROFILE%\Pictures`).

**Or run manually:**
```bash
set FLASH_ROOT=%USERPROFILE%\Pictures
set FLASH_ROOT_HOST=%USERPROFILE%\Pictures
set FLASH_DATA=.\seen-data
set FLASH_PORT=9161
set RUST_LOG=info

target\release\seen_backend.exe
```

**Note:** Native Windows builds use the `image` crate for thumbnails (slower than libvips but functional). File watcher works properly on Windows, detecting moves/renames in Explorer. Docker builds are unaffected.

### Frontend + Backend (Unified Repo)

This repository now contains both the Rust backend and the React/Vite frontend.

#### Local Development

- **Frontend dev server (best DX):**
  - From `frontend/`:
    ```bash
    npm install        # first time only
    npm run dev        # runs Vite on port 5173
    ```
  - From the repo root, run the backend:
    ```bash
    cargo run
    ```
  - Create `frontend/.env.local` (optional) to point Vite at the backend API:
    ```bash
    VITE_API_BASE_URL=http://localhost:9161/api
    ```

- **Integrated mode (backend serves built frontend):**
  - From `frontend/`:
    ```bash
    npm install        # first time only
    npm run build      # outputs to frontend/dist
    ```
  - From the repo root:
    ```bash
    cargo run
    ```
  - Then open `http://localhost:9161/` – the Axum server serves `frontend/dist/index.html`
    and static assets from `frontend/dist/assets`.

### Combined Frontend and Backend Docker Build

To build a single Docker image that includes both the frontend and backend, use the `Dockerfile.combined` file.

The Dockerfile now uses the in-repo `frontend/` directory and runs `npm ci && npm run build`
to produce `frontend/dist` before building the backend.

### Docker Compose files (current support)

- `docker-compose.custom.yml`: local/dev (used by `dev.bat`, works with optional CUDA via `adjust-docker-compose.ps1`).
- `docker-compose.test.yml`: CI/testing.

All legacy platform-specific compose files have been removed; if you need a platform-specific variant, derive from `docker-compose.custom.yml` and override via environment variables.

### Compose overrides (example)

You can override paths, ports, and GPU flags via an env file. Example `my.env`:

```
FLASH_ROOT=/photos
FLASH_DATA=./seen-data
FLASH_PORT=9161
SEEN_USE_GPU=0
```

Then run:

```
docker compose --env-file my.env -f docker-compose.custom.yml up --build
```

For CUDA, set `SEEN_USE_GPU=1` and ensure your host has the NVIDIA container toolkit installed.

---

### Synology NAS Deployment

#### Prerequisites

Before deploying via Portainer or Docker Compose, create the required directories on your Synology NAS:

1. **SSH into your Synology NAS** or use **File Station** with admin privileges

2. **Create the photo directory** (if it doesn't exist):
   ```bash
   sudo mkdir -p /volume1/photos
   sudo chmod 755 /volume1/photos
   ```

3. **Create the Seen data directory**:
   ```bash
   sudo mkdir -p /volume1/seen
   sudo chmod 755 /volume1/seen
   ```

4. **Verify directories exist**:
   ```bash
   ls -la /volume1/ | grep -E "photos|seen"
   ```

#### Deployment via Portainer

1. Open **Portainer** in your browser
2. Navigate to **Stacks** → **Add Stack**
3. Name your stack (e.g., `seen`)
4. Choose **Git Repository** or **Upload** method:
   - **Git Repository**: Point to your repository and select `docker-compose.synology.yml`
   - **Upload**: Copy the contents of `docker-compose.synology.yml`
5. Click **Deploy the stack**

#### Deployment via SSH/Command Line

```bash
docker compose -f docker-compose.synology.yml up -d --build
```

#### Configuration Notes

- **Default photo path**: `/volume1/photos`
- **Data storage**: `/volume1/seen` (database, thumbnails, models)
- **Port**: `9161`
- **GPU Acceleration**: Configured for Intel QSV (DS220+ with J4025 CPU)
- **Memory**: 1GB limit (suitable for DS220+ with 2GB RAM)

If your photos are in a different location, edit the `docker-compose.synology.yml` file and update the volume paths:
```yaml
volumes:
  - /volume1/your-photos:/photos:rw
  - /volume1/seen:/flash-data:rw
```

And update the environment variable:
```yaml
environment:
  - FLASH_ROOT_HOST=/volume1/your-photos
```

#### Lightweight Deployment (Without Facial Recognition)

To deploy without facial recognition support (saves ~200-300MB RAM):

```bash
docker compose -f docker-compose.synology-no-face.yml up -d --build
```

This version:
- Uses only 768MB RAM instead of 1GB
- Smaller binary size
- Faster build times
- No facial recognition features

---

### Ugreen NAS Deployment

#### Prerequisites

Before deploying via Portainer or Docker Compose, create the required directories on your Ugreen NAS:

1. **SSH into your Ugreen NAS** or use the file manager with admin privileges

2. **Create the photo directory** (if it doesn't exist):
   ```bash
   sudo mkdir -p /mnt/ugreen/photos
   sudo chmod 755 /mnt/ugreen/photos
   ```
   
   **Note**: Ugreen NAS paths may vary. Common alternatives:
   - `/mnt/ugreen-nas/photos`
   - `/volume1/photos`
   
   Check your actual mount points with: `df -h` or `mount | grep mnt`

3. **Create the Seen data directory**:
   ```bash
   sudo mkdir -p /mnt/ugreen/seen
   sudo chmod 755 /mnt/ugreen/seen
   ```

4. **Verify directories exist**:
   ```bash
   ls -la /mnt/ugreen/ | grep -E "photos|seen"
   ```

#### Deployment via Portainer

1. Open **Portainer** in your browser
2. Navigate to **Stacks** → **Add Stack**
3. Name your stack (e.g., `seen`)
4. Choose **Git Repository** or **Upload** method:
   - **Git Repository**: Point to your repository and select `docker-compose.ugreen.yml`
   - **Upload**: Copy the contents of `docker-compose.ugreen.yml`
5. **Important**: Before deploying, verify the volume paths in the compose file match your Ugreen NAS structure
6. Click **Deploy the stack**

#### Deployment via SSH/Command Line

**Important:** First, verify and update the volume paths in `docker-compose.ugreen.yml` to match your Ugreen NAS:

```bash
# Check your actual mount points
df -h
mount | grep mnt

# Edit the compose file if needed
nano docker-compose.ugreen.yml

# Deploy
docker compose -f docker-compose.ugreen.yml up -d --build
```

#### Configuration Notes

- **Default photo path**: `/mnt/ugreen/photos` (update if different)
- **Data storage**: `/mnt/ugreen/seen` (database, thumbnails, models)
- **Port**: `9161`
- **GPU Acceleration**: Auto-detect (set to `qsv` if you have Intel CPU)
- **Memory**: 512MB limit (adjust based on your NAS specs)

**Common Ugreen NAS path variations:**
- `/mnt/ugreen/photos`
- `/mnt/ugreen-nas/photos`
- `/volume1/photos`

If your photos are in a different location, edit the `docker-compose.ugreen.yml` file:
```yaml
volumes:
  - /your/actual/path/photos:/photos:rw
  - /your/actual/path/seen:/flash-data:rw
```

And update the environment variable:
```yaml
environment:
  - FLASH_ROOT_HOST=/your/actual/path/photos
```

#### Lightweight Deployment (Without Facial Recognition)

To deploy without facial recognition support (saves ~200-300MB RAM):

```bash
docker compose -f docker-compose.ugreen-no-face.yml up -d --build
```

This version:
- Uses only 384MB RAM instead of 512MB
- Smaller binary size
- Faster build times
- No facial recognition features

---

**Service Access**: After deployment, access Seen at `http://your-nas-ip:9161`

## Path Mapping (Docker/WSL)

When Seen runs inside Docker/WSL, the database still contains the host's original file paths (for example `C:\Users\you\Pictures`). The backend now normalizes every file operation (rotation, delete-from-disk, etc.) by remapping that host prefix to the container mount. Configure these environment variables so the mapping is unambiguous:

- `FLASH_ROOT` – the path inside the container that is bind-mounted to your photos (defaults to `/photos`)
- `FLASH_ROOT_HOST` – the original host path that was scanned (e.g. `C:\Users\you\Pictures`)

Example for Windows Docker Compose:

```yaml
environment:
  FLASH_ROOT: /photos
  FLASH_ROOT_HOST: C:\Users\you\Pictures
volumes:
  - C:/Users/you/Pictures:/photos:rw
```

With this mapping in place, Seen can always resolve the real file even when running in a different environment.

## Testing

Tests require a Linux environment and should be run using Docker (even on Windows/macOS):

```bash
# Run all tests
docker compose -f docker-compose.test.yml up --build

# Run specific test
docker compose -f docker-compose.test.yml run --rm test cargo test --test smoke --verbose

# Run without facial-recognition
docker compose -f docker-compose.test.yml run --rm test cargo test --no-default-features --verbose
```

**Note**: Tests are not designed to run natively on Windows/macOS. Use Docker for consistent, production-like testing. See `TESTING.md` for detailed documentation.

## Notes

- Images/videos are not stored in SQLite, only metadata.
- Thumbnails and previews are saved under ${FLASH_DATA}/derived.
- SQLite is in WAL mode; DB file at ${FLASH_DATA}/db/seen.db.

<img width="1873" height="836" alt="image" src="https://github.com/user-attachments/assets/7c46c906-c65b-4da6-9e95-7308b948b79a" />

<img width="1887" height="873" alt="image" src="https://github.com/user-attachments/assets/f563309b-7c4d-441d-ac30-a65be31d2e7c" />




<img width="5000" height="2000" alt="Seen" src="https://github.com/user-attachments/assets/d137d955-cc80-4e5b-9701-6881fe479520" />

# Seen Web v0.8.0

a React based front-end for Seen - a comprehensive photo/video management app. The "Web" designation is used to differentiate it from the desktop version, currently in development.

## Prerequisites

- Node.js 20.19+ or 22.12+
- Seen backend running locally at `http://localhost:9161` (or configure via env)

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser (Vite's default port).

## Docker Image

Build and serve the production bundle with nginx:

```bash
# Build with default API URL (http://localhost:9161)
docker build -t seenweb:0.8.0 .

# Build with custom API URL (e.g. for NAS deployment with relative path)
docker build --build-arg VITE_API_BASE_URL=/api -t seenweb:0.8.0 .
```

Run the container:

```bash
docker run --rm -p 3000:80 seenweb:0.8.0
```

**Note:** The `VITE_API_BASE_URL` is baked into the static files at build time. You cannot change it at runtime with an environment variable in the production image.

## Docker Compose

Use the backend repo’s `docker-compose.custom.yml` (with overrides) instead of legacy frontend compose files.

## Windows EXE Build (Tauri)

Build a standalone Windows executable using Tauri:

```bash
# Build Windows EXE
npm run tauri:build

# Or use the batch script
build-tauri-windows.bat
```

**Output:**
- Executable: `src-tauri\target\release\seen-frontend.exe`
- Installer: `src-tauri\target\release\bundle\nsis\seen-frontend_0.8.0_x64-setup.exe`

### Docker/WSL Folder Browser Flag

The React “Browse” UI (which calls the backend `/browse` endpoint) is only meaningful when the backend runs in Docker/WSL with host paths mounted under `/host`. To enable that UI in web builds, set:

```bash
VITE_ENABLE_FILE_BROWSER=1 npm run build
```

Without this flag, the UI will fall back to the native Tauri dialog (desktop) or require manual absolute paths (web), which is the correct behavior when the backend runs natively on Windows.

**Development mode:**
```bash
npm run tauri:dev
```

**Note:** Tauri uses the system WebView (Edge/Chromium). The Docker build process is unaffected and can be used alongside Tauri.

## Configuration

- API base URL: set `VITE_API_BASE_URL` in `.env` (defaults to `http://localhost:9161`).

Example `.env`:

```env
VITE_API_BASE_URL=http://localhost:9161
```

## Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run preview` — preview production build
- `npm run tauri:dev` — Tauri development mode
- `npm run tauri:build` — build Windows EXE

## Features

- Dashboard with system stats and scan control
- Infinite-scrolling media gallery with sort options
- Full-text search with filters (date range, camera)
- Asset detail view with metadata
- Light/dark/system theme + persistent preferences
- **Facial Recognition**: Detect and manage faces, merge persons, and more.

## Notes

- Thumbnails and previews are loaded directly from the backend with browser caching.
- Stats are polled every 2s from `/stats` to reflect scan/queue progress.

<img width="1873" height="836" alt="image" src="https://github.com/user-attachments/assets/5746cbd2-82f6-4fcb-a255-92d1be233b86" />
<img width="1887" height="873" alt="image" src="https://github.com/user-attachments/assets/9c6aeb97-b622-4bdf-a4af-6ca241a5ce8f" />


# Seen API Documentation

This document describes the REST API endpoints provided by the Seen backend server. The API uses JSON for request and response bodies, and follows standard HTTP status codes.

**Base URL**: The API is typically served on `http://localhost:3000` (or as configured)

**CORS**: The API allows requests from any origin and supports the following HTTP methods: `GET`, `POST`, `DELETE`, `OPTIONS`

---

## Table of Contents

1. [Health & Status](#health--status)
2. [Statistics & Metrics](#statistics--metrics)
3. [Assets](#assets)
4. [Paths & Scanning](#paths--scanning)
5. [File Operations](#file-operations)
6. [Facial Recognition](#facial-recognition) (optional feature)

---

## Health & Status

### GET /health

Check server health and version information.

**Response**: `200 OK`

```json
{
  "status": "ok",
  "version": "0.8.0",
  "database": "SQLite"
}
```

**Fields**:
- `status`: Always `"ok"` when the server is running
- `version`: Application version number
- `database`: Database type (`"SQLite"` or `"Postgres"`)

---

## Statistics & Metrics

### GET /stats

Get comprehensive statistics about the system, including queue depths, processing rates, and scan status.

**Response**: `200 OK`

```json
{
  "uptime_seconds": 3600,
  "queues": {
    "discover": 0,
    "hash": 5,
    "metadata": 10,
    "db_write": 20,
    "thumb": 15
  },
  "processed": {
    "files_total": 10000,
    "bytes_total": 5000000000,
    "files_per_sec": 25.5,
    "bytes_per_sec": 25500000.0,
    "mb_per_sec": 25.5
  },
  "processing": {
    "files_committed": 8500,
    "bytes_total": 5000000000,
    "rate_files_per_sec": 20.0,
    "throughput_mb_per_sec": 20.0,
    "last_completed_elapsed_seconds": 425.0
  },
  "scan_running": true,
  "processing_active": true,
  "current_scan": {
    "files_processed": 5000,
    "files_per_sec": 25.5,
    "elapsed_seconds": 196.0,
    "photos_processed": 4000,
    "videos_processed": 1000
  },
  "current_processing": {
    "files_committed": 4500,
    "processing_rate_files_per_sec": 20.0,
    "elapsed_seconds": 225.0
  },
  "db": {
    "assets": 8500
  }
}
```

**Fields**:
- `uptime_seconds`: Server uptime in seconds
- `queues`: Current queue depths for each processing stage
- `processed`: Overall statistics (lifetime totals and rates)
- `processing`: Processing pipeline statistics (files committed, not just discovered)
- `scan_running`: Whether any path is currently being scanned
- `processing_active`: Whether there are items in processing queues
- `current_scan`: Statistics for the current scan (if active)
- `current_processing`: Statistics for current processing (if active)
- `db.assets`: Total number of assets in the database

### POST /stats/reset

Reset performance statistics. Cannot be called while a scan is running.

**Response**: `200 OK` on success, `409 Conflict` if scan is running

```json
{
  "success": true,
  "message": "Performance statistics reset"
}
```

### GET /metrics

Get metrics in Prometheus format.

**Response**: `200 OK` (text/plain)

Returns Prometheus-formatted metrics including:
- Queue depths
- Processing rates
- File counts
- Throughput statistics

### GET /performance

Get detailed performance metrics and comparisons with other photo library software.

**Response**: `200 OK`

```json
{
  "seen": {
    "files_per_sec": 25.5,
    "current_rate": 25.5,
    "mb_per_sec": 25.5,
    "status": "excellent",
    "is_active": true
  },
  "system_info": {
    "cpu_cores": 8,
    "cpu_brand": "Intel Core i7-9700K",
    "accel": "CUDA",
    "note": "Estimated performance ranges based on your hardware (CPU cores). Values are static and don't change with Seen's current rate."
  },
  "gpu_usage": {
    "enabled": true,
    "accel": "CUDA",
    "jobs_gpu": 5,
    "jobs_cpu": 0,
    "consecutive_failures": 0,
    "auto_disabled": false
  },
  "typical_ranges": {
    "digikam": {
      "files_per_sec": "2.1-3.9",
      "note": "Desktop application, single-threaded indexing (less affected by cores)"
    },
    "photoprism": {
      "files_per_sec": "5.6-10.4",
      "note": "Go-based, multi-threaded, includes AI features (scales with cores)"
    },
    "immich": {
      "files_per_sec": "8.4-15.6",
      "note": "TypeScript/Node.js, optimized for modern hardware (scales with cores)"
    },
    "lightroom": {
      "files_per_sec": "1.4-2.6",
      "note": "Desktop application, includes full RAW processing (CPU-intensive)"
    },
    "synology_ds220_plus": {
      "files_per_sec": "0.5-1.0",
      "note": "NAS device (Intel Celeron J4025, 2 cores). Optimized for storage, slower CPU processing."
    }
  },
  "current_scan": {
    "files_processed": 5000,
    "files_per_sec": 25.5,
    "elapsed_seconds": 196.0,
    "status": "excellent"
  },
  "current_rate": 25.5,
  "notes": [
    "Performance varies significantly based on:",
    "- File sizes (larger files = slower processing)",
    "- Storage type (SSD vs HDD)",
    "- CPU cores and speed",
    "- Whether thumbnails are being generated",
    "- Network latency (if files are on network storage)"
  ]
}
```

### GET /file-types

Get distribution of file types in the database.

**Response**: `200 OK`

```json
{
  "image/jpeg": 5000,
  "image/png": 2000,
  "image/webp": 500,
  "video/mp4": 1000,
  "video/mov": 500,
  "audio": 200,
  "other": 100,
  "other_extensions": [".pdf", ".txt"],
  "other_breakdown": {
    ".pdf": 80,
    ".txt": 20
  }
}
```

### GET /diag/ffmpeg

Get FFmpeg diagnostic information including version, hardware acceleration support, and GPU configuration.

**Response**: `200 OK`

```json
{
  "ffmpeg_version": "ffmpeg version 6.0",
  "hwaccels": ["cuda", "qsv", "d3d11va"],
  "filters": ["scale_cuda", "scale_npp"],
  "gpu_config": {
    "accel": "CUDA",
    "enabled": true,
    "consecutive_failures": 0,
    "auto_disabled": false,
    "device_counts": {
      "cuda": 1,
      "intel_gpu": 0,
      "opencl": 0
    }
  }
}
```

---

## Assets

### GET /assets

List assets with pagination and sorting.

**Query Parameters**:
- `offset` (optional, default: 0): Number of assets to skip
- `limit` (optional, default: 200): Maximum number of assets to return
- `sort` (optional, default: "mtime"): Field to sort by (`mtime`, `ctime`, `size`, `filename`)
- `order` (optional, default: "desc"): Sort order (`asc` or `desc`)
- `person_id` (optional, facial-recognition feature only): Filter assets by person ID

**Response**: `200 OK`

```json
[
  {
    "id": 1,
    "path": "/photos/image.jpg",
    "filename": "image.jpg",
    "mime": "image/jpeg",
    "size": 1024000,
    "mtime": 1234567890,
    "ctime": 1234567890,
    "sha256": "abc123...",
    "width": 1920,
    "height": 1080,
    "camera_make": "Canon",
    "camera_model": "EOS 5D",
    "date_taken": "2023-01-15T10:30:00Z"
  }
]
```

### GET /assets/search

Search assets by text query and optional filters.

**Query Parameters**:
- `q` (required): Search query string
- `from` (optional): Filter by date taken (Unix timestamp)
- `to` (optional): Filter by date taken (Unix timestamp)
- `camera_make` (optional): Filter by camera make
- `camera_model` (optional): Filter by camera model
- `offset` (optional, default: 0): Number of assets to skip
- `limit` (optional, default: 200): Maximum number of assets to return

**Response**: `200 OK`

Returns the same format as `/assets`.

### GET /asset/:id

Get detailed information about a specific asset.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` or `404 Not Found`

```json
{
  "id": 1,
  "path": "/photos/image.jpg",
  "filename": "image.jpg",
  "mime": "image/jpeg",
  "size": 1024000,
  "mtime": 1234567890,
  "ctime": 1234567890,
  "sha256": "abc123...",
  "width": 1920,
  "height": 1080,
  "camera_make": "Canon",
  "camera_model": "EOS 5D",
  "date_taken": "2023-01-15T10:30:00Z"
}
```

### DELETE /asset/:id

Remove an asset from the Seen index (database/search) without touching the original file on disk. Generated thumbnails/previews are still removed.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` on success, `404 Not Found` if asset doesn't exist, `500 Internal Server Error` on failure

```json
{
  "success": true
}
```

### DELETE /asset/:id/permanent

Permanently delete an asset from both the Seen index and the original filesystem. Thumbnails/previews are removed as well.

**Path Parameters**:
- `id`: Asset ID

**Response codes**:
- `200 OK` – asset deleted from disk and index
- `404 Not Found` – asset missing from the index
- `409 Conflict` – original file could not be removed (e.g., read-only filesystem)
- `500 Internal Server Error` – unexpected failure

**Response body**:

```json
{
  "success": true,
  "deleted_from_disk": true,
  "read_only": false,
  "path": "/photos/image.jpg"
}
```

When a file cannot be deleted because it is read-only, the response looks like:

```json
{
  "success": false,
  "deleted_from_disk": false,
  "read_only": true,
  "path": "/photos/image.jpg",
  "error": "File is read-only"
}
```

### POST /assets/permanent

Bulk permanent deletion. Accepts a JSON body with asset IDs and returns per-item status, including read-only failures.

**Request Body**:

```json
{
  "ids": [1, 2, 3]
}
```

**Response**: `200 OK` if every asset was deleted, `409 Conflict` if any read-only failures occurred, `400/500` for invalid input or internal errors.

```json
{
  "success": false,
  "results": [
    { "id": 1, "deleted": true, "read_only": false, "path": "/photos/a.jpg" },
    { "id": 2, "deleted": false, "read_only": true, "path": "/photos/b.jpg", "error": "File is read-only" }
  ],
  "read_only_failures": [
    { "id": 2, "path": "/photos/b.jpg", "error": "File is read-only" }
  ]
}
```

### GET /thumb/:id

Get a 256x256 thumbnail image for an asset.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` (image/webp) or `404 Not Found`

Returns a WebP image with appropriate cache headers.

### GET /preview/:id

Get a 1600px preview image for an asset.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` (image/webp) or `404 Not Found`

Returns a WebP image with appropriate cache headers.

### GET /asset/:id/video

Stream a video file with range request support.

**Path Parameters**:
- `id`: Asset ID

**Headers** (optional):
- `Range`: HTTP range header for partial content (e.g., `bytes=0-1023`)

**Response**: 
- `200 OK` (full file) or `206 Partial Content` (range request)
- `404 Not Found` if asset doesn't exist

Returns the video file with appropriate MIME type and headers.

### GET /asset/:id/audio.mp3

Extract audio from a video or audio file and return as MP3.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` (audio/mpeg) or `400 Bad Request` if not a video/audio file, `404 Not Found` if asset doesn't exist

**Note**: If the source file is already MP3, it's returned directly. Otherwise, FFmpeg is used to transcode to MP3. If MP3 encoding fails, falls back to AAC in M4A container.

### GET /asset/:id/download

Download the original asset file.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` with `Content-Disposition: attachment` or `404 Not Found`

Returns the original file with appropriate MIME type and download headers.

### POST /asset/:id/orientation

Save the orientation/rotation for an asset.

**Path Parameters**:
- `id`: Asset ID

**Request Body**:
```json
{
  "rotation": 90
}
```

**Valid rotation values**: `0`, `90`, `180`, `270` (degrees)

**Response**: `200 OK` on success, `400 Bad Request` for invalid rotation, `404 Not Found` if asset doesn't exist

```json
{
  "success": true
}
```

---

## Paths & Scanning

### GET /paths

Get list of all scan paths.

**Response**: `200 OK`

```json
[
  {
    "path": "/photos",
    "is_default": true,
    "host_path": "/mnt/photos"
  },
  {
    "path": "/videos",
    "is_default": false,
    "host_path": null
  }
]
```

**Fields**:
- `path`: The scan path
- `is_default`: Whether this is the default root path
- `host_path`: Host path mapping (for Docker/container scenarios, null if not applicable)

### POST /paths

Add a new scan path. Automatically starts a watcher and BFS scan for the path.

**Request Body**:
```json
{
  "path": "/new/photos"
}
```

**Response**: `200 OK` on success, `500 Internal Server Error` on database error

```json
{
  "success": true,
  "message": "Path added successfully"
}
```

### DELETE /paths

Remove a scan path and delete all associated assets.

**Query Parameters**:
- `path`: The path to remove

**Response**: `200 OK` on success

```json
{
  "success": true,
  "path_removed": true,
  "assets_deleted": 100,
  "faces_deleted": 50,
  "message": "Path removed. 100 assets and 50 faces deleted."
}
```

### POST /paths/scan

Start a BFS scan for a specific path.

**Request Body**:
```json
{
  "path": "/photos"
}
```

**Response**: `202 Accepted` on success, `404 Not Found` if path doesn't exist, `409 Conflict` if already scanning

```json
{
  "success": true,
  "message": "Scan started for path"
}
```

### POST /paths/pause

Pause scanning and file watching for a specific path.

**Request Body**:
```json
{
  "path": "/photos"
}
```

**Response**: `200 OK`

```json
{
  "success": true,
  "message": "Path paused"
}
```

### POST /paths/resume

Resume file watching for a specific path (does not restart scanning).

**Request Body**:
```json
{
  "path": "/photos"
}
```

**Response**: `200 OK`

```json
{
  "success": true,
  "message": "Path resumed"
}
```

### GET /paths/status

Get the status of a specific path (scanning, watcher paused, watching).

**Query Parameters**:
- `path`: The path to check

**Response**: `200 OK`

```json
{
  "scanning": false,
  "watcher_paused": false,
  "watching": true
}
```

### GET /browse

Browse directory contents (for file picker UI).

**Query Parameters**:
- `path` (optional, default: "/"): Directory path to browse (must be absolute)

**Response**: `200 OK` or `400 Bad Request` for invalid path

```json
{
  "path": "/photos",
  "entries": [
    {
      "name": "2023",
      "path": "/photos/2023",
      "is_dir": true
    },
    {
      "name": "image.jpg",
      "path": "/photos/image.jpg",
      "is_dir": false
    }
  ]
}
```

**Note**: Hidden files/directories (starting with `.`) are filtered out. Entries are sorted with directories first, then files, both alphabetically.

---

## File Operations

### DELETE /clear

Clear all data from the database (assets, faces, persons). Cannot be called while a scan is running.

**Response**: `200 OK` on success, `409 Conflict` if scan is running, `500 Internal Server Error` on error

```json
{
  "success": true,
  "assets_deleted": 10000,
  "faces_deleted": 5000,
  "persons_deleted": 100,
  "message": "All data cleared"
}
```

---

## Facial Recognition

These endpoints are only available when the `facial-recognition` feature is enabled.

### POST /faces/detect

Start face detection for all images that haven't been processed yet.

**Response**: `202 Accepted` on success, `409 Conflict` if already running

```json
{
  "status": "started",
  "message": "Face detection started"
}
```

### POST /faces/stop

Stop face detection and disable it.

**Response**: `200 OK`

```json
{
  "status": "stopped",
  "message": "Face detection disabled"
}
```

### GET /faces/status

Get face detection status and queue depth.

**Response**: `200 OK`

```json
{
  "running": false,
  "queue_depth": 0
}
```

### GET /faces/progress

Get detailed face detection progress and statistics.

**Response**: `200 OK`

```json
{
  "enabled": true,
  "running": false,
  "queue_depth": 0,
  "models_loaded": {
    "scrfd": true,
    "arcface": true
  },
  "models_status": "SCRFD and ArcFace loaded",
  "counts": {
    "faces_total": 5000,
    "persons_total": 100,
    "assets_with_faces": 2000
  },
  "thresholds": {
    "cluster_batch_size": 100,
    "remaining_to_next_cluster": 50
  },
  "status": "Ready to cluster"
}
```

### GET /faces/settings

Get current facial recognition settings.

**Response**: `200 OK`

```json
{
  "confidence_threshold": 0.20,
  "nms_iou_threshold": 0.4,
  "cluster_epsilon": 0.55,
  "min_cluster_size": 2,
  "min_samples": 2,
  "excluded_extensions": ["gif", "bmp"]
}
```

**Fields**:
- `confidence_threshold`: Minimum confidence for face detection (0.0-1.0)
- `nms_iou_threshold`: Non-maximum suppression IoU threshold
- `cluster_epsilon`: HDBSCAN clustering epsilon parameter
- `min_cluster_size`: Minimum cluster size for HDBSCAN
- `min_samples`: Minimum samples for HDBSCAN
- `excluded_extensions`: File extensions to exclude from face detection

### POST /faces/settings

Update facial recognition settings.

**Request Body** (all fields optional):
```json
{
  "confidence_threshold": 0.25,
  "nms_iou_threshold": 0.45,
  "cluster_epsilon": 0.6,
  "min_cluster_size": 3,
  "min_samples": 3,
  "excluded_extensions": ["gif", "bmp", "tiff"]
}
```

**Response**: `200 OK`

```json
{
  "status": "updated"
}
```

### GET /faces/unassigned

List unassigned faces (faces not yet assigned to a person).

**Query Parameters**:
- `offset` (optional, default: 0): Number of faces to skip
- `limit` (optional, default: 60, max: 500): Maximum number of faces to return

**Response**: `200 OK`

```json
{
  "faces": [
    {
      "id": 1,
      "asset_id": 100,
      "bbox": {
        "x1": 100.0,
        "y1": 150.0,
        "x2": 200.0,
        "y2": 250.0
      },
      "confidence": 0.95
    }
  ]
}
```

### GET /faces/:id/thumb

Get a thumbnail image of a detected face.

**Path Parameters**:
- `id`: Face ID

**Query Parameters**:
- `size` (optional, default: 160, min: 32, max: 1024): Thumbnail size in pixels

**Response**: `200 OK` (image/png) or `404 Not Found`

### POST /faces/cluster

Trigger face clustering to group similar faces into persons.

**Query Parameters**:
- `epsilon` (optional): Clustering epsilon parameter (default: 0.55, or from `SEEN_FACE_CLUSTER_EPSILON` env var)
- `min_samples` (optional): Minimum samples per cluster (default: 2, or from `SEEN_FACE_HDBSCAN_MIN_SAMPLES` env var)

**Response**: `200 OK` on success, `409 Conflict` if face detection is running, `500 Internal Server Error` on error

```json
{
  "success": true,
  "persons_created": 10,
  "faces_assigned": 50,
  "message": "Clustered 50 faces into 10 persons"
}
```

### POST /faces/:id/assign

Assign a face to a person, or unassign it.

**Path Parameters**:
- `id`: Face ID

**Request Body**:
```json
{
  "person_id": 5
}
```

To unassign a face, set `person_id` to `null`:
```json
{
  "person_id": null
}
```

**Response**: `200 OK` on success, `404 Not Found` if face or person doesn't exist

```json
{
  "success": true,
  "action": "assigned",
  "person_id": 5
}
```

When unassigning:
```json
{
  "success": true,
  "action": "unassigned",
  "previous_person_id": 5
}
```

### POST /faces/recluster

Trigger a full re-clustering of all faces. This clears existing person assignments and re-runs clustering on all face embeddings.

**Response**: `200 OK` on success, `500 Internal Server Error` on error

```json
{
  "success": true,
  "persons": 15,
  "faces": 120
}
```

### POST /faces/smart-merge

Automatically merge similar persons based on face similarity.

**Query Parameters**:
- `threshold` (optional, default: 0.50): Similarity threshold for merging (0.0-1.0, lower = more similar required)

**Response**: `200 OK` on success, `409 Conflict` if face detection is running, `400 Bad Request` if not enough persons

```json
{
  "success": true,
  "persons_merged": 5,
  "faces_merged": 25,
  "remaining_persons": 10
}
```

### POST /faces/recluster/person/:id

Refresh a person's profile by recalculating their centroid from assigned faces.

**Path Parameters**:
- `id`: Person ID

**Response**: `200 OK` on success, `404 Not Found` if person doesn't exist

```json
{
  "success": true,
  "profile": {
    "person_id": 5,
    "face_count": 10,
    "centroid_dim": 512
  }
}
```

### DELETE /faces/clear

Clear all facial recognition data (faces and persons). Cannot be called while face detection is running.

**Response**: `200 OK` on success, `409 Conflict` if face detection is running, `500 Internal Server Error` on error

```json
{
  "success": true,
  "faces_deleted": 5000,
  "persons_deleted": 100,
  "message": "All facial data cleared"
}
```

### GET /persons

List all persons.

**Response**: `200 OK`

```json
[
  {
    "id": 1,
    "name": "John Doe",
    "created_at": "2023-01-15T10:30:00Z"
  }
]
```

### GET /persons/:id

Get information about a specific person.

**Path Parameters**:
- `id`: Person ID

**Response**: `200 OK` or `404 Not Found`

```json
{
  "id": 1,
  "name": "John Doe",
  "created_at": "2023-01-15T10:30:00Z"
}
```

### GET /persons/:id/assets

Get list of asset IDs associated with a person.

**Path Parameters**:
- `id`: Person ID

**Response**: `200 OK` or `500 Internal Server Error`

```json
{
  "asset_ids": [1, 2, 3, 4, 5]
}
```

### POST /persons/:id

Update a person's name.

**Path Parameters**:
- `id`: Person ID

**Request Body**:
```json
{
  "name": "Jane Doe"
}
```

**Response**: `200 OK` on success, `404 Not Found` if person doesn't exist, `500 Internal Server Error` on error

```json
{
  "success": true
}
```

### DELETE /persons/:id

Delete a person and unassign all associated faces.

**Path Parameters**:
- `id`: Person ID

**Response**: `200 OK` on success, `404 Not Found` if person doesn't exist, `500 Internal Server Error` on error

```json
{
  "success": true
}
```

### POST /persons/merge

Manually merge two persons into one.

**Request Body**:
```json
{
  "source_person_id": 3,
  "target_person_id": 5
}
```

**Response**: `200 OK` on success, `404 Not Found` if either person doesn't exist, `400 Bad Request` if trying to merge a person into itself

```json
{
  "success": true,
  "merged_person": {
    "id": 5,
    "name": "Person 5",
    "face_count": 15,
    "centroid_dim": 512
  }
}
```

**Note**: All faces from `source_person_id` are reassigned to `target_person_id`, and the source person is deleted.

### GET /persons/:id/face

Get the representative face ID for a person (typically the face with highest confidence).

**Path Parameters**:
- `id`: Person ID

**Response**: `200 OK` on success, `404 Not Found` if person has no faces

```json
{
  "face_id": 42
}
```

### GET /assets/:id/faces

Get all faces detected in a specific asset.

**Path Parameters**:
- `id`: Asset ID

**Response**: `200 OK` or `500 Internal Server Error`

```json
[
  {
    "id": 1,
    "person_id": 5,
    "bbox": "{\"x1\":100.0,\"y1\":150.0,\"x2\":200.0,\"y2\":250.0}",
    "confidence": 0.95
  }
]
```

**Note**: `person_id` may be `null` if the face hasn't been assigned to a person yet.

---

## Error Responses

All endpoints may return the following error status codes:

- `400 Bad Request`: Invalid request parameters or body
- `404 Not Found`: Resource not found
- `409 Conflict`: Operation cannot be performed (e.g., scan already running)
- `500 Internal Server Error`: Server error

Error responses typically include a JSON body:

```json
{
  "error": "Error message description"
}
```

---

## Notes

- All timestamps are Unix timestamps (seconds since epoch) unless otherwise specified
- File sizes are in bytes
- The API uses CORS and allows requests from any origin
- Rate limiting is not currently implemented
- Some endpoints may take significant time to respond (e.g., `/faces/cluster`, `/clear`) and should be called asynchronously
- The API is designed to be stateless, but some operations (like scanning) maintain server-side state


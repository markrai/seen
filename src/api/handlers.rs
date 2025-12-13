use std::sync::Arc;
use axum::{extract::{State, Path, Query}, http::{StatusCode, header, HeaderMap}, Json, response::IntoResponse};
use serde::{Deserialize, Serialize};
use crate::{AppPaths, AppState, db};
use tracing::info;
use rusqlite::{Connection, params, OptionalExtension};
use anyhow::Result;
use hex;
use std::path::Path as StdPath;
use crate::utils::ffmpeg;
use std::io;
use axum::response::Html;
#[cfg(not(target_env = "msvc"))]
use libvips::ops::Angle;

pub async fn serve_index() -> impl IntoResponse {
    // Serve the built SPA entrypoint from the Vite dist output
    if let Ok(body) = tokio::fs::read_to_string("frontend/dist/index.html").await {
        let mime = mime_guess::from_path("index.html").first_or_octet_stream();
        (StatusCode::OK, [(header::CONTENT_TYPE, mime.as_ref())], Html(body)).into_response()
    } else {
        (StatusCode::NOT_FOUND, "Not Found").into_response()
    }
}

pub async fn health() -> impl IntoResponse {
    let v = env!("CARGO_PKG_VERSION");
    #[cfg(feature = "postgres")]
    let db_type = "Postgres";
    #[cfg(not(feature = "postgres"))]
    let db_type = "SQLite";

    // Build backend libraries list based on feature flags
    let mut backend_libraries = vec![
        "tokio - Async runtime".to_string(),
        "axum - Web framework".to_string(),
        "tower-http - HTTP middleware".to_string(),
        "serde - Serialization framework".to_string(),
        "chrono - Date and time handling".to_string(),
        "walkdir - Directory traversal".to_string(),
        "notify - File system notifications".to_string(),
        "xxhash-rust - Fast hashing".to_string(),
        "sha2 - SHA-256 hashing".to_string(),
        "libvips - Image processing".to_string(),
        "memmap2 - Memory-mapped files".to_string(),
        "tracing - Structured logging".to_string(),
        "anyhow - Error handling".to_string(),
        "mime_guess - MIME type detection".to_string(),
        "hyper - HTTP client/server".to_string(),
        "parking_lot - Synchronization primitives".to_string(),
        "sysinfo - System information".to_string(),
        "image - Image decoding".to_string(),
        "reqwest - HTTP client".to_string(),
    ];

    // Add database-specific libraries
    #[cfg(feature = "postgres")]
    {
        backend_libraries.push("sqlx - PostgreSQL database".to_string());
    }
    #[cfg(not(feature = "postgres"))]
    {
        backend_libraries.push("rusqlite - SQLite database".to_string());
    }

    // Add optional facial recognition libraries
    #[cfg(feature = "facial-recognition")]
    {
        backend_libraries.push("ort - ONNX Runtime (optional, facial recognition)".to_string());
        backend_libraries.push("rayon - Parallel processing (optional, facial recognition)".to_string());
        backend_libraries.push("ndarray - N-dimensional arrays (optional, facial recognition)".to_string());
    }

    let body = serde_json::json!({
        "status": "ok",
        "version": v,
        "database": db_type,
        "backend_libraries": backend_libraries
    });
    (StatusCode::OK, Json(body))
}

pub async fn stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let depths = state.gauges.depths();

    // Use cached counts with 5-second TTL to reduce database load
    const CACHE_TTL_SECS: u64 = 5;
    let (db_count, total_photos, total_videos) = if state.stats_cache.is_stale(CACHE_TTL_SECS) {
        // Cache is stale, refresh from database
        let counts = tokio::task::spawn_blocking({
            let pool = state.pool.clone();
            move || {
                let conn = pool.get().ok()?;
                let total: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).ok()?;
                let photos: i64 = conn.query_row("SELECT COUNT(*) FROM assets WHERE mime LIKE 'image/%'", [], |r| r.get(0)).ok()?;
                let videos: i64 = conn.query_row("SELECT COUNT(*) FROM assets WHERE mime LIKE 'video/%'", [], |r| r.get(0)).ok()?;
                Some((total, photos, videos))
            }
        }).await.ok().flatten().unwrap_or((0, 0, 0));

        // Update cache
        state.stats_cache.update(counts.0, counts.1, counts.2);
        counts
    } else {
        // Use cached values
        state.stats_cache.get()
    };

    let scan_stats = state.stats.scan_stats();
    let last_completed_scan_files = state.stats.last_completed_scan_files();
    let last_completed_scan_elapsed = state.stats.last_completed_scan_elapsed();

    // Get photo/video counts for current scan if active (uses cached totals)
    let scan_breakdown = if scan_stats.is_some() {
        let files_processed = scan_stats.map(|(f, _, _)| f).unwrap_or(0);
        // Use cached totals instead of querying database again
        let photo_ratio = if db_count > 0 { total_photos as f64 / db_count as f64 } else { 0.0 };
        let video_ratio = if db_count > 0 { total_videos as f64 / db_count as f64 } else { 0.0 };
        let photos_in_scan = (files_processed as f64 * photo_ratio) as i64;
        let videos_in_scan = (files_processed as f64 * video_ratio) as i64;
        Some((photos_in_scan, videos_in_scan))
    } else {
        None
    };

    let is_scanning = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    let has_queued_items = depths.discover > 0 || depths.hash > 0 || depths.metadata > 0 || depths.db_write > 0 || depths.thumb > 0;
    let is_active = is_scanning || has_queued_items;

    // Detect transition from active to inactive (processing just finished)
    let was_active = state.stats_cache.was_processing_active.swap(is_active, std::sync::atomic::Ordering::Relaxed);
    if was_active && !is_active {
        // Processing just finished - store final rates and clear timer
        state.stats.stop_processing();
    }

    // Use last completed scan rate when idle to prevent decay
    let files_per_sec = if is_active {
        state.stats.files_per_sec()
    } else {
        state.stats.last_completed_scan_rate().unwrap_or_else(|| state.stats.files_per_sec())
    };

    let mb_per_sec = if is_active {
        state.stats.bytes_per_sec() / 1_000_000.0
    } else {
        state.stats.last_completed_scan_mb_per_sec().unwrap_or_else(|| state.stats.bytes_per_sec() / 1_000_000.0)
    };

    // Processing stats: tracks files committed (not discovered)
    let processing_stats = state.stats.processing_stats();
    let processing_rate = if is_active {
        processing_stats.map(|(_, rate, _)| rate).unwrap_or(0.0)
    } else {
        state.stats.last_completed_processing_rate().unwrap_or(0.0)
    };
    let processing_mb_per_sec = if is_active {
        state.stats.processing_throughput_mb_per_sec().unwrap_or(0.0)
    } else {
        state.stats.last_completed_processing_mb_per_sec().unwrap_or(0.0)
    };

    let body = serde_json::json!({
        "uptime_seconds": state.stats.uptime_secs(),
        "queues": {"discover": depths.discover, "hash": depths.hash, "metadata": depths.metadata, "db_write": depths.db_write, "thumb": depths.thumb},
        // Discovery stats (files discovered in the last/active scan)
        "discovery": {
            "files_discovered": scan_stats.map(|(files, _, _)| files).unwrap_or(last_completed_scan_files),
            "rate_files_per_sec": scan_stats.map(|(_, rate, _)| rate).unwrap_or(state.stats.last_completed_scan_rate().unwrap_or(0.0)),
            "last_completed_elapsed_seconds": last_completed_scan_elapsed.unwrap_or(0.0)
        },
        "processed": {
            "files_total": state.stats.files_total(),
            "bytes_total": state.stats.bytes_total(),
            "files_per_sec": files_per_sec,
            "bytes_per_sec": files_per_sec * 1_000_000.0, // Approximate, but consistent with mb_per_sec
            "mb_per_sec": mb_per_sec
        },
        "processing": {
            "files_committed": state.stats.files_committed(),
            "bytes_total": state.stats.bytes_total(),
            "rate_files_per_sec": processing_rate,
            "throughput_mb_per_sec": processing_mb_per_sec,
            "last_completed_elapsed_seconds": state.stats.last_completed_processing_elapsed()
        },
        "scan_running": is_scanning,
        "processing_active": has_queued_items,
        "current_scan": scan_stats.map(|(files, rate, elapsed)| {
            // If scan is not running, use the completed rate to prevent decay
            let discovery_rate = if !is_scanning {
                state.stats.last_completed_scan_rate().unwrap_or(rate)
            } else {
                rate
            };
            let mut scan_data = serde_json::json!({
                "files_processed": files,
                // Back-compat for UIs that expect "discovered" naming
                "files_discovered": files,
                "files_per_sec": discovery_rate,
                "elapsed_seconds": elapsed
            });
            // Add photo/video counts if available
            if let Some((photos, videos)) = scan_breakdown {
                scan_data["photos_processed"] = serde_json::Value::Number(serde_json::Number::from(photos));
                scan_data["videos_processed"] = serde_json::Value::Number(serde_json::Number::from(videos));
            }
            scan_data
        }),
        "current_processing": processing_stats.map(|(files, rate, elapsed)| {
            serde_json::json!({
                "files_committed": files,
                "processing_rate_files_per_sec": rate,
                "elapsed_seconds": elapsed
            })
        }),
        "db": {"assets": db_count}
    });
    // Add Cache-Control header to allow short-term caching
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=5")
    );
    response
}

pub async fn file_types(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;

            // Get file type distribution with detailed breakdown for images and videos
            // Images: break down by specific MIME types (jpeg, png, webp, etc.)
            // Videos: break down by specific MIME types (mp4, mov, avi, etc.)
            // Other types: group together
            let mut stmt = conn.prepare(
                "SELECT
                    file_type,
                    COUNT(*) as count
                FROM (
                    SELECT
                        CASE
                            WHEN mime LIKE 'image/jpeg' OR mime LIKE 'image/jpg' THEN 'image/jpeg'
                            WHEN mime LIKE 'image/png' THEN 'image/png'
                            WHEN mime LIKE 'image/webp' THEN 'image/webp'
                            WHEN mime LIKE 'image/gif' THEN 'image/gif'
                            WHEN mime LIKE 'image/heic' OR mime LIKE 'image/heif' THEN 'image/heic'
                            WHEN mime LIKE 'image/raw' OR mime LIKE 'image/x-raw' OR mime LIKE 'image/dng' THEN 'image/raw'
                            WHEN mime LIKE 'image/%' THEN 'image/other'
                            WHEN mime LIKE 'video/mp4' THEN 'video/mp4'
                            WHEN mime LIKE 'video/quicktime' OR mime LIKE 'video/x-quicktime' THEN 'video/mov'
                            WHEN mime LIKE 'video/x-msvideo' OR mime LIKE 'video/avi' THEN 'video/avi'
                            WHEN mime LIKE 'video/x-matroska' OR mime LIKE 'video/mkv' THEN 'video/mkv'
                            WHEN mime LIKE 'video/webm' THEN 'video/webm'
                            WHEN mime LIKE 'video/%' THEN 'video/other'
                            WHEN mime LIKE 'audio/%' THEN 'audio'
                            ELSE 'other'
                        END as file_type
                    FROM assets
                )
                GROUP BY file_type
                ORDER BY count DESC"
            ).ok()?;

            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?
                ))
            }).ok()?;

            let mut distribution = std::collections::HashMap::new();
            for (file_type, count) in rows.flatten() {
                distribution.insert(file_type, count);
            }

            // Get detailed breakdown of "other" files if they exist
            // This includes standalone "other", "image/other", and "video/other"
            let mut other_extensions: Vec<String> = Vec::new();
            let mut other_breakdown: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
            let has_other = distribution.contains_key("other") ||
                           distribution.contains_key("image/other") ||
                           distribution.contains_key("video/other");

            if has_other {
                // Get extensions with counts for standalone "other" (non-image, non-video, non-audio)
                if distribution.contains_key("other") {
                    let mut ext_stmt = conn.prepare(
                        "SELECT ext, COUNT(*) as count
                        FROM assets
                        WHERE mime NOT LIKE 'image/%'
                          AND mime NOT LIKE 'video/%'
                          AND mime NOT LIKE 'audio/%'
                          AND ext IS NOT NULL
                          AND ext != ''
                        GROUP BY ext
                        ORDER BY count DESC, ext
                        LIMIT 20"
                    ).ok()?;

                    let ext_rows = ext_stmt.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?
                        ))
                    }).ok()?;

                    for (ext, count) in ext_rows.flatten() {
                        let trimmed = ext.trim();
                        if !trimmed.is_empty() {
                            let trimmed_str = trimmed.to_string();
                            if !other_extensions.contains(&trimmed_str) {
                                other_extensions.push(trimmed_str.clone());
                            }
                            *other_breakdown.entry(trimmed_str).or_insert(0) += count;
                        }
                    }
                }

                // Get extensions for "image/other" (unknown image types)
                if distribution.contains_key("image/other") {
                    let mut ext_stmt = conn.prepare(
                        "SELECT ext, COUNT(*) as count
                        FROM assets
                        WHERE mime LIKE 'image/%'
                          AND mime NOT LIKE 'image/jpeg'
                          AND mime NOT LIKE 'image/jpg'
                          AND mime NOT LIKE 'image/png'
                          AND mime NOT LIKE 'image/webp'
                          AND mime NOT LIKE 'image/gif'
                          AND mime NOT LIKE 'image/heic'
                          AND mime NOT LIKE 'image/heif'
                          AND mime NOT LIKE 'image/raw'
                          AND mime NOT LIKE 'image/x-raw'
                          AND mime NOT LIKE 'image/dng'
                          AND ext IS NOT NULL
                          AND ext != ''
                        GROUP BY ext
                        ORDER BY count DESC, ext
                        LIMIT 20"
                    ).ok()?;

                    let ext_rows = ext_stmt.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?
                        ))
                    }).ok()?;

                    for (ext, count) in ext_rows.flatten() {
                        let trimmed = ext.trim();
                        if !trimmed.is_empty() {
                            let trimmed_str = trimmed.to_string();
                            if !other_extensions.contains(&trimmed_str) {
                                other_extensions.push(trimmed_str.clone());
                            }
                            *other_breakdown.entry(trimmed_str).or_insert(0) += count;
                        }
                    }
                }

                // Get extensions for "video/other" (unknown video types)
                if distribution.contains_key("video/other") {
                    let mut ext_stmt = conn.prepare(
                        "SELECT ext, COUNT(*) as count
                        FROM assets
                        WHERE mime LIKE 'video/%'
                          AND mime NOT LIKE 'video/mp4'
                          AND mime NOT LIKE 'video/quicktime'
                          AND mime NOT LIKE 'video/x-quicktime'
                          AND mime NOT LIKE 'video/x-msvideo'
                          AND mime NOT LIKE 'video/avi'
                          AND mime NOT LIKE 'video/x-matroska'
                          AND mime NOT LIKE 'video/mkv'
                          AND mime NOT LIKE 'video/webm'
                          AND ext IS NOT NULL
                          AND ext != ''
                        GROUP BY ext
                        ORDER BY count DESC, ext
                        LIMIT 20"
                    ).ok()?;

                    let ext_rows = ext_stmt.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?
                        ))
                    }).ok()?;

                    for (ext, count) in ext_rows.flatten() {
                        let trimmed = ext.trim();
                        if !trimmed.is_empty() {
                            let trimmed_str = trimmed.to_string();
                            if !other_extensions.contains(&trimmed_str) {
                                other_extensions.push(trimmed_str.clone());
                            }
                            *other_breakdown.entry(trimmed_str).or_insert(0) += count;
                        }
                    }
                }
            }

            let mut response = serde_json::Map::new();
            for (k, v) in distribution {
                response.insert(k, serde_json::Value::Number(serde_json::Number::from(v)));
            }
            if !other_extensions.is_empty() {
                response.insert("other_extensions".to_string(), serde_json::json!(other_extensions));
                // Add breakdown of other files by extension with counts
                let mut other_breakdown_json = serde_json::Map::new();
                for (ext, count) in other_breakdown {
                    other_breakdown_json.insert(ext, serde_json::Value::Number(serde_json::Number::from(count)));
                }
                response.insert("other_breakdown".to_string(), serde_json::Value::Object(other_breakdown_json));
            }

            Some(serde_json::Value::Object(response))
        }
    }).await.ok().flatten();

    match result {
        Some(data) => (StatusCode::OK, Json(data)),
        None => (StatusCode::OK, Json(serde_json::json!({})))
    }
}
pub async fn clear_all_data(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Check if any path is currently scanning
    let any_scanning = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    if any_scanning {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Cannot clear data while scan is running"
        })));
    }

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || -> Result<(usize, usize, usize), anyhow::Error> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            db::writer::clear_all_data(&conn).map_err(|e| {
                tracing::error!("Failed to clear all data: {}", e);
                anyhow::anyhow!("Database error: {}", e)
            })
        }
    }).await;

    match result {
        Ok(Ok((assets_deleted, faces_deleted, persons_deleted))) => {
            // Also reset performance statistics when clearing all data
            state.stats.reset_stats();
            state.stats_cache.was_processing_active.store(false, std::sync::atomic::Ordering::Relaxed);
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "assets_deleted": assets_deleted,
                "faces_deleted": faces_deleted,
                "persons_deleted": persons_deleted,
                "message": "All data cleared"
            })))
        }
        Ok(Err(e)) => {
            let error_msg = e.to_string();
            tracing::error!("Database error during clear_all_data: {}", error_msg);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", error_msg)
            })))
        }
        Err(e) => {
            let error_msg = e.to_string();
            tracing::error!("Task error during clear_all_data: {}", error_msg);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Task error: {}", error_msg)
            })))
        }
    }
}

pub async fn reset_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Check if any path is currently scanning
    let any_scanning = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    if any_scanning {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Cannot reset stats while scan is running"
        })));
    }

    state.stats.reset_stats();
    // Also reset the processing activity tracking flag
    state.stats_cache.was_processing_active.store(false, std::sync::atomic::Ordering::Relaxed);

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "message": "Performance statistics reset"
    })))
}

#[derive(Deserialize)]
pub struct ListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    sort: Option<String>,
    order: Option<String>,
    #[cfg(feature = "facial-recognition")]
    person_id: Option<i64>,
}

pub async fn assets(State(state): State<Arc<AppState>>, Query(q): Query<ListQuery>) -> impl IntoResponse {
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(200);
    let sort = q.sort.unwrap_or_else(|| "none".to_string());
    let order = q.order.unwrap_or_else(|| "desc".to_string());
    #[cfg(feature = "facial-recognition")]
    let person_id = q.person_id;
    let pool = state.pool.clone();
    let res = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        #[cfg(feature = "facial-recognition")]
        {
            if let Some(pid) = person_id {
                crate::db::query::list_assets_by_person(&conn, pid, offset, limit, &sort, &order).map_err(|e| anyhow::anyhow!(e.to_string()))
            } else {
                crate::db::query::list_assets(&conn, offset, limit, &sort, &order).map_err(|e| anyhow::anyhow!(e.to_string()))
            }
        }
        #[cfg(not(feature = "facial-recognition"))]
        {
            crate::db::query::list_assets(&conn, offset, limit, &sort, &order).map_err(|e| anyhow::anyhow!(e.to_string()))
        }
    }).await;
    match res { Ok(Ok(p)) => (StatusCode::OK, Json(p)).into_response(), _ => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

#[derive(Deserialize)]
pub struct SearchQuery { q: String, from: Option<i64>, to: Option<i64>, camera_make: Option<String>, camera_model: Option<String>, platform_type: Option<String>, offset: Option<i64>, limit: Option<i64> }

pub async fn assets_search(State(state): State<Arc<AppState>>, Query(qs): Query<SearchQuery>) -> impl IntoResponse {
    let offset = qs.offset.unwrap_or(0);
    let limit = qs.limit.unwrap_or(200);
    let pool = state.pool.clone();
    let res = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let search_params = crate::db::query::SearchParams {
            q: &qs.q,
            from: qs.from,
            to: qs.to,
            camera_make: qs.camera_make.as_deref(),
            camera_model: qs.camera_model.as_deref(),
            platform_type: qs.platform_type.as_deref(),
            offset,
            limit,
        };
        crate::db::query::search_assets(&conn, &search_params).map_err(|e| anyhow::anyhow!(e.to_string()))
    }).await;
    match res { Ok(Ok(p)) => (StatusCode::OK, Json(p)).into_response(), _ => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

pub async fn thumb_256(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let derived_dir = state.paths.data.join("derived");
    // No longer need scan_running check for thumbnails - per-path scans don't block thumbnails
    serve_derived(state.clone(), id, derived_dir, None, 256).await
}

pub async fn preview_1600(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let derived_dir = state.paths.data.join("derived");
    // No longer need scan_running check for previews - per-path scans don't block previews
    serve_derived(state.clone(), id, derived_dir, None, 1600).await
}

pub async fn get_asset(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let pool = state.pool.clone();
    let res = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        crate::db::query::get_asset_by_id(&conn, id).map_err(|e| anyhow::anyhow!(e.to_string()))
    }).await;
    match res {
        Ok(Ok(Some(asset))) => (StatusCode::OK, Json(asset)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn serve_derived(state: Arc<AppState>, id: i64, derived_dir: std::path::PathBuf, _flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>, size: i32) -> impl IntoResponse {
    let info = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || { let conn = pool.get().ok(); conn.and_then(|c| crate::db::query::get_thumb_info(&c, id).ok()) }
    }).await.ok().flatten();
    if let Some((Some(sha_hex), _mime)) = info {
        if sha_hex.len() >= 2 {
            let sub = &sha_hex[0..2];
            let path = derived_dir.join(sub).join(format!("{}-{}.webp", sha_hex, size));
            if let Ok(bytes) = tokio::fs::read(&path).await {
                let mut resp = axum::http::Response::builder().status(StatusCode::OK);
                let headers = resp.headers_mut().unwrap();
                headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("image/webp"));
                headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("public, max-age=31536000, immutable"));
                return resp.body(axum::body::Body::from(bytes)).unwrap();
            }
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

pub async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut text = state.stats.metrics_text();
    let d = state.gauges.depths();
    text.push_str(&format!("seen_queue_discover {}\n", d.discover));
    text.push_str(&format!("seen_queue_hash {}\n", d.hash));
    text.push_str(&format!("seen_queue_metadata {}\n", d.metadata));
    text.push_str(&format!("seen_queue_db_write {}\n", d.db_write));
    text.push_str(&format!("seen_queue_thumb {}\n", d.thumb));
    axum::http::Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, "text/plain; version=0.0.4").body(axum::body::Body::from(text)).unwrap()
}

pub async fn performance(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let stats = &state.stats;
    let scan_stats = stats.scan_stats();

    // Check if processing is actually active (queues have items or any path is scanning)
    let queue_depths = state.gauges.depths();
    let is_scanning = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    let has_queued_items = queue_depths.discover > 0 || queue_depths.hash > 0 ||
                           queue_depths.metadata > 0 || queue_depths.db_write > 0 ||
                           queue_depths.thumb > 0;
    let is_active = is_scanning || has_queued_items;

    // Use last completed scan rate when idle to prevent decay
    let files_per_sec = if is_active {
        stats.files_per_sec()
    } else {
        stats.last_completed_scan_rate().unwrap_or_else(|| stats.files_per_sec())
    };

    let mb_per_sec = if is_active {
        stats.bytes_per_sec() / 1_000_000.0
    } else {
        stats.last_completed_scan_mb_per_sec().unwrap_or_else(|| stats.bytes_per_sec() / 1_000_000.0)
    };

    // Use current scan rate if available, otherwise overall rate
    // Current scan rate is more meaningful for status
    // If idle (no activity for >5 seconds), use last completed rate instead of continuously decreasing rate
    let current_rate = if is_active {
        scan_stats.map(|(_, rate, _)| rate).unwrap_or(files_per_sec)
    } else {
        // If not active, use last completed scan rate, otherwise show 0
        stats.last_completed_scan_rate().unwrap_or(0.0)
    };

    // Detect system capabilities
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(4.0);

    // Get CPU brand/model information
    let cpu_brand = {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_cpu();
        let brand = sys.cpus().first()
            .map(|cpu| cpu.brand().to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        brand
    };

    // Get GPU acceleration info
    let gpu_config = crate::utils::ffmpeg::get_gpu_config();
    let gpu_stats = crate::utils::ffmpeg::get_gpu_stats();
    let accel_str = match gpu_config.accel {
        crate::utils::ffmpeg::GpuAccel::Cuda => "CUDA",
        crate::utils::ffmpeg::GpuAccel::Qsv => "QSV",
        crate::utils::ffmpeg::GpuAccel::D3d11va => "D3D11VA",
        crate::utils::ffmpeg::GpuAccel::VideoToolbox => "VideoToolbox",
        crate::utils::ffmpeg::GpuAccel::Cpu => "CPU",
    };

    // Calculate status based on current rate and activity state
    let status = if !is_active {
        "idle"  // No active processing
    } else if current_rate > 50.0 {
        "excellent"
    } else if current_rate > 20.0 {
        "good"
    } else if current_rate > 10.0 {
        "average"
    } else if current_rate > 0.1 {
        "slow"
    } else {
        "idle"  // Very low or zero rate means idle
    };

    let comparison = serde_json::json!({
        "seen": {
            "files_per_sec": files_per_sec,  // Overall lifetime average
            "current_rate": current_rate,     // Current/active rate (0.0 if idle)
            "mb_per_sec": mb_per_sec,
            "status": status,
            "is_active": is_active  // Whether processing is currently active
        },
        "system_info": {
            "cpu_cores": cpu_cores as u32,
            "cpu_brand": cpu_brand,
            "accel": accel_str
        },
        "gpu_usage": {
            "enabled": gpu_config.enabled && !gpu_stats.auto_disabled,
            "accel": accel_str,
            "jobs_gpu": gpu_stats.jobs_gpu,
            "jobs_cpu": gpu_stats.jobs_cpu,
            "consecutive_failures": gpu_stats.consecutive_failures,
            "auto_disabled": gpu_stats.auto_disabled,
        },
        "current_scan": scan_stats.map(|(files, rate, elapsed)| serde_json::json!({
            "files_processed": files,
            "files_per_sec": rate,
            "elapsed_seconds": elapsed,
            "status": if rate > 50.0 { "excellent" } else if rate > 20.0 { "good" } else if rate > 10.0 { "average" } else { "slow" }
        })),
        // Use current scan rate for status if available, otherwise overall rate
        "current_rate": scan_stats.map(|(_, rate, _)| rate).unwrap_or(files_per_sec),
        "notes": [
            "Performance varies significantly based on:",
            "- File sizes (larger files = slower processing)",
            "- Storage type (SSD vs HDD)",
            "- CPU cores and speed",
            "- Whether thumbnails are being generated",
            "- Network latency (if files are on network storage)"
        ]
    });

    (StatusCode::OK, Json(comparison))
}

#[derive(Deserialize)]
pub struct AddPathReq {
    path: String,
}

pub async fn get_scan_paths(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let default_root = state.paths.root.to_string_lossy().to_string();
    let default_root_host = state.paths.root_host.clone();
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::query::get_scan_paths(&conn).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(paths) => {
            // Return only the configured paths, flagging the default root when present
            let response: Vec<serde_json::Value> = paths.iter().map(|path| {
                let is_default = path == &default_root;
                let host_path = if is_default {
                    default_root_host.clone()
                } else {
                    None
                };
                serde_json::json!({
                    "path": path,
                    "is_default": is_default,
                    "host_path": host_path
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!(response)))
        },
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

pub async fn add_scan_path(State(state): State<Arc<AppState>>, Json(req): Json<AddPathReq>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;

    let decoded_path = req.path.clone();
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let path = decoded_path.clone();
        move || {
            let conn = pool.get().ok()?;
            db::writer::add_scan_path(&conn, &path).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(_) => {
            // Get or create per-path watcher_paused flag
            let path_watcher_paused = {
                let mut map = state.path_watcher_paused.lock();
                map.entry(decoded_path.clone())
                    .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
                    .clone()
            };
            // Ensure watcher is marked as active
            path_watcher_paused.store(false, Ordering::SeqCst);

            // Start watcher if not already running
            {
                let mut watchers = state.path_watchers.lock();
                if !watchers.contains_key(&decoded_path) {
                    let root = std::path::PathBuf::from(&decoded_path);
                    let dtx = state.queues.discover_tx.clone();
                    let g = state.gauges.clone();
                    let db_path = state.db_path.clone();
                    let stats = state.stats.clone();
                    let paused = path_watcher_paused.clone();

                    let handle = tokio::spawn(async move {
                        let _ = crate::pipeline::discover::watch(root, dtx, Some(db_path), g, Some(stats), Some(paused)).await;
                    });
                    watchers.insert(decoded_path.clone(), handle);
                }
            }

            // Determine if this is the first active scan (used to start scan stats)
            let was_scanning = {
                let map = state.path_scan_running.lock();
                map.values().any(|flag| flag.load(Ordering::Relaxed))
            };

            // Get or create per-path scan_running flag
            let path_scan_running = {
                let mut map = state.path_scan_running.lock();
                map.entry(decoded_path.clone())
                    .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
                    .clone()
            };

            // Check if already scanning (shouldn't happen for new path, but check anyway)
            if path_scan_running.swap(true, Ordering::SeqCst) {
                // Path is already being scanned - this shouldn't happen for a newly added path
                // but handle gracefully
                return (StatusCode::CONFLICT, Json(serde_json::json!({
                    "error": "Path is already being scanned"
                })));
            }

            // If no other scans were running, start global scan stats
            if !was_scanning {
                state.stats.start_scan();
            }
            state.scan_running.store(true, Ordering::SeqCst);

            // Start scan for this path
            let tx = state.queues.discover_tx.clone();
            let gauges = state.gauges.clone();
            let scan_running = path_scan_running.clone();
            let stats = state.stats.clone();
            let path_scan_map = state.path_scan_running.clone();
            let global_scan_flag = state.scan_running.clone();
            let path_for_scan = decoded_path.clone();

            tokio::spawn(async move {
                info!("scan_start for path: {:?}", path_for_scan);
                let root = std::path::PathBuf::from(&path_for_scan);
                let _ = crate::pipeline::discover::scan_bfs(root, tx, gauges, scan_running.clone(), Some(stats.clone())).await;
                info!("scan_finish for path: {:?}", path_for_scan);
                scan_running.store(false, Ordering::SeqCst);

                // If no scans remain active, finalize statistics
                let any_active = path_scan_map.lock()
                    .values()
                    .any(|flag| flag.load(Ordering::Relaxed));
                if !any_active {
                    stats.finish_processing();
                    stats.finish_scan();
                    global_scan_flag.store(false, Ordering::SeqCst);
                } else {
                    global_scan_flag.store(true, Ordering::SeqCst);
                }
            });

            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "message": "Path added successfully"
            })))
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

#[derive(Deserialize)]
pub struct RemovePathQuery {
    path: String,
}

pub async fn remove_scan_path(State(state): State<Arc<AppState>>, Query(params): Query<RemovePathQuery>) -> impl IntoResponse {
    let path_to_remove = params.path.clone();

    // Stop scanning and pause watcher for this path
    {
        if let Some(scan_running) = state.path_scan_running.lock().get(&path_to_remove) {
            scan_running.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        if let Some(watcher_paused) = state.path_watcher_paused.lock().get(&path_to_remove) {
            watcher_paused.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    // Abort and remove watcher task
    {
        let mut watchers = state.path_watchers.lock();
        if let Some(handle) = watchers.remove(&path_to_remove) {
            handle.abort();
        }
    }

    // Clean up state maps
    {
        state.path_scan_running.lock().remove(&path_to_remove);
        state.path_watcher_paused.lock().remove(&path_to_remove);
    }

    // Recompute global scan flag
    let any_active = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    state.scan_running.store(any_active, std::sync::atomic::Ordering::SeqCst);

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let path_to_remove_db = path_to_remove.clone();
        move || -> Result<(bool, usize, usize), anyhow::Error> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

            // First delete all assets from this path
            let (assets_deleted, faces_deleted) = db::writer::delete_assets_by_path_prefix(&conn, &path_to_remove_db)?;

            // Then remove the path from scan_paths
            let path_removed = db::writer::remove_scan_path(&conn, &path_to_remove_db)?;

            Ok((path_removed, assets_deleted, faces_deleted))
        }
    }).await;

    match result {
        Ok(Ok((path_removed, assets_deleted, faces_deleted))) => {
            // Decrement files_committed to reflect deleted assets
            if assets_deleted > 0 {
                state.stats.dec_files_committed(assets_deleted as u64);
            }

            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "path_removed": path_removed,
                "assets_deleted": assets_deleted,
                "faces_deleted": faces_deleted,
                "message": format!("Path removed. {} assets and {} faces deleted.", assets_deleted, faces_deleted)
            })))
        }
        Ok(Err(e)) => {
            tracing::error!("Error removing path: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Database error: {}", e)})))
        }
        Err(e) => {
            tracing::error!("Task error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Task error"})))
        }
    }
}

#[derive(Deserialize)]
pub struct PathActionReq {
    path: String,
}

pub async fn scan_path(State(state): State<Arc<AppState>>, Json(req): Json<PathActionReq>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;

    let decoded_path = req.path;
    let default_root = state.paths.root.to_string_lossy().to_string();
    let is_default_path = decoded_path == default_root;

    // Check if path exists in scan_paths table (skip check for default root path)
    let path_exists = if is_default_path {
        true
    } else {
        tokio::task::spawn_blocking({
            let pool = state.pool.clone();
            let path_check = decoded_path.clone();
            move || {
                let conn = pool.get().ok()?;
                let mut stmt = conn.prepare("SELECT 1 FROM scan_paths WHERE path = ?1").ok()?;
                let exists = stmt.exists(params![path_check]).ok()?;
                Some(exists)
            }
        }).await.ok().flatten().unwrap_or(false)
    };

    if !path_exists {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Path not found in scan paths"
        })));
    }

    // Determine if this is the first active scan (used to start scan stats)
    let was_scanning = {
        let map = state.path_scan_running.lock();
        map.values().any(|flag| flag.load(Ordering::Relaxed))
    };

    // Get or create per-path scan_running flag
    let path_scan_running = {
        let mut map = state.path_scan_running.lock();
        map.entry(decoded_path.clone())
            .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .clone()
    };

    // Check if already scanning
    if path_scan_running.swap(true, Ordering::SeqCst) {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Path is already being scanned"
        })));
    }

    // Get or create per-path watcher_paused flag
    let path_watcher_paused = {
        let mut map = state.path_watcher_paused.lock();
        map.entry(decoded_path.clone())
            .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .clone()
    };
    // Ensure watcher is marked as active when starting/resuming scan
    path_watcher_paused.store(false, Ordering::SeqCst);

    // Start watcher if not already running
    {
        let mut watchers = state.path_watchers.lock();
        if !watchers.contains_key(&decoded_path) {
            let root = std::path::PathBuf::from(&decoded_path);
            let dtx = state.queues.discover_tx.clone();
            let g = state.gauges.clone();
            let db_path = state.db_path.clone();
            let stats = state.stats.clone();
            let paused = path_watcher_paused.clone();

            let handle = tokio::spawn(async move {
                let _ = crate::pipeline::discover::watch(root, dtx, Some(db_path), g, Some(stats), Some(paused)).await;
            });
            watchers.insert(decoded_path.clone(), handle);
        }
    }

    // If no other scans were running, start global scan stats
    if !was_scanning {
        state.stats.start_scan();
    }
    state.scan_running.store(true, Ordering::SeqCst);

    // Start scan for this path
    let tx = state.queues.discover_tx.clone();
    let gauges = state.gauges.clone();
    let scan_running = path_scan_running.clone();
    let stats = state.stats.clone();
    let path_scan_map = state.path_scan_running.clone();
    let global_scan_flag = state.scan_running.clone();
    let path_for_scan = decoded_path.clone();

    tokio::spawn(async move {
        info!("scan_start for path: {:?}", path_for_scan);
        let root = std::path::PathBuf::from(&path_for_scan);
        let _ = crate::pipeline::discover::scan_bfs(root, tx, gauges, scan_running.clone(), Some(stats.clone())).await;
        info!("scan_finish for path: {:?}", path_for_scan);
        scan_running.store(false, Ordering::SeqCst);

        // If no scans remain active, finalize statistics
        let any_active = path_scan_map.lock()
            .values()
            .any(|flag| flag.load(Ordering::Relaxed));
        if !any_active {
            stats.finish_processing();
            stats.finish_scan();
            global_scan_flag.store(false, Ordering::SeqCst);
        } else {
            global_scan_flag.store(true, Ordering::SeqCst);
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({
        "success": true,
        "message": "Scan started for path"
    })))
}

pub async fn pause_path(State(state): State<Arc<AppState>>, Json(req): Json<PathActionReq>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;

    let decoded_path = req.path;

    // Stop scanning for this path
    if let Some(scan_running) = state.path_scan_running.lock().get(&decoded_path) {
        scan_running.store(false, Ordering::SeqCst);
    }

    // Pause watcher for this path
    let watcher_paused = {
        let mut map = state.path_watcher_paused.lock();
        map.entry(decoded_path.clone())
            .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .clone()
    };
    watcher_paused.store(true, Ordering::SeqCst);

    // Recompute global scan flag
    let any_active = state.path_scan_running.lock()
        .values()
        .any(|flag| flag.load(Ordering::Relaxed));
    state.scan_running.store(any_active, Ordering::SeqCst);

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "message": "Path paused"
    })))
}

pub async fn resume_path(State(state): State<Arc<AppState>>, Json(req): Json<PathActionReq>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;

    let decoded_path = req.path;

    // Resume watcher for this path
    let watcher_paused = {
        let mut map = state.path_watcher_paused.lock();
        map.entry(decoded_path.clone())
            .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .clone()
    };
    watcher_paused.store(false, Ordering::SeqCst);

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "message": "Path resumed"
    })))
}

pub async fn get_path_status(State(state): State<Arc<AppState>>, Query(params): Query<PathActionReq>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;

    let decoded_path = params.path;

    let scanning = state.path_scan_running.lock()
        .get(&decoded_path)
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false);

    let watcher_paused = state.path_watcher_paused.lock()
        .get(&decoded_path)
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false);

    let watching = state.path_watchers.lock().contains_key(&decoded_path);

    (StatusCode::OK, Json(serde_json::json!({
        "scanning": scanning,
        "watcher_paused": watcher_paused,
        "watching": watching
    })))
}

pub async fn diag_ffmpeg() -> impl IntoResponse {
    use std::process::Command;

    let mut info = serde_json::json!({
        "ffmpeg_version": "unknown",
        "hwaccels": [],
        "filters": [],
        "gpu_config": {}
    });

    // Get ffmpeg version
    if let Ok(output) = Command::new("ffmpeg").args(["-version"]).output() {
        if output.status.success() {
            let version_str = String::from_utf8_lossy(&output.stdout);
            let first_line = version_str.lines().next().unwrap_or("unknown");
            info["ffmpeg_version"] = serde_json::Value::String(first_line.to_string());
        }
    }

    // Get available hardware accelerators
    if let Ok(output) = Command::new("ffmpeg").args(["-hide_banner", "-hwaccels"]).output() {
        if output.status.success() {
            let hwaccels_str = String::from_utf8_lossy(&output.stdout);
            let accels: Vec<&str> = hwaccels_str
                .lines()
                .skip(1) // Skip header line
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.trim())
                .collect();
            info["hwaccels"] = serde_json::Value::Array(
                accels.iter().map(|a| serde_json::Value::String(a.to_string())).collect()
            );
        }
    }

    // Get available filters (check for GPU scaling filters)
    if let Ok(output) = Command::new("ffmpeg").args(["-hide_banner", "-filters"]).output() {
        if output.status.success() {
            let filters_str = String::from_utf8_lossy(&output.stdout);
            let gpu_filters = ["scale_cuda", "scale_npp", "scale_qsv"];
            let found: Vec<String> = gpu_filters
                .iter()
                .filter(|f| filters_str.contains(*f))
                .map(|f| f.to_string())
                .collect();
            info["filters"] = serde_json::Value::Array(
                found.iter().map(|f| serde_json::Value::String(f.clone())).collect()
            );
        }
    }

    // Get current GPU config
    let gpu_config = crate::utils::ffmpeg::get_gpu_config();
    let accel_str = match gpu_config.accel {
        crate::utils::ffmpeg::GpuAccel::Cuda => "CUDA",
        crate::utils::ffmpeg::GpuAccel::Qsv => "QSV",
        crate::utils::ffmpeg::GpuAccel::D3d11va => "D3D11VA",
        crate::utils::ffmpeg::GpuAccel::VideoToolbox => "VideoToolbox",
        crate::utils::ffmpeg::GpuAccel::Cpu => "CPU",
    };
    let gpu_stats = crate::utils::ffmpeg::get_gpu_stats();

    // Get device counts for diagnostics
    let cuda_devices = crate::utils::ffmpeg::check_cuda_devices();
    let intel_gpu = crate::utils::ffmpeg::check_intel_gpu_devices();
    let opencl_devices = crate::utils::ffmpeg::check_opencl_devices();

    info["gpu_config"] = serde_json::json!({
        "accel": accel_str,
        "enabled": gpu_config.enabled && !gpu_stats.auto_disabled,
        "consecutive_failures": gpu_stats.consecutive_failures,
        "auto_disabled": gpu_stats.auto_disabled,
        "device_counts": {
            "cuda": cuda_devices,
            "intel_gpu": intel_gpu,
            "opencl": opencl_devices,
        },
    });

    (StatusCode::OK, Json(info))
}

pub async fn stream_video(State(state): State<Arc<AppState>>, Path(id): Path<i64>, headers: HeaderMap) -> impl IntoResponse {
    // Get asset path, MIME type, and codec from database
    let (file_path, mime_str, video_codec) = match tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            let asset = crate::db::query::get_asset_by_id(&conn, id).ok()??;
            // Use MIME type from database (more accurate than guessing from path)
            let mime_str = if !asset.mime.is_empty() {
                asset.mime.clone()
            } else {
                // Fallback to guessing from path if database MIME is empty
                mime_guess::from_path(&asset.path).first_or_octet_stream().to_string()
            };
            Some((std::path::PathBuf::from(asset.path), mime_str, asset.video_codec.clone()))
        }
    }).await.ok().flatten() {
        Some((path, mime_str, codec)) => (path, mime_str, codec),
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let derived_dir = state.paths.data.join("derived");

    // Determine which file to serve (original or transcoded)
    // MIME-based compatibility first, then refine for MP4 based on stored codec.
    let mut browser_compatible = is_browser_compatible_video(&mime_str);

    if mime_str == "video/mp4" {
        // HEVC transcode behavior can be controlled via env:
        // SEEN_HEVC_TRANSCODE = "auto" (default) | "never" | "always"
        let hevc_mode = std::env::var("SEEN_HEVC_TRANSCODE")
            .unwrap_or_else(|_| "auto".to_string())
            .to_lowercase();

        match hevc_mode.as_str() {
            "never" | "off" | "false" => {
                // Always treat MP4 as browser-compatible, even if HEVC.
                browser_compatible = true;
            }
            "always" | "force" => {
                // Always transcode MP4, regardless of codec.
                browser_compatible = false;
            }
            _ => {
                // auto mode: only force transcode for HEVC/H.265 when codec is known.
                if let Some(codec) = video_codec.as_deref() {
                    let codec_lower = codec.to_lowercase();
                    if codec_lower.contains("hevc") || codec_lower.contains("h265") {
                        browser_compatible = false;
                    }
                }
            }
        }
    }

    let (video_path, content_mime) = if browser_compatible {
        // Browser-compatible format - serve original
        (file_path, mime_str)
    } else {
        // Need transcoding - get SHA256 and check for cached transcoded version
        let sha256 = match tokio::task::spawn_blocking({
            let pool = state.pool.clone();
            move || {
                let conn = pool.get().ok()?;
                crate::db::query::get_asset_sha256(&conn, id).ok()?
            }
        }).await.ok().flatten() {
            Some(sha) if !sha.is_empty() => sha,
            _ => {
                tracing::warn!("Cannot transcode video {}: SHA256 not available", id);
                // Fallback to original (will likely fail in browser, but file is available for download)
                return serve_video_file(&file_path, &mime_str, &headers).await.into_response();
            }
        };

        let transcoded_path = get_transcoded_video_path(&derived_dir, &sha256);

        // Check if transcoded version exists (could be MP4 or WebM)
        let transcoded_mp4 = transcoded_path.clone();
        let transcoded_webm = transcoded_path.with_extension("webm");

        // Check for cached versions first
        if tokio::fs::metadata(&transcoded_mp4).await.is_ok() {
            // Use cached MP4 version
            (transcoded_mp4, "video/mp4".to_string())
        } else if tokio::fs::metadata(&transcoded_webm).await.is_ok() {
            // Use cached WebM version
            (transcoded_webm, "video/webm".to_string())
        } else {
            // Need to transcode
            tracing::info!("Transcoding video {} ({} -> MP4)", id, mime_str);
            match transcode_video_to_mp4(&file_path, &transcoded_path).await {
                Ok(_) => {
                    // Verify the transcoded file exists, is readable, and has content
                    match tokio::fs::metadata(&transcoded_path).await {
                        Ok(meta) if meta.is_file() && meta.len() > 0 => {
                            tracing::info!("Transcoded file verified: {} ({} bytes)", transcoded_path.display(), meta.len());
                            (transcoded_path, "video/mp4".to_string())
                        }
                        Ok(meta) => {
                            tracing::error!("Transcoded file exists but is invalid: {} (is_file: {}, size: {})",
                                transcoded_path.display(), meta.is_file(), meta.len());
                            // Fallback to original (will likely fail in browser, but file is available for download)
                            return serve_video_file(&file_path, &mime_str, &headers).await.into_response();
                        }
                        Err(e) => {
                            tracing::error!("Transcoding completed but file not found: {} - {}", transcoded_path.display(), e);
                            // Fallback to original (will likely fail in browser, but file is available for download)
                            return serve_video_file(&file_path, &mime_str, &headers).await.into_response();
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to transcode video {}: {}", id, e);
                    // Try CPU encoding as fallback if GPU encoding failed
                    tracing::info!("Attempting CPU fallback transcoding for video {}", id);
                    match transcode_video_to_mp4_cpu(&file_path, &transcoded_path).await {
                        Ok(_) => {
                            // Check which format was created (MP4 or WebM)
                            let transcoded_mp4_check = transcoded_path.clone();
                            let transcoded_webm_check = transcoded_path.with_extension("webm");
                            if let Ok(meta) = tokio::fs::metadata(&transcoded_mp4_check).await {
                                if meta.is_file() && meta.len() > 0 {
                                    tracing::info!("CPU transcoding succeeded: {} ({} bytes)", transcoded_mp4_check.display(), meta.len());
                                    (transcoded_mp4_check, "video/mp4".to_string())
                                } else {
                                    tracing::error!("CPU transcoding completed but file is invalid");
                                    return (StatusCode::INTERNAL_SERVER_ERROR, "Video transcoding failed").into_response();
                                }
                            } else if let Ok(meta) = tokio::fs::metadata(&transcoded_webm_check).await {
                                if meta.is_file() && meta.len() > 0 {
                                    tracing::info!("CPU transcoding succeeded (WebM): {} ({} bytes)", transcoded_webm_check.display(), meta.len());
                                    (transcoded_webm_check, "video/webm".to_string())
                                } else {
                                    tracing::error!("CPU transcoding completed but file is invalid");
                                    return (StatusCode::INTERNAL_SERVER_ERROR, "Video transcoding failed").into_response();
                                }
                            } else {
                                tracing::error!("CPU transcoding completed but no output file found");
                                return (StatusCode::INTERNAL_SERVER_ERROR, "Video transcoding failed - file not found").into_response();
                            }
                        }
                        Err(e2) => {
                            tracing::error!("CPU fallback transcoding also failed: {}", e2);
                            return (StatusCode::INTERNAL_SERVER_ERROR, "Video transcoding failed").into_response();
                        }
                    }
                }
            }
        }
    };

    // Serve the video file (original or transcoded)
    serve_video_file(&video_path, &content_mime, &headers).await.into_response()
}

async fn serve_video_file(file_path: &std::path::Path, mime_str: &str, headers: &HeaderMap) -> impl IntoResponse {
    // Verify file exists before attempting to serve
    let metadata = match tokio::fs::metadata(file_path).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Video file not found or not accessible: {} - {}", file_path.display(), e);
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    if metadata.is_file() {
        let file_size = metadata.len();

        // Check for Range header
        if let Some(range_header) = headers.get(header::RANGE) {
            if let Ok(range_str) = range_header.to_str() {
                // Parse Range header (e.g., "bytes=0-1023" or "bytes=1024-")
                if let Some(range) = parse_range(range_str, file_size) {
                    let (start, end) = range;
                    let content_length = end - start + 1;

                    // Read the requested byte range
                    if let Ok(mut file) = tokio::fs::File::open(file_path).await {
                        use tokio::io::{AsyncSeekExt, AsyncReadExt};
                        if file.seek(std::io::SeekFrom::Start(start)).await.is_ok() {
                            let mut buffer = vec![0u8; content_length as usize];
                            if file.read_exact(&mut buffer).await.is_ok() {
                                let mut resp = axum::http::Response::builder()
                                    .status(StatusCode::PARTIAL_CONTENT);
                                let resp_headers = resp.headers_mut().unwrap();
                                resp_headers.insert(
                                    header::CONTENT_TYPE,
                                    header::HeaderValue::from_str(mime_str)
                                        .unwrap_or_else(|_| header::HeaderValue::from_static("video/mp4"))
                                );
                                resp_headers.insert(
                                    header::CONTENT_LENGTH,
                                    header::HeaderValue::from(content_length)
                                );
                                resp_headers.insert(
                                    header::CONTENT_RANGE,
                                    header::HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, file_size))
                                        .unwrap_or_else(|_| header::HeaderValue::from_static("bytes */*"))
                                );
                                resp_headers.insert(
                                    header::ACCEPT_RANGES,
                                    header::HeaderValue::from_static("bytes")
                                );
                                // Add CORS headers for video streaming
                                resp_headers.insert(
                                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                                    header::HeaderValue::from_static("*")
                                );
                                return resp.body(axum::body::Body::from(buffer)).unwrap();
                            }
                        }
                    }
                }
            }
        }

        // No range request or invalid range - serve entire file
        if let Ok(bytes) = tokio::fs::read(file_path).await {
            let mut resp = axum::http::Response::builder().status(StatusCode::OK);
            let resp_headers = resp.headers_mut().unwrap();
            resp_headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(mime_str)
                    .unwrap_or_else(|_| header::HeaderValue::from_static("video/mp4"))
            );
            resp_headers.insert(
                header::CONTENT_LENGTH,
                header::HeaderValue::from(file_size)
            );
            resp_headers.insert(
                header::ACCEPT_RANGES,
                header::HeaderValue::from_static("bytes")
            );
            // Add CORS headers for video streaming
            resp_headers.insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                header::HeaderValue::from_static("*")
            );
            return resp.body(axum::body::Body::from(bytes)).unwrap();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

fn is_browser_compatible_video(mime: &str) -> bool {
    // Browser-compatible formats that don't need transcoding
    matches!(
        mime,
        "video/mp4" | "video/webm" | "video/ogg" | "video/ogv"
    )
}

fn get_transcoded_video_path(derived_dir: &std::path::Path, sha256: &str) -> std::path::PathBuf {
    if sha256.len() >= 2 {
        let sub = &sha256[0..2];
        derived_dir.join(sub).join(format!("{}-transcoded.mp4", sha256))
    } else {
        derived_dir.join(format!("{}-transcoded.mp4", sha256))
    }
}

async fn transcode_video_to_mp4(src_path: &std::path::Path, dst_path: &std::path::Path) -> Result<(), anyhow::Error> {
    use std::time::Duration;

    // Ensure parent directory exists
    if let Some(parent) = dst_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Get GPU config for potential acceleration
    let gpu_config = crate::utils::ffmpeg::get_gpu_config();
    // Respect auto-disabled GPU flag: if disabled, fall back to CPU.
    let accel = if gpu_config.enabled {
        gpu_config.accel.clone()
    } else {
        crate::utils::ffmpeg::GpuAccel::Cpu
    };

    // Build FFmpeg args based on GPU availability
    let mut args = Vec::new();

    // Overwrite output file if it exists
    args.push("-y".to_string());

    // Add GPU acceleration settings (must come before input file)
    match accel {
        crate::utils::ffmpeg::GpuAccel::Cuda => {
            // Use CUDA for hardware-accelerated decoding
            args.push("-hwaccel".to_string());
            args.push("cuda".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::Qsv => {
            args.push("-hwaccel".to_string());
            args.push("qsv".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::D3d11va => {
            args.push("-hwaccel".to_string());
            args.push("d3d11va".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::VideoToolbox => {
            args.push("-hwaccel".to_string());
            args.push("videotoolbox".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::Cpu => {
            // No hardware acceleration
        }
    }

    // Add input file
    args.push("-i".to_string());
    args.push(src_path.to_string_lossy().to_string());

    // Add encoding settings (after input file)
    match accel {
        crate::utils::ffmpeg::GpuAccel::Cuda => {
            args.push("-c:v".to_string());
            args.push("h264_nvenc".to_string());
            args.push("-preset".to_string());
            args.push("p4".to_string()); // NVENC preset (p4 = medium quality, good speed)
            args.push("-cq".to_string());
            args.push("23".to_string()); // Constant quality (similar to CRF)
        }
        crate::utils::ffmpeg::GpuAccel::Qsv => {
            args.push("-c:v".to_string());
            args.push("h264_qsv".to_string());
            args.push("-preset".to_string());
            args.push("medium".to_string());
            args.push("-global_quality".to_string());
            args.push("23".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::D3d11va => {
            // D3D11VA for decode, try NVENC for encode (fallback to CPU handled by FFmpeg)
            args.push("-c:v".to_string());
            args.push("h264_nvenc".to_string());
            args.push("-preset".to_string());
            args.push("p4".to_string());
            args.push("-cq".to_string());
            args.push("23".to_string());
        }
        crate::utils::ffmpeg::GpuAccel::VideoToolbox => {
            args.push("-c:v".to_string());
            args.push("h264_videotoolbox".to_string());
            args.push("-b:v".to_string());
            args.push("5M".to_string()); // Bitrate for VideoToolbox
        }
        crate::utils::ffmpeg::GpuAccel::Cpu => {
            // Pure CPU encoding using libx264 (widely supported in browsers)
            args.push("-c:v".to_string());
            args.push("libx264".to_string());
            args.push("-preset".to_string());
            args.push("medium".to_string());
            args.push("-crf".to_string());
            args.push("23".to_string());
        }
    }

    // Audio encoding
    args.push("-c:a".to_string());
    args.push("aac".to_string());
    args.push("-b:a".to_string());
    args.push("192k".to_string());

    // Output format settings
    args.push("-movflags".to_string());
    args.push("+faststart".to_string()); // Enable streaming
    args.push("-f".to_string());
    args.push("mp4".to_string());

    // Output file
    args.push(dst_path.to_string_lossy().to_string());

    tracing::info!("Transcoding video: {} -> {}", src_path.display(), dst_path.display());

    // Run FFmpeg with timeout (10 minutes for long videos) in a blocking task
    let src_path_str = src_path.to_path_buf();
    let dst_path_str = dst_path.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        crate::utils::ffmpeg::run_ffmpeg_with_timeout(args, Duration::from_secs(600))
    }).await??;

    let used_gpu = !matches!(accel, crate::utils::ffmpeg::GpuAccel::Cpu);

    if !output.status.success() {
        if used_gpu {
            crate::utils::ffmpeg::record_gpu_failure();
        } else {
            crate::utils::ffmpeg::increment_cpu_job();
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Clean up partial file if it exists
        let _ = std::fs::remove_file(&dst_path_str);
        return Err(anyhow::anyhow!("FFmpeg transcoding failed: {}", stderr));
    }

    // Successful transcode; update GPU/CPU stats
    if used_gpu {
        crate::utils::ffmpeg::increment_gpu_job();
    } else {
        crate::utils::ffmpeg::increment_cpu_job();
    }

    // Verify the output file exists and has content
    // Small delay to ensure file is fully written to disk
    std::thread::sleep(std::time::Duration::from_millis(100));

    match std::fs::metadata(&dst_path_str) {
        Ok(meta) if meta.is_file() && meta.len() > 0 => {
            tracing::info!("Video transcoding completed successfully: {} -> {} ({} bytes)",
                src_path_str.display(), dst_path_str.display(), meta.len());
            Ok(())
        }
        Ok(meta) => {
            let _ = std::fs::remove_file(&dst_path_str);
            Err(anyhow::anyhow!("Transcoded file is invalid: is_file={}, size={}", meta.is_file(), meta.len()))
        }
        Err(e) => {
            Err(anyhow::anyhow!("Transcoded file not found after transcoding: {}", e))
        }
    }
}

async fn transcode_video_to_mp4_cpu(src_path: &std::path::Path, dst_path: &std::path::Path) -> Result<(), anyhow::Error> {
    use std::time::Duration;

    // Ensure parent directory exists
    if let Some(parent) = dst_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Try encoders in order of preference
    // Note: mpeg4 (MPEG-4 Part 2) is not well-supported by browsers in MP4 containers.
    // Browsers expect H.264 (MPEG-4 Part 10/AVC), so we prioritize libx264 and WebM codecs.
    let encoder_configs = vec![
        ("libx264", ("mp4", vec!["-preset", "medium", "-crf", "23"])),
        ("h264_v4l2m2m", ("mp4", vec!["-qmin", "18", "-qmax", "28", "-b:v", "2M"])), // V4L2 mem2mem H.264 (hardware if available)
        ("libx265", ("mp4", vec!["-preset", "medium", "-x265-params", "crf=23"])), // Use x265-params for libx265
        ("h264_qsv", ("mp4", vec!["-preset", "medium", "-global_quality", "23"])),
        ("libvpx-vp9", ("webm", vec!["-quality", "good", "-speed", "1", "-b:v", "2M"])), // WebM with VP9 - use quality/speed instead of crf
        ("libvpx", ("webm", vec!["-quality", "good", "-speed", "1", "-b:v", "2M"])), // WebM with VP8 - use quality/speed instead of crf
        ("mpeg4", ("mp4", vec!["-qscale:v", "3", "-pix_fmt", "yuv420p"])), // Last resort
    ];

    let mut last_error = None;

    for (encoder, (container_format, encoder_args)) in encoder_configs {
        // Build FFmpeg args for CPU-only encoding
        let mut args = vec!["-y".to_string()];

        // Add input file
        args.push("-i".to_string());
        args.push(src_path.to_string_lossy().to_string());

        // Add color space conversion for MJPEG inputs (yuvj422p -> yuv420p)
        // This fixes the "deprecated pixel format" warning and ensures proper color range
        // MJPEG uses full-range JPEG colorspace (yuvj422p), need to convert to standard yuv420p
        args.push("-vf".to_string());
        args.push("format=yuv420p".to_string()); // Convert to standard yuv420p with proper color range

        // Try this encoder
        args.push("-c:v".to_string());
        args.push(encoder.to_string());
        for arg in encoder_args {
            args.push(arg.to_string());
        }

        // Audio encoding - use opus for WebM, aac for MP4
        args.push("-c:a".to_string());
        if container_format == "webm" {
            args.push("libopus".to_string());
            args.push("-b:a".to_string());
            args.push("128k".to_string());
        } else {
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push("192k".to_string());
        }

        // Output format settings
        if container_format == "mp4" {
            args.push("-movflags".to_string());
            args.push("+faststart".to_string());
        }
        args.push("-f".to_string());
        args.push(container_format.to_string());

        // Output file - adjust extension based on container format
        let output_path = if container_format == "webm" {
            dst_path.with_extension("webm")
        } else {
            dst_path.to_path_buf()
        };
        args.push(output_path.to_string_lossy().to_string());

        tracing::info!("Trying CPU transcoding with encoder '{}' ({}): {} -> {}", encoder, container_format, src_path.display(), output_path.display());

        // Run FFmpeg with timeout
        let src_path_str = src_path.to_path_buf();
        let output_path_str = output_path.clone();
        let output = tokio::task::spawn_blocking(move || {
            crate::utils::ffmpeg::run_ffmpeg_with_timeout(args, Duration::from_secs(600))
        }).await??;

        if output.status.success() {
            // Verify the output file exists and has content
            std::thread::sleep(std::time::Duration::from_millis(100));

            match std::fs::metadata(&output_path_str) {
                Ok(meta) if meta.is_file() && meta.len() > 0 => {
                    tracing::info!("CPU video transcoding succeeded with encoder '{}' ({}): {} -> {} ({} bytes)",
                        encoder, container_format, src_path_str.display(), output_path_str.display(), meta.len());
                    // Increment CPU job counter for periodic GPU retry mechanism
                    crate::utils::ffmpeg::increment_cpu_job();
                    // Keep the file in its native format (WebM or MP4)
                    // The serving logic will handle the MIME type based on file extension
                    return Ok(());
                }
                Ok(meta) => {
                    let _ = std::fs::remove_file(&output_path_str);
                    last_error = Some(format!("Transcoded file is invalid: is_file={}, size={}", meta.is_file(), meta.len()));
                    continue; // Try next encoder
                }
                Err(e) => {
                    last_error = Some(format!("Transcoded file not found: {}", e));
                    continue; // Try next encoder
                }
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Clean up partial file if it exists
            let _ = std::fs::remove_file(&output_path_str);
            last_error = Some(format!("Encoder '{}' failed: {}", encoder, stderr));
            tracing::warn!("Encoder '{}' failed, trying next: {}", encoder, stderr);
            continue; // Try next encoder
        }
    }

    // All encoders failed
    Err(anyhow::anyhow!("All video encoders failed. Last error: {}",
        last_error.unwrap_or_else(|| "Unknown error".to_string())))
}

fn parse_range(range_str: &str, file_size: u64) -> Option<(u64, u64)> {
    // Parse "bytes=start-end" format
    if let Some(bytes_part) = range_str.strip_prefix("bytes=") {
        if let Some((start_str, end_str)) = bytes_part.split_once('-') {
            let start = if start_str.is_empty() {
                0
            } else {
                start_str.parse::<u64>().ok()?
            };

            let end = if end_str.is_empty() {
                file_size - 1
            } else {
                end_str.parse::<u64>().ok()?
            };

            if start <= end && end < file_size {
                return Some((start, end));
            }
        }
    }
    None
}

pub async fn download_asset(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let path = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            crate::db::query::get_asset_path(&conn, id).ok()?
        }
    }).await.ok().flatten();

    if let Some(file_path) = path {
        if let Ok(bytes) = tokio::fs::read(&file_path).await {
            let filename = std::path::Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");

            let mime = mime_guess::from_path(&file_path)
                .first_or_octet_stream();

            let mut resp = axum::http::Response::builder().status(StatusCode::OK);
            let headers = resp.headers_mut().unwrap();
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(mime.as_ref()).unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream"))
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename))
                    .unwrap_or_else(|_| header::HeaderValue::from_static("attachment"))
            );
            return resp.body(axum::body::Body::from(bytes)).unwrap();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

#[derive(Debug, Clone)]
struct AssetFileInfo {
    path: Option<String>,
    sha256: Option<Vec<u8>>,
}

fn fetch_asset_file_info(conn: &Connection, id: i64) -> rusqlite::Result<Option<AssetFileInfo>> {
    conn
        .prepare("SELECT path, sha256 FROM assets WHERE id = ?1")?
        .query_row(params![id], |row| {
            Ok(AssetFileInfo {
                path: row.get(0)?,
                sha256: row.get(1)?,
            })
        })
        .optional()
}

fn remove_derived_files(sha256: Option<&[u8]>, derived_dir: &StdPath) {
    if let Some(sha) = sha256 {
        if sha.is_empty() {
            return;
        }
        let sha_hex = hex::encode(sha);
        if sha_hex.len() < 2 {
            return;
        }
        let sub = &sha_hex[0..2];
        let thumb_path = derived_dir.join(sub).join(format!("{}-256.webp", sha_hex));
        let preview_path = derived_dir.join(sub).join(format!("{}-1600.webp", sha_hex));
        let _ = std::fs::remove_file(thumb_path);
        let _ = std::fs::remove_file(preview_path);
    }
}

enum DeleteDiskError {
    ReadOnly(io::Error),
    Other(io::Error),
}

fn is_read_only_error(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::PermissionDenied || err.to_string().to_lowercase().contains("read-only")
}

fn remove_original_file(path: &str, paths: &AppPaths) -> Result<(), DeleteDiskError> {
    let resolved_path = crate::utils::path::resolve_asset_path(path, paths);
    match std::fs::remove_file(&resolved_path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) if is_read_only_error(&e) => Err(DeleteDiskError::ReadOnly(e)),
        Err(e) => Err(DeleteDiskError::Other(e)),
    }
}

#[derive(Serialize)]
struct PermanentDeleteResponse {
    success: bool,
    deleted_from_disk: bool,
    read_only: bool,
    path: Option<String>,
    error: Option<String>,
}

impl PermanentDeleteResponse {
    fn success(path: Option<String>) -> Self {
        Self {
            success: true,
            deleted_from_disk: true,
            read_only: false,
            path,
            error: None,
        }
    }

    #[allow(dead_code)]
    fn not_found() -> Self {
        Self {
            success: false,
            deleted_from_disk: false,
            read_only: false,
            path: None,
            error: Some("Asset not found".to_string()),
        }
    }

    fn read_only(path: Option<String>, error: String) -> Self {
        Self {
            success: false,
            deleted_from_disk: false,
            read_only: true,
            path,
            error: Some(error),
        }
    }
}

#[derive(Deserialize)]
pub struct BulkPermanentDeleteRequest {
    ids: Vec<i64>,
}

#[derive(Serialize)]
struct BulkPermanentDeleteResult {
    id: i64,
    deleted: bool,
    read_only: bool,
    path: Option<String>,
    error: Option<String>,
}

impl From<BulkPermanentDeleteResult> for PermanentDeleteResponse {
    fn from(result: BulkPermanentDeleteResult) -> Self {
        let BulkPermanentDeleteResult { deleted, read_only, path, error, .. } = result;
        if deleted {
            return PermanentDeleteResponse::success(path);
        }
        if read_only {
            return PermanentDeleteResponse::read_only(
                path,
                error.unwrap_or_else(|| "File is read-only".to_string()),
            );
        }
        PermanentDeleteResponse {
            success: false,
            deleted_from_disk: false,
            read_only: false,
            path,
            error: Some(error.unwrap_or_else(|| "Asset not found".to_string())),
        }
    }
}

fn perform_permanent_delete(conn: &Connection, derived_dir: &StdPath, paths: &AppPaths, id: i64) -> Result<BulkPermanentDeleteResult> {
    let asset_info = fetch_asset_file_info(conn, id)?;
    if let Some(info) = asset_info {
        let path = info.path.clone();
        let sha = info.sha256.clone();
        if let Some(ref file_path) = path {
            match remove_original_file(file_path, paths) {
                Ok(_) => {
                    let deleted = crate::db::query::delete_asset_by_id(conn, id)?;
                    if deleted {
                        remove_derived_files(sha.as_deref(), derived_dir);
                        Ok(BulkPermanentDeleteResult { id, deleted: true, read_only: false, path, error: None })
                    } else {
                        Ok(BulkPermanentDeleteResult { id, deleted: false, read_only: false, path, error: Some("Asset not found".to_string()) })
                    }
                }
                Err(DeleteDiskError::ReadOnly(err)) => Ok(BulkPermanentDeleteResult {
                    id,
                    deleted: false,
                    read_only: true,
                    path,
                    error: Some(err.to_string()),
                }),
                Err(DeleteDiskError::Other(err)) => Err(anyhow::Error::new(err)),
            }
        } else {
            let deleted = crate::db::query::delete_asset_by_id(conn, id)?;
            if deleted {
                remove_derived_files(sha.as_deref(), derived_dir);
                Ok(BulkPermanentDeleteResult { id, deleted: true, read_only: false, path: None, error: None })
            } else {
                Ok(BulkPermanentDeleteResult { id, deleted: false, read_only: false, path: None, error: Some("Asset not found".to_string()) })
            }
        }
    } else {
        Ok(BulkPermanentDeleteResult { id, deleted: false, read_only: false, path: None, error: Some("Asset not found".to_string()) })
    }
}

pub async fn delete_asset(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let derived_dir = state.paths.data.join("derived");
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let derived_dir = derived_dir.clone();
        move || -> Result<bool> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            let asset_info = fetch_asset_file_info(&conn, id)?;
            let deleted = crate::db::query::delete_asset_by_id(&conn, id)?;
            if deleted {
                if let Some(info) = asset_info {
                    remove_derived_files(info.sha256.as_deref(), derived_dir.as_path());
                }
            }
            Ok(deleted)
        }
    }).await;

    match result {
        Ok(Ok(true)) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"success": false, "error": "Asset not found"}))
        ).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error deleting asset {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "error": format!("Internal error: {}", e)
                }))
            ).into_response()
        }
        Err(e) => {
            tracing::error!("Task error deleting asset {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": "Internal error"}))
            ).into_response()
        }
    }
}

pub async fn delete_asset_permanent(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let derived_dir = state.paths.data.join("derived");
    let paths = state.paths.clone();
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let derived_dir = derived_dir.clone();
        let paths = paths.clone();
        move || -> Result<BulkPermanentDeleteResult> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            perform_permanent_delete(&conn, &derived_dir, &paths, id)
        }
    }).await;

    match result {
        Ok(Ok(outcome)) => {
            let status = if outcome.deleted {
                StatusCode::OK
            } else if outcome.read_only {
                StatusCode::CONFLICT
            } else if outcome.error.as_deref() == Some("Asset not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            let response: PermanentDeleteResponse = outcome.into();
            (status, Json(response)).into_response()
        }
        Ok(Err(e)) => {
            tracing::error!("Error permanently deleting asset {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": format!("Internal error: {}", e)}))
            ).into_response()
        }
        Err(e) => {
            tracing::error!("Task error permanently deleting asset {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": "Internal error"}))
            ).into_response()
        }
    }
}

pub async fn delete_assets_permanent(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BulkPermanentDeleteRequest>
) -> impl IntoResponse {
    if payload.ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "No asset IDs provided"}))
        ).into_response();
    }

    let derived_dir = state.paths.data.join("derived");
    let paths = state.paths.clone();
    let ids = payload.ids;
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let derived_dir = derived_dir.clone();
        let paths = paths.clone();
        move || -> Result<Vec<BulkPermanentDeleteResult>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            let mut outcomes = Vec::with_capacity(ids.len());
            for asset_id in ids {
                let outcome = perform_permanent_delete(&conn, &derived_dir, &paths, asset_id)?;
                outcomes.push(outcome);
            }
            Ok(outcomes)
        }
    }).await;

    match result {
        Ok(Ok(results)) => {
            let any_failure = results.iter().any(|r| !r.deleted);
            let read_only_failures: Vec<_> = results
                .iter()
                .filter(|r| r.read_only)
                .map(|r| serde_json::json!({
                    "id": r.id,
                    "path": r.path.clone(),
                    "error": r.error.clone()
                }))
                .collect();
            let status = if !read_only_failures.is_empty() {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            };
            (
                status,
                Json(serde_json::json!({
                    "success": !any_failure,
                    "results": results,
                    "read_only_failures": read_only_failures
                }))
            ).into_response()
        }
        Ok(Err(e)) => {
            tracing::error!("Error permanently deleting assets: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": format!("Internal error: {}", e)}))
            ).into_response()
        }
        Err(e) => {
            tracing::error!("Task error permanently deleting assets: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": "Internal error"}))
            ).into_response()
        }
    }
}

pub async fn extract_audio_mp3(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    // Look up the asset path
    let path = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            crate::db::query::get_asset_path(&conn, id).ok()?
        }
    }).await.ok().flatten();

    if let Some(file_path) = path {
        // Quick filter: only allow on video/audio assets
        let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
        let mime_str = mime.essence_str();
        let allow = mime_str.starts_with("video/") || mime_str.starts_with("audio/");
        if !allow {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": "Audio extraction is only supported for video/audio files",
            }))).into_response();
        }

        // If already mp3 audio, stream original file (no transcode)
        if mime_str == "audio/mpeg" {
            if let Ok(bytes) = tokio::fs::read(&file_path).await {
                let base = StdPath::new(&file_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("audio");
                let mut resp = axum::http::Response::builder().status(StatusCode::OK);
                let headers = resp.headers_mut().unwrap();
                headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("audio/mpeg"));
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    header::HeaderValue::from_str(&format!("attachment; filename=\"{}.mp3\"", base))
                        .unwrap_or_else(|_| header::HeaderValue::from_static("attachment"))
                );
                return resp.body(axum::body::Body::from(bytes)).unwrap();
            }
        }

        // Otherwise, transcode/extract to mp3 using ffmpeg to stdout
        let file_path_for_closure = file_path.clone();
        let file_path_for_log = file_path.clone();
        tracing::info!("Starting audio extraction for asset {}: {}", id, file_path_for_log);
        let res = tokio::task::spawn_blocking(move || {
            // Try libmp3lame first (best quality), then libshine (if built), then generic mp3
            let encoders = vec!["libmp3lame", "libshine", "mp3"];
            let mut last_error = None;

            for encoder in encoders {
                tracing::info!("Attempting audio extraction with encoder '{}' for {}", encoder, file_path_for_closure);
                let args = vec![
                    "-i".to_string(), file_path_for_closure.clone(),
                    "-vn".to_string(),
                    "-acodec".to_string(), encoder.to_string(),
                    "-ab".to_string(), "192k".to_string(),
                    "-f".to_string(), "mp3".to_string(),
                    "-map".to_string(), "a:0".to_string(),
                    "-hide_banner".to_string(),
                    "-loglevel".to_string(), "warning".to_string(), // Changed to warning to see progress
                    "-".to_string(),
                ];

                // Log the full command for debugging
                let cmd_str = args.join(" ");
                tracing::info!("FFmpeg command: {}", cmd_str);

                let start_time = std::time::Instant::now();
                match ffmpeg::run_ffmpeg_with_timeout(args.clone(), std::time::Duration::from_secs(600)) {
                    Ok(output) if output.status.success() => {
                        let elapsed = start_time.elapsed();
                        tracing::info!("Audio extraction succeeded with encoder '{}' in {:?}, output size: {} bytes",
                            encoder, elapsed, output.stdout.len());
                        return Ok(output);
                    }
                    Ok(output) => {
                        let elapsed = start_time.elapsed();
                        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
                        tracing::warn!("Encoder '{}' failed after {:?} (exit code: {}): {}",
                            encoder, elapsed, output.status.code().unwrap_or(-1), err_msg);
                        last_error = Some(format!("Encoder '{}' failed: {}", encoder, err_msg));
                        // Continue to next encoder
                    }
                    Err(e) => {
                        let elapsed = start_time.elapsed();
                        let error_msg = format!("{}", e);
                        tracing::error!("Encoder '{}' error after {:?}: {}", encoder, elapsed, error_msg);
                        last_error = Some(format!("Encoder '{}' error: {}", encoder, error_msg));
                        // Continue to next encoder
                    }
                }
            }

            // All encoders failed
            tracing::error!("All MP3 encoders failed for {}", file_path_for_closure);
            Err(anyhow::anyhow!("All MP3 encoders failed. Last error: {}", last_error.unwrap_or_else(|| "Unknown error".to_string())))
        }).await;

        match res {
            Ok(Ok(output)) => {
                // Success - output is already verified in the loop
                let base = StdPath::new(&file_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("audio");
                let mut resp = axum::http::Response::builder().status(StatusCode::OK);
                let headers = resp.headers_mut().unwrap();
                headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("audio/mpeg"));
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    header::HeaderValue::from_str(&format!("attachment; filename=\"{}.mp3\"", base))
                        .unwrap_or_else(|_| header::HeaderValue::from_static("attachment"))
                );
                return resp.body(axum::body::Body::from(output.stdout)).unwrap();
            }
            _ => {
                // Fallback: try AAC in M4A container when MP3 encoders are not available
                tracing::warn!("MP3 extraction failed; attempting AAC/m4a fallback");
                let fallback = tokio::task::spawn_blocking({
                    let fp = file_path.clone();
                    move || {
                        let args = vec![
                            "-i".to_string(), fp.clone(),
                            "-vn".to_string(),
                            "-c:a".to_string(), "aac".to_string(),
                            "-b:a".to_string(), "192k".to_string(),
                            "-movflags".to_string(), "+faststart".to_string(),
                            "-f".to_string(), "mp4".to_string(),
                            "-map".to_string(), "a:0".to_string(),
                            "-hide_banner".to_string(),
                            "-loglevel".to_string(), "error".to_string(),
                            "-".to_string(),
                        ];
                        ffmpeg::run_ffmpeg_with_timeout(args, std::time::Duration::from_secs(600))
                    }
                }).await;

                match fallback {
                    Ok(Ok(out2)) if out2.status.success() => {
                        let base = StdPath::new(&file_path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("audio");
                        let mut resp = axum::http::Response::builder().status(StatusCode::OK);
                        let headers = resp.headers_mut().unwrap();
                        headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("audio/mp4"));
                        headers.insert(
                            header::CONTENT_DISPOSITION,
                            header::HeaderValue::from_str(&format!("attachment; filename=\"{}.m4a\"", base))
                                .unwrap_or_else(|_| header::HeaderValue::from_static("attachment"))
                        );
                        return resp.body(axum::body::Body::from(out2.stdout)).unwrap();
                    }
                    Ok(Ok(out2)) => {
                        let err2 = String::from_utf8_lossy(&out2.stderr).to_string();
                        tracing::error!("ffmpeg aac fallback failed: {}", err2);
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                            "success": false,
                            "error": "FFmpeg failed to extract audio",
                            "details": err2,
                        }))).into_response();
                    }
                    Ok(Err(e)) => {
                        tracing::error!("FFmpeg error (fallback): {}", e);
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                            "success": false,
                            "error": format!("FFmpeg error: {}", e),
                        }))).into_response();
                    }
                    Err(e) => {
                        tracing::error!("Task join error running ffmpeg (fallback): {}", e);
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                            "success": false,
                            "error": "Internal error",
                        }))).into_response();
                    }
                }
            }
        }
    }

    StatusCode::NOT_FOUND.into_response()
}

#[derive(Deserialize)]
pub struct BrowseQuery {
    path: Option<String>,
}

pub async fn browse_directory(State(_state): State<Arc<AppState>>, Query(params): Query<BrowseQuery>) -> impl IntoResponse {
    let requested_path = params.path.as_deref().unwrap_or("/");

    // Allow browsing from container root (/)
    // Security: Only allow absolute paths, prevent directory traversal attacks
    let target_path = if requested_path == "/" || requested_path.is_empty() {
        std::path::PathBuf::from("/")
    } else {
        let requested = std::path::PathBuf::from(requested_path);

        // Only allow absolute paths
        if !requested.is_absolute() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "Path must be absolute"
            })));
        }

        // Normalize the path to prevent directory traversal
        let resolved = requested.canonicalize().unwrap_or(requested);

        // Ensure it's still absolute after canonicalization
        if !resolved.is_absolute() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "Invalid path"
            })));
        }

        resolved
    };

    let result = tokio::task::spawn_blocking({
        let path = target_path.clone();
        move || -> Result<Vec<serde_json::Value>, anyhow::Error> {
            let mut entries = Vec::new();

            if !path.exists() {
                return Ok(entries);
            }

            if !path.is_dir() {
                return Err(anyhow::anyhow!("Path is not a directory"));
            }

            let dir_entries = std::fs::read_dir(&path)?;
            let mut dirs = Vec::new();
            let mut files = Vec::new();

            for entry_result in dir_entries {
                let entry = entry_result?;
                let entry_path = entry.path();
                let metadata = entry.metadata().ok();

                // Skip hidden files/directories
                if entry_path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.starts_with('.'))
                    .unwrap_or(false) {
                    continue;
                }

                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let name = entry_path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                let entry_json = serde_json::json!({
                    "name": name,
                    "path": entry_path.to_string_lossy().to_string(),
                    "is_dir": is_dir,
                });

                if is_dir {
                    dirs.push(entry_json);
                } else {
                    files.push(entry_json);
                }
            }

            // Sort: directories first, then files, both alphabetically
            dirs.sort_by(|a, b| {
                a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
            });
            files.sort_by(|a, b| {
                a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
            });

            entries.extend(dirs);
            entries.extend(files);

            Ok(entries)
        }
    }).await;

    match result {
        Ok(Ok(entries)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "path": target_path.to_string_lossy().to_string(),
                "entries": entries
            })))
        },
        Ok(Err(e)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": e.to_string()
            })))
        },
        Err(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Task error: {}", e)
            })))
        }
    }
}

#[derive(Deserialize)]
pub struct SaveOrientationRequest {
    rotation: i32,
}

pub async fn save_orientation(State(state): State<Arc<AppState>>, Path(id): Path<i64>, Json(req): Json<SaveOrientationRequest>) -> impl IntoResponse {
    let pool = state.pool.clone();
    let paths = state.paths.clone();
    let rotation = req.rotation;

    // Normalize rotation to 0-360 range
    let normalized_rotation = ((rotation % 360) + 360) % 360;

    // Only allow 90-degree increments
    if normalized_rotation != 0 && normalized_rotation != 90 && normalized_rotation != 180 && normalized_rotation != 270 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": "Rotation must be a multiple of 90 degrees"
        }))).into_response();
    }

    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Get asset path
        let path: String = conn.query_row(
            "SELECT path FROM assets WHERE id = ?1",
            params![id],
            |row| row.get(0)
        )?;

        let resolved_path = crate::utils::path::resolve_asset_path(&path, &paths);
        if !resolved_path.exists() {
            anyhow::bail!(
                "File not found: stored path '{}', resolved path '{}'",
                path,
                resolved_path.display()
            );
        }

        #[cfg(not(target_env = "msvc"))]
        {
            let resolved_str = resolved_path.to_string_lossy();
            // Load image with libvips
            let img = libvips::VipsImage::new_from_file(resolved_str.as_ref())?;

            // Determine rotation angle based on normalized rotation
            let rotated = match normalized_rotation {
                90 => libvips::ops::rot(&img, Angle::D90)?,
                180 => libvips::ops::rot(&img, Angle::D180)?,
                270 => libvips::ops::rot(&img, Angle::D270)?,
                _ => img, // 0 degrees, no rotation needed
            };

            // Save rotated image back to disk
            // Use the same format as the original file
            rotated.image_write_to_file(resolved_str.as_ref())?;
            Ok(())
        }
        #[cfg(target_env = "msvc")]
        {
            anyhow::bail!("Image rotation not available on Windows MSVC (libvips not supported)")
        }
    }).await;

    match result {
        Ok(Ok(())) => {
            (StatusCode::OK, Json(serde_json::json!({
                "success": true
            }))).into_response()
        },
        Ok(Err(e)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))).into_response()
        },
        Err(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "success": false,
                "error": format!("Task error: {}", e)
            }))).into_response()
        }
    }
}

// Album handlers

#[derive(Deserialize)]
pub struct CreateAlbumRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct AlbumResponse {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub asset_ids: Vec<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct UpdateAlbumRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub struct AddAssetsToAlbumRequest {
    pub asset_ids: Vec<i64>,
}

pub async fn list_albums(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || -> Result<Vec<AlbumResponse>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            // Use optimized single-query function (no N+1)
            let albums = db::query::list_albums_with_assets(&conn)?;
            let responses: Vec<AlbumResponse> = albums
                .into_iter()
                .map(|(id, name, description, created_at, updated_at, asset_ids)| {
                    AlbumResponse {
                        id,
                        name,
                        description,
                        asset_ids,
                        created_at,
                        updated_at,
                    }
                })
                .collect();
            Ok(responses)
        }
    }).await;

    match result {
        Ok(Ok(albums)) => (StatusCode::OK, Json(albums)).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error listing albums: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error listing albums: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn get_album(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || -> Result<Option<AlbumResponse>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            if let Some((id, name, description, created_at, updated_at, asset_ids)) = db::query::get_album(&conn, id)? {
                Ok(Some(AlbumResponse {
                    id,
                    name,
                    description,
                    asset_ids,
                    created_at,
                    updated_at,
                }))
            } else {
                Ok(None)
            }
        }
    }).await;

    match result {
        Ok(Ok(Some(album))) => (StatusCode::OK, Json(album)).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Album not found"
        }))).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error getting album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error getting album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn create_album(State(state): State<Arc<AppState>>, Json(req): Json<CreateAlbumRequest>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let name = req.name.clone();
        let description = req.description.clone();
        move || -> Result<AlbumResponse> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            let id = db::writer::create_album(&conn, &name, description.as_deref())?;
            // Get the created album
            if let Some((id, name, description, created_at, updated_at, asset_ids)) = db::query::get_album(&conn, id)? {
                Ok(AlbumResponse {
                    id,
                    name,
                    description,
                    asset_ids,
                    created_at,
                    updated_at,
                })
            } else {
                Err(anyhow::anyhow!("Failed to retrieve created album"))
            }
        }
    }).await;

    match result {
        Ok(Ok(album)) => (StatusCode::CREATED, Json(album)).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error creating album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error creating album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn update_album(State(state): State<Arc<AppState>>, Path(id): Path<i64>, Json(req): Json<UpdateAlbumRequest>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let name = req.name.clone();
        let description = req.description.clone();
        move || -> Result<Option<AlbumResponse>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            let updated = db::writer::update_album(&conn, id, name.as_deref(), description.as_deref())?;
            if updated {
                // Get the updated album
                if let Some((id, name, description, created_at, updated_at, asset_ids)) = db::query::get_album(&conn, id)? {
                    Ok(Some(AlbumResponse {
                        id,
                        name,
                        description,
                        asset_ids,
                        created_at,
                        updated_at,
                    }))
                } else {
                    Ok(None)
                }
            } else {
                Ok(None)
            }
        }
    }).await;

    match result {
        Ok(Ok(Some(album))) => (StatusCode::OK, Json(album)).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Album not found"
        }))).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error updating album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error updating album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn delete_album(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || -> Result<bool> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            db::writer::delete_album(&conn, id)
        }
    }).await;

    match result {
        Ok(Ok(true)) => (StatusCode::OK, Json(serde_json::json!({
            "success": true
        }))).into_response(),
        Ok(Ok(false)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Album not found"
        }))).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error deleting album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error deleting album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn add_assets_to_album(State(state): State<Arc<AppState>>, Path(id): Path<i64>, Json(req): Json<AddAssetsToAlbumRequest>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let asset_ids = req.asset_ids.clone();
        move || -> Result<Option<AlbumResponse>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            // Check if album exists
            if db::query::get_album(&conn, id)?.is_none() {
                return Ok(None);
            }
            db::writer::add_assets_to_album(&conn, id, &asset_ids)?;
            // Get the updated album
            if let Some((id, name, description, created_at, updated_at, asset_ids)) = db::query::get_album(&conn, id)? {
                Ok(Some(AlbumResponse {
                    id,
                    name,
                    description,
                    asset_ids,
                    created_at,
                    updated_at,
                }))
            } else {
                Ok(None)
            }
        }
    }).await;

    match result {
        Ok(Ok(Some(album))) => (StatusCode::OK, Json(album)).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Album not found"
        }))).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error adding assets to album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error adding assets to album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn remove_assets_from_album(State(state): State<Arc<AppState>>, Path(id): Path<i64>, Json(req): Json<AddAssetsToAlbumRequest>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let asset_ids = req.asset_ids.clone();
        move || -> Result<Option<AlbumResponse>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            // Check if album exists
            if db::query::get_album(&conn, id)?.is_none() {
                return Ok(None);
            }
            db::writer::remove_assets_from_album(&conn, id, &asset_ids)?;
            // Get the updated album
            if let Some((id, name, description, created_at, updated_at, asset_ids)) = db::query::get_album(&conn, id)? {
                Ok(Some(AlbumResponse {
                    id,
                    name,
                    description,
                    asset_ids,
                    created_at,
                    updated_at,
                }))
            } else {
                Ok(None)
            }
        }
    }).await;

    match result {
        Ok(Ok(Some(album))) => (StatusCode::OK, Json(album)).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "Album not found"
        }))).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error removing assets from album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error removing assets from album: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

pub async fn get_albums_for_asset(State(state): State<Arc<AppState>>, Path(asset_id): Path<i64>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || -> Result<Vec<i64>> {
            let conn = pool.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            db::query::get_albums_for_asset(&conn, asset_id)
        }
    }).await;

    match result {
        Ok(Ok(album_ids)) => (StatusCode::OK, Json(album_ids)).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Error getting albums for asset: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Database error: {}", e)
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Task error getting albums for asset: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "Internal server error"
            }))).into_response()
        }
    }
}

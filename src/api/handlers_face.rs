use std::sync::Arc;
use axum::{extract::{State, Path}, http::StatusCode, Json};
use axum::response::IntoResponse;
use serde::Deserialize;
use crate::AppState;
use crate::db;
use axum::extract::Query;
use serde::Serialize;
use rusqlite::OptionalExtension;

// Face detection handlers
pub async fn detect_faces(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    let face_tx = state.queues.face_tx.clone();
    let gauges = state.gauges.clone();

    // Set enabled state in database
    let pool = state.pool.clone();
    let enabled_set = tokio::task::spawn_blocking({
        let pool = pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::writer::set_face_detection_enabled(&conn, true).ok()
        }
    }).await.ok().flatten();

    if enabled_set.is_some() {
        state.face_detection_enabled.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    tokio::spawn(async move {
        // Get image assets based on excluded extensions setting
        let image_assets = tokio::task::spawn_blocking({
            let pool = pool.clone();
            move || {
                let conn = pool.get().ok()?;

                // All image extensions that can be processed
                let all_image_exts = vec![
                    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "heic", "heif",
                    "raw", "cr2", "nef", "orf", "sr2", "arw", "dng", "rw2", "raf", "pef",
                    "srw", "3fr", "x3f", "mrw", "mef", "mos", "erf", "dcr", "kdc", "fff",
                    "iiq", "rwl", "r3d", "ari", "bay", "cap", "data", "dcs", "drf", "eip",
                    "k25", "mdc", "nrw", "obm", "ptx", "pxn", "rwz", "srf", "crw"
                ];

                // Default allowed extensions (if no exclusions set in database)
                let default_allowed = vec!["jpg", "jpeg", "png", "webp", "heic", "heif", "tiff", "tif"];

                // Read excluded extensions from database
                let excluded = db::writer::get_face_setting(&conn, "excluded_extensions").ok()?;
                let excluded_list: Vec<String> = excluded
                    .map(|s| s.split(',').map(|x| x.trim().to_lowercase()).collect())
                    .unwrap_or_default();

                // Build allowed extensions list
                let allowed_exts: Vec<&str> = if excluded_list.is_empty() {
                    // No exclusions set - use default allowed list
                    default_allowed
                } else {
                    // Exclusions are set - start with all image extensions and remove excluded ones
                    all_image_exts.into_iter()
                        .filter(|ext| !excluded_list.contains(&ext.to_lowercase()))
                        .collect()
                };

                if allowed_exts.is_empty() {
                    return Some(Vec::new());
                }

                // Build SQL query with allowed extensions
                // Handle both ".ext" and "ext" formats, and case-insensitive matching
                let ext_conditions: Vec<String> = allowed_exts.iter()
                    .flat_map(|ext| vec![
                        format!("LOWER(a.ext) = '.{}'", ext),
                        format!("LOWER(a.ext) = '{}'", ext),
                        format!("LOWER(REPLACE(a.ext, '.', '')) = '{}'", ext)
                    ])
                    .collect();
                let sql = format!(
                    "SELECT a.id, a.path
                     FROM assets a
                     WHERE ({})
                     AND a.id NOT IN (SELECT DISTINCT asset_id FROM face_embeddings)",
                    ext_conditions.join(" OR ")
                );

                let mut stmt = conn.prepare(&sql).ok()?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                }).ok()?;
                let mut assets = Vec::new();
                for (id, path) in rows.flatten() {
                    assets.push((id, std::path::PathBuf::from(path)));
                }
                Some(assets)
            }
        }).await.ok().flatten().unwrap_or_default();

        // Queue all JPEG images for face detection
        for (asset_id, path) in image_assets {
            if face_tx.send(crate::pipeline::face::FaceJob { asset_id, image_path: path }).await.is_err() {
                break;
            }
            gauges.face.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({
        "status": "started",
        "message": "Face detection started"
    })))
}

pub async fn face_detection_status(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    let enabled = state.face_detection_enabled.load(std::sync::atomic::Ordering::Relaxed);
    let queue_depth = state.gauges.face.load(std::sync::atomic::Ordering::Relaxed);

    (StatusCode::OK, Json(serde_json::json!({
        "enabled": enabled,
        "queue_depth": queue_depth
    })))
}

pub async fn stop_face_detection(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    // Set enabled state to false in database
    let pool = state.pool.clone();
    let disabled_set = tokio::task::spawn_blocking({
        let pool = pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::writer::set_face_detection_enabled(&conn, false).ok()
        }
    }).await.ok().flatten();

    if disabled_set.is_some() {
        state.face_detection_enabled.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    // Clear the queue gauge (remaining items won't be processed)
    state.gauges.face.store(0, std::sync::atomic::Ordering::Relaxed);

    (StatusCode::OK, Json(serde_json::json!({
        "status": "stopped",
        "message": "Face detection disabled"
    })))
}

#[cfg(feature = "facial-recognition")]
pub async fn face_progress(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    // Get enabled state (from memory, or initialize from database if not set)
    let enabled = state.face_detection_enabled.load(std::sync::atomic::Ordering::Relaxed);
    let queue_depth = state.gauges.face.load(std::sync::atomic::Ordering::Relaxed);

    // Initialize from database on first call if not set
    if !enabled {
        let pool = state.pool.clone();
        let db_enabled = tokio::task::spawn_blocking(move || {
            let conn = pool.get().ok()?;
            db::writer::get_face_detection_enabled(&conn).ok()
        }).await.ok().flatten().unwrap_or(false);

        state.face_detection_enabled.store(db_enabled, std::sync::atomic::Ordering::Relaxed);
    }

    let enabled = state.face_detection_enabled.load(std::sync::atomic::Ordering::Relaxed);

    // Models loaded status
    let (scrfd_loaded, arcface_loaded) = {
        let guard = state.face_processor.lock();
        (
            guard.scrfd_loaded(),
            guard.arcface_loaded(),
        )
    };

    // Format models status string
    let models_status = if scrfd_loaded && arcface_loaded {
        "SCRFD and ArcFace loaded"
    } else if scrfd_loaded {
        "SCRFD loaded"
    } else if arcface_loaded {
        "ArcFace loaded"
    } else {
        "Models not loaded"
    };

    // DB counts
    let pool = state.pool.clone();
    let (faces_total, persons_total, assets_with_faces) = tokio::task::spawn_blocking(move || {
        let conn = pool.get().ok()?;
        let faces_total: i64 = conn.query_row("SELECT COUNT(*) FROM face_embeddings", [], |r| r.get(0)).ok()?;
        let persons_total: i64 = conn.query_row("SELECT COUNT(*) FROM persons", [], |r| r.get(0)).ok()?;
        let assets_with_faces: i64 = conn.query_row("SELECT COUNT(DISTINCT asset_id) FROM face_embeddings", [], |r| r.get(0)).ok()?;
        Some((faces_total, persons_total, assets_with_faces))
    }).await.ok().flatten().unwrap_or((0, 0, 0));

    let batch = std::env::var("SEEN_FACE_CLUSTER_BATCH").ok().and_then(|v| v.parse().ok()).unwrap_or(crate::pipeline::face::FACE_CLUSTER_BATCH_SIZE as i64);
    let remaining_to_next_cluster = if faces_total == 0 { batch } else { (batch - (faces_total % batch)) % batch };

    let status_msg = if !scrfd_loaded || !arcface_loaded {
        "Face models not loaded yet"
    } else if queue_depth > 0 {
        "" // Status shown in "Detecting... (queue)" indicator, no need to duplicate
    } else if faces_total == 0 {
        "No faces captured yet"
    } else if remaining_to_next_cluster > 0 {
        "Collecting more faces before next clustering"
    } else {
        "Ready to cluster"
    };

    (StatusCode::OK, Json(serde_json::json!({
        "enabled": enabled,
        "queue_depth": queue_depth,
        "models_loaded": { "scrfd": scrfd_loaded, "arcface": arcface_loaded },
        "models_status": models_status,
        "counts": {
            "faces_total": faces_total,
            "persons_total": persons_total,
            "assets_with_faces": assets_with_faces
        },
        "thresholds": {
            "cluster_batch_size": batch,
            "remaining_to_next_cluster": remaining_to_next_cluster
        },
        "status": status_msg
    })))
}

#[cfg(feature = "facial-recognition")]
#[derive(Deserialize)]
pub struct PageQ {
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[cfg(feature = "facial-recognition")]
#[derive(Serialize)]
pub struct FaceListItem {
    pub id: i64,
    pub asset_id: i64,
    pub bbox: serde_json::Value,
    pub confidence: f64,
}

#[cfg(feature = "facial-recognition")]
pub async fn list_unassigned_faces(State(state): State<Arc<AppState>>, Query(q): Query<PageQ>) -> impl axum::response::IntoResponse {
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(60).clamp(1, 500);
    let pool = state.pool.clone();
    let rows = tokio::task::spawn_blocking(move || {
        let conn = pool.get().ok()?;
        let rows = db::query::get_unassigned_faces(&conn, offset, limit).ok()?;
        Some(rows)
    }).await.ok().flatten().unwrap_or_default();

    let out: Vec<FaceListItem> = rows.into_iter().map(|(id, asset_id, bbox_json, confidence)| FaceListItem {
        id, asset_id, bbox: serde_json::from_str(&bbox_json).unwrap_or_else(|_| serde_json::json!({})), confidence
    }).collect();

    (StatusCode::OK, Json(serde_json::json!({ "faces": out })))
}

#[cfg(feature = "facial-recognition")]
#[derive(Deserialize)]
pub struct AssignFaceReq {
    pub person_id: Option<i64>,
}

#[cfg(feature = "facial-recognition")]
pub async fn assign_face_to_person(
    State(state): State<Arc<AppState>>,
    Path(face_id): Path<i64>,
    Json(req): Json<AssignFaceReq>,
) -> impl axum::response::IntoResponse {
    #[derive(Clone, Copy)]
    enum AssignOutcome {
        Assigned { person_id: i64 },
        Unassigned { previous_person_id: Option<i64> },
        PersonNotFound,
        FaceNotFound,
    }

    let pool = state.pool.clone();
    let target_person = req.person_id;
    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().ok()?;
        let previous_person_id: Option<i64> = match conn
            .query_row(
                "SELECT person_id FROM face_embeddings WHERE id = ?1",
                rusqlite::params![face_id],
                |row| row.get(0),
            )
            .optional()
        {
            Ok(Some(pid)) => pid,
            Ok(None) => return Some(AssignOutcome::FaceNotFound),
            Err(_) => return None,
        };

        if let Some(pid) = target_person {
            if db::query::get_person(&conn, pid).ok()?.is_none() {
                return Some(AssignOutcome::PersonNotFound);
            }
            match db::writer::update_face_person(&conn, face_id, Some(pid)) {
                Ok(true) => {
                    if db::writer::rebuild_person_profile(&conn, pid).is_err() {
                        return None;
                    }
                    if let Some(prev) = previous_person_id {
                        if prev != pid && db::writer::rebuild_person_profile(&conn, prev).is_err() {
                            return None;
                        }
                    }
                    Some(AssignOutcome::Assigned { person_id: pid })
                }
                Ok(false) => Some(AssignOutcome::FaceNotFound),
                Err(_) => None,
            }
        } else {
            match db::writer::update_face_person(&conn, face_id, None) {
                Ok(true) => {
                    if let Some(prev) = previous_person_id {
                        if db::writer::rebuild_person_profile(&conn, prev).is_err() {
                            return None;
                        }
                    }
                    Some(AssignOutcome::Unassigned { previous_person_id })
                }
                Ok(false) => Some(AssignOutcome::FaceNotFound),
                Err(_) => None,
            }
        }
    })
    .await
    .ok()
    .flatten();

    match result {
        Some(AssignOutcome::Assigned { person_id: pid }) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "face_id": face_id, "person_id": pid })),
        ),
        Some(AssignOutcome::Unassigned { previous_person_id }) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "face_id": face_id, "person_id": null, "previous_person_id": previous_person_id })),
        ),
        Some(AssignOutcome::PersonNotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Person not found" })),
        ),
        Some(AssignOutcome::FaceNotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Face not found" })),
        ),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Database error" })),
        ),
    }
}

#[cfg(feature = "facial-recognition")]
pub async fn face_thumb(State(state): State<Arc<AppState>>, Path(face_id): Path<i64>, Query(q): Query<std::collections::HashMap<String, String>>) -> impl axum::response::IntoResponse {
    let size: u32 = q.get("size").and_then(|s| s.parse().ok()).unwrap_or(160).clamp(32, 1024);
    let pool = state.pool.clone();
    let res: Option<(Vec<u8>,)> = tokio::task::spawn_blocking(move || {
        let conn = pool.get().ok()?;
        let row = db::query::get_face_row(&conn, face_id).ok().flatten()?;
        let (_id, asset_id, bbox_json, _conf) = row;
        let (path, _w_opt, _h_opt) = db::query::get_asset_path_size(&conn, asset_id).ok().flatten()?;
        let bbox: crate::pipeline::face::FaceBbox = serde_json::from_str(&bbox_json).ok()?;
        let img = image::open(&path).ok()?;

        // Use actual image dimensions
        let img_w = img.width() as f32;
        let img_h = img.height() as f32;

        // Clamp bounding box to image bounds
        let x1 = bbox.x1.max(0.0).min(img_w);
        let y1 = bbox.y1.max(0.0).min(img_h);
        let x2 = bbox.x2.max(0.0).min(img_w);
        let y2 = bbox.y2.max(0.0).min(img_h);

        // Ensure valid bounding box
        if x2 <= x1 || y2 <= y1 {
            tracing::warn!("Invalid bounding box for face {}: x1={}, y1={}, x2={}, y2={}", face_id, x1, y1, x2, y2);
            return None;
        }

        // Add padding (20% on each side)
        let width = x2 - x1;
        let height = y2 - y1;
        let padding_x = width * 0.2;
        let padding_y = height * 0.2;

        let crop_x1 = (x1 - padding_x).max(0.0) as u32;
        let crop_y1 = (y1 - padding_y).max(0.0) as u32;
        let crop_x2 = ((x2 + padding_x).min(img_w) as u32).min(img.width());
        let crop_y2 = ((y2 + padding_y).min(img_h) as u32).min(img.height());

        if crop_x2 <= crop_x1 || crop_y2 <= crop_y1 {
            tracing::warn!("Invalid crop coordinates for face {}: x1={}, y1={}, x2={}, y2={}", face_id, crop_x1, crop_y1, crop_x2, crop_y2);
            return None;
        }

        let crop_width = crop_x2 - crop_x1;
        let crop_height = crop_y2 - crop_y1;

        if crop_width == 0 || crop_height == 0 {
            tracing::warn!("Zero-size crop for face {}", face_id);
            return None;
        }

        let crop = img.crop_imm(crop_x1, crop_y1, crop_width, crop_height);
        let resized = crop.resize_exact(size, size, image::imageops::FilterType::Triangle);
        let mut buf = Vec::new();
        if resized.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Png).is_ok() {
            Some((buf,))
        } else {
            tracing::warn!("Failed to encode face thumbnail for face {}", face_id);
            None
        }
    }).await.ok().flatten();

    match res {
        Some((bytes,)) => {
            axum::http::Response::builder()
                .status(StatusCode::OK)
                .header(axum::http::header::CONTENT_TYPE, "image/png")
                .body(axum::body::Body::from(bytes))
                .unwrap()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// Person handlers
pub async fn list_persons(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            let persons = db::query::list_persons(&conn).ok()?;
            Some(persons.into_iter().map(|(id, name, created_at)| {
                serde_json::json!({
                    "id": id,
                    "name": name,
                    "created_at": created_at
                })
            }).collect::<Vec<_>>())
        }
    }).await.ok().flatten();

    match result {
        Some(persons) => (StatusCode::OK, Json(serde_json::json!(persons))),
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

pub async fn get_person(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::query::get_person(&conn, id).ok()?
        }
    }).await.ok().flatten();

    match result {
        Some((person_id, name, created_at)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "id": person_id,
                "name": name,
                "created_at": created_at
            })))
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Person not found"}))),
    }
}

pub async fn get_person_assets(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::query::get_person_assets(&conn, id).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(assets) => (StatusCode::OK, Json(serde_json::json!({"asset_ids": assets}))),
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

#[cfg(feature = "facial-recognition")]
pub async fn get_person_face(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::query::get_person_representative_face(&conn, id).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(face_id) => (StatusCode::OK, Json(serde_json::json!({"face_id": face_id}))),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No face found for this person"}))),
    }
}

#[derive(Deserialize)]
pub struct UpdatePersonReq {
    name: Option<String>,
}

/// Utility endpoint (optional) to trigger a full recluster of all faces.
///
/// This keeps the DB schema unchanged: we clear existing person assignments,
/// then reuse stored embeddings to run clustering again using the current
/// clustering strategy.
#[cfg(feature = "facial-recognition")]
pub async fn recluster_faces(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
  let pool = state.pool.clone();
  let result = tokio::task::spawn_blocking(move || {
    let conn = pool.get().ok()?;

    // 1) Clear existing person assignments and persons
    crate::db::writer::clear_persons_and_face_assignments(&conn).ok()?;

    // 2) Load all unassigned face embeddings
    let unassigned = crate::db::query::get_unassigned_faces_with_embeddings(&conn).ok()?;
    if unassigned.is_empty() {
      return Some((0usize, 0usize));
    }

    // 3) Re-run clustering in-process using the same helper as the async workers
    // (We reuse the HDBSCAN-style wrapper from pipeline::face)
    let mut embeddings = Vec::new();
    for (face_id, _asset_id, embedding_blob, _conf, bbox_json) in unassigned {
      let emb: Vec<f32> = crate::db::query::decode_embedding_blob(&embedding_blob).ok()?;
      let bbox: crate::pipeline::face::FaceBbox = serde_json::from_str(&bbox_json).ok()?;
      embeddings.push((face_id, crate::pipeline::face::FaceEmbedding {
        embedding: emb,
        bbox,
        asset_id: 0, // asset_id not needed for clustering
      }));
    }

    let embeds_only: Vec<crate::pipeline::face::FaceEmbedding> = embeddings.iter().map(|(_, e)| e.clone()).collect();
    let min_cluster_size: usize = std::env::var("SEEN_FACE_HDBSCAN_MIN_CLUSTER_SIZE")
      .ok()
      .and_then(|v| v.parse().ok())
      .unwrap_or(3);
    let min_samples: usize = std::env::var("SEEN_FACE_HDBSCAN_MIN_SAMPLES")
      .ok()
      .and_then(|v| v.parse().ok())
      .unwrap_or(2);

    let clusters = crate::pipeline::face::cluster_faces_hdbscan(&embeds_only, min_cluster_size, min_samples);

    let mut persons_created = 0usize;
    let mut faces_assigned = 0usize;
    for cluster in clusters {
      if cluster.is_empty() {
        continue;
      }
      let person_id = match crate::db::writer::insert_person(&conn, None) {
        Ok(pid) => {
          persons_created += 1;
          pid
        }
        Err(_) => continue,
      };
      for idx in cluster {
        if let Some((face_id, _)) = embeddings.get(idx) {
          if let Ok(true) = crate::db::writer::update_face_person(&conn, *face_id, Some(person_id)) {
            faces_assigned += 1;
          }
        }
      }
    }

    Some((persons_created, faces_assigned))
  })
  .await
  .ok()
  .flatten();

  match result {
    Some((persons, faces)) => (
      StatusCode::OK,
      Json(serde_json::json!({
        "success": true,
        "persons": persons,
        "faces": faces
      })),
    ),
    None => (
      StatusCode::INTERNAL_SERVER_ERROR,
      Json(serde_json::json!({
        "success": false,
        "error": "Failed to recluster faces"
      })),
    ),
  }
}

#[cfg(feature = "facial-recognition")]
pub async fn refresh_person_profile(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            let exists = db::query::get_person(&conn, id).ok()?.is_some();
            if !exists {
                return Some(Err("Person not found".to_string()));
            }
    match db::writer::rebuild_person_profile(&conn, id) {
                Ok(profile) => Some(Ok(profile)),
                Err(e) => Some(Err(format!("Database error: {}", e))),
            }
        }
    }).await.ok().flatten();

    match result {
        Some(Ok(profile)) => {
            let payload = profile.map(|summary| serde_json::json!({
                "person_id": summary.person_id,
                "face_count": summary.face_count,
                "centroid_dim": summary.centroid_dim
            }));
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "profile": payload
                })),
            )
        }
        Some(Err(msg)) if msg == "Person not found" => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        ),
        Some(Err(msg)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": msg })),
        ),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Database error" })),
        ),
    }
}

pub async fn update_person(State(state): State<Arc<AppState>>, Path(id): Path<i64>, Json(req): Json<UpdatePersonReq>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let name = req.name;
        move || {
            let conn = pool.get().ok()?;
            db::writer::update_person_name(&conn, id, name).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(true) => (StatusCode::OK, Json(serde_json::json!({"success": true}))),
        Some(false) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Person not found"}))),
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

pub async fn delete_person(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::writer::delete_person(&conn, id).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(true) => (StatusCode::OK, Json(serde_json::json!({"success": true}))),
        Some(false) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Person not found"}))),
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

#[derive(Deserialize)]
pub struct MergePersonsReq {
    pub source_person_id: i64,
    pub target_person_id: i64,
}

pub async fn merge_persons(State(state): State<Arc<AppState>>, Json(req): Json<MergePersonsReq>) -> impl axum::response::IntoResponse {
    // Prevent merging a person into itself
    if req.source_person_id == req.target_person_id {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "Cannot merge a person into itself"
        })));
    }

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let source_id = req.source_person_id;
        let target_id = req.target_person_id;
        move || -> Option<Result<(db::writer::MergePersonsResult, Option<db::writer::PersonProfileSummary>), String>> {
            let conn = pool.get().ok()?;

            // Validate that both persons exist
            let source_exists = db::query::get_person(&conn, source_id).ok()?.is_some();
            let target_exists = db::query::get_person(&conn, target_id).ok()?.is_some();

            if !source_exists {
                return Some(Err("Source person not found".to_string()));
            }
            if !target_exists {
                return Some(Err("Target person not found".to_string()));
            }

            // Perform the merge and rebuild the profile for the target
            match db::writer::merge_persons(&conn, source_id, target_id) {
                Ok(merge_result) => {
                    let profile = match db::writer::rebuild_person_profile(&conn, target_id) {
                        Ok(p) => p,
                        Err(e) => return Some(Err(format!("Database error: {}", e))),
                    };
                    Some(Ok((merge_result, profile)))
                }
                Err(e) => Some(Err(format!("Database error: {}", e))),
            }
        }
    }).await.ok().flatten();

    match result {
        Some(Ok((merge_info, profile))) => (StatusCode::OK, Json(serde_json::json!({
            "success": true,
            "faces_merged": merge_info.faces_updated,
            "moved_face_ids": merge_info.moved_face_ids,
            "profile_refreshed": profile.map(|p| serde_json::json!({
                "person_id": p.person_id,
                "face_count": p.face_count,
                "centroid_dim": p.centroid_dim
            }))
        }))),
        Some(Err(msg)) => {
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({
                "error": msg
            })))
        },
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": "Database error"
        }))),
    }
}

#[derive(Deserialize)]
pub struct SmartMergeParams {
    #[serde(default)]
    pub threshold: Option<f32>,
}

pub async fn smart_merge_persons(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SmartMergeParams>
) -> impl axum::response::IntoResponse {
    // Check if face detection is actively processing files
    let queue_depth = state.gauges.face.load(std::sync::atomic::Ordering::Relaxed);
    if queue_depth > 0 {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Cannot merge while face detection is processing files. Please wait for the queue to empty."
        })));
    }

    // Get merge threshold (query param > env var > default 0.50)
    let merge_threshold = params.threshold
        .or_else(|| std::env::var("SEEN_FACE_SMART_MERGE_THRESHOLD").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(0.50);

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let threshold = merge_threshold;
        move || -> Option<Result<(i64, i64), String>> {
            let conn = pool.get().ok()?;

            // Check that there are at least 2 persons
            let person_count: i64 = conn.query_row("SELECT COUNT(*) FROM persons", [], |r| r.get(0)).ok()?;
            if person_count < 2 {
                return Some(Err("Need at least 2 persons to merge".to_string()));
            }

            // Perform smart merge
            match db::writer::smart_merge_persons(&conn, threshold) {
                Ok((persons_merged, faces_merged)) => Some(Ok((persons_merged, faces_merged))),
                Err(e) => Some(Err(format!("Database error: {}", e))),
            }
        }
    }).await.ok().flatten();

    match result {
        Some(Ok((persons_merged, faces_merged))) => {
            // Get remaining person count
            let remaining_count = tokio::task::spawn_blocking({
                let pool = state.pool.clone();
                move || {
                    let conn = pool.get().ok()?;
                    conn.query_row("SELECT COUNT(*) FROM persons", [], |r| r.get::<_, i64>(0)).ok()
                }
            }).await.ok().flatten().unwrap_or(0);

            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "persons_merged": persons_merged,
                "faces_merged": faces_merged,
                "remaining_persons": remaining_count
            })))
        },
        Some(Err(msg)) => {
            let status = if msg.contains("Need at least") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({
                "error": msg
            })))
        },
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": "Database error"
        }))),
    }
}

pub async fn get_asset_faces(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::query::get_asset_faces(&conn, id).ok()
        }
    }).await.ok().flatten();

    match result {
        Some(faces) => {
            let faces_json: Vec<_> = faces.into_iter().map(|(face_id, person_id, bbox_json, confidence)| {
                serde_json::json!({
                    "id": face_id,
                    "person_id": person_id,
                    "bbox": bbox_json,
                    "confidence": confidence
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!(faces_json)))
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

#[cfg(feature = "facial-recognition")]
#[derive(Deserialize)]
pub struct ClusterParams {
    #[serde(default)]
    pub epsilon: Option<f32>,
    #[serde(default)]
    pub min_samples: Option<usize>,
}

pub async fn trigger_clustering(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ClusterParams>
) -> impl axum::response::IntoResponse {
    // Check if face detection is actively processing files
    let queue_depth = state.gauges.face.load(std::sync::atomic::Ordering::Relaxed);
    if queue_depth > 0 {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Cannot cluster while face detection is processing files. Please wait for the queue to empty."
        })));
    }

    // Get clustering parameters (query params > env vars > defaults)
    // Note: Using HDBSCAN-style parameters (min_cluster_size, min_samples)
    // For backward compatibility, if min_samples is provided, use it for both
    // Otherwise, use separate env vars or defaults
    let min_cluster_size: usize = params.min_samples
        .or_else(|| std::env::var("SEEN_FACE_HDBSCAN_MIN_CLUSTER_SIZE").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(3);
    let min_samples: usize = params.min_samples
        .or_else(|| std::env::var("SEEN_FACE_HDBSCAN_MIN_SAMPLES").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(2);

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        let min_clust = min_cluster_size;
        let min_samp = min_samples;
        move || {
            let conn = pool.get().ok()?;
            // Get all face embeddings that don't have a person_id assigned
            let embeddings = db::query::get_all_face_embeddings(&conn).ok()?;
            let unassigned: Vec<_> = embeddings.iter()
                .filter(|(_, _, _, person_id)| person_id.is_none())
                .collect();

            if unassigned.is_empty() {
                return Some((0, 0, "No unassigned faces to cluster".to_string()));
            }

            // Convert database embeddings to FaceEmbedding structs
            let mut face_embeddings = Vec::new();
            let mut face_id_map = Vec::new();

            for (face_id, asset_id, embedding_blob, _) in unassigned {
                // Convert embedding bytes back to f32 vector
                let embedding: Vec<f32> = embedding_blob.chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();

                // We need bbox_json and confidence, but we'll use dummy values since we only need embeddings for clustering
                // Actually, we need to get the full face data
                let mut stmt = conn.prepare("SELECT bbox_json, confidence FROM face_embeddings WHERE id = ?").ok()?;
                let (bbox_json, _confidence): (String, f64) = stmt.query_row(
                    rusqlite::params![face_id],
                    |row| Ok((row.get(0)?, row.get(1)?))
                ).ok()?;

                let bbox: crate::pipeline::face::FaceBbox = serde_json::from_str(&bbox_json).ok()?;

                face_embeddings.push(crate::pipeline::face::FaceEmbedding {
                    embedding,
                    bbox,
                    asset_id: *asset_id,
                });
                face_id_map.push(*face_id);
            }

            // Run clustering with configurable parameters (HDBSCAN-style)
            // Priority: query params > env vars > defaults
            let min_cluster_size = min_clust;
            let min_samples = min_samp;

            tracing::info!("Clustering {} faces with min_cluster_size={}, min_samples={}", face_embeddings.len(), min_cluster_size, min_samples);

            // Diagnostic: check embedding validity and sample distances
            if !face_embeddings.is_empty() {
                // Check if embeddings are all zeros (which would cause distance=1.0 for all)
                let sample_embed = &face_embeddings[0].embedding;
                let sample_norm: f32 = sample_embed.iter().map(|x| x * x).sum::<f32>().sqrt();
                let is_zero = sample_norm < 0.001;
                let embedding_dim = sample_embed.len();

                tracing::info!("Embedding diagnostic: dim={}, norm={:.6}, is_zero={}",
                    embedding_dim, sample_norm, is_zero);

                if is_zero {
                    tracing::error!("CRITICAL: Embeddings are all zeros! ArcFace model may not be working correctly.");
                    return Some((0, 0, format!("ERROR: All embeddings are zeros (norm={:.6}). Face recognition model may not be working.", sample_norm)));
                }

                if face_embeddings.len() > 1 {
                    let sample_size = face_embeddings.len().min(10);
                    let mut distances = Vec::new();
                    for i in 0..sample_size {
                        for j in (i+1)..sample_size.min(face_embeddings.len()) {
                            let dist = crate::pipeline::face::cosine_distance(
                                &face_embeddings[i].embedding,
                                &face_embeddings[j].embedding
                            );
                            distances.push(dist);
                        }
                    }
                    if !distances.is_empty() {
                        distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                        let min_dist = distances[0];
                        let max_dist = distances[distances.len() - 1];
                        let median_dist = distances[distances.len() / 2];
                        tracing::info!("Sample face distances: min={:.3}, median={:.3}, max={:.3} (min_cluster_size={}, min_samples={})",
                            min_dist, median_dist, max_dist, min_cluster_size, min_samples);
                    }
                }
            }

            let clusters = crate::pipeline::face::cluster_faces_hdbscan(&face_embeddings, min_cluster_size, min_samples);
            tracing::info!("Clustering {} unassigned faces produced {} clusters", face_embeddings.len(), clusters.len());

            // Create persons and assign faces
            let mut persons_created = 0;
            let mut faces_assigned = 0;

            for cluster in clusters {
                if cluster.is_empty() { continue; }

                let person_id = match db::writer::insert_person(&conn, None) {
                    Ok(pid) => {
                        persons_created += 1;
                        pid
                    },
                    Err(e) => {
                        tracing::error!("Failed to create person: {}", e);
                        continue;
                    },
                };

                for idx in cluster {
                    if let Some(&face_id) = face_id_map.get(idx) {
                        match db::writer::update_face_person(&conn, face_id, Some(person_id)) {
                            Ok(true) => faces_assigned += 1,
                            Ok(false) => tracing::warn!("Failed to assign face {} to person {}", face_id, person_id),
                            Err(e) => tracing::error!("Error assigning face {} to person {}: {}", face_id, person_id, e),
                        }
                    }
                }
            }

            Some((persons_created, faces_assigned, format!("Clustered {} faces into {} persons", face_embeddings.len(), persons_created)))
        }
    }).await.ok().flatten();

    match result {
        Some((persons_created, faces_assigned, message)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "persons_created": persons_created,
                "faces_assigned": faces_assigned,
                "message": message
            })))
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error or no faces to cluster"}))),
    }
}

pub async fn clear_facial_data(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    // Check if face detection is actively processing files
    let queue_depth = state.gauges.face.load(std::sync::atomic::Ordering::Relaxed);
    if queue_depth > 0 {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Cannot clear data while face detection is processing files. Please wait for the queue to empty."
        })));
    }

    let result = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            db::writer::clear_all_facial_data(&conn).ok()
        }
    }).await.ok().flatten();

    match result {
        Some((faces_deleted, persons_deleted)) => {
            // Also clear the in-memory face index
            {
                let mut index = state.face_index.lock();
                index.clear();
            }
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "faces_deleted": faces_deleted,
                "persons_deleted": persons_deleted,
                "message": "All facial data cleared"
            })))
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Database error"}))),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FaceSettings {
    pub confidence_threshold: Option<f32>,
    pub nms_iou_threshold: Option<f32>,
    pub cluster_epsilon: Option<f32>,
    pub min_cluster_size: Option<usize>,
    pub min_samples: Option<usize>,
    pub excluded_extensions: Option<Vec<String>>,
}

pub async fn get_face_settings(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let confidence_threshold: f32 = std::env::var("SEEN_FACE_CONFIDENCE_THRESHOLD")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(0.20);
    let nms_iou_threshold: f32 = std::env::var("SEEN_FACE_NMS_IOU_THRESHOLD")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(0.4);
    let cluster_epsilon: f32 = std::env::var("SEEN_FACE_CLUSTER_EPSILON")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(0.55);
    let min_cluster_size: usize = std::env::var("SEEN_FACE_HDBSCAN_MIN_CLUSTER_SIZE")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    let min_samples: usize = std::env::var("SEEN_FACE_HDBSCAN_MIN_SAMPLES")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(2);

    // Read excluded extensions from database
    let excluded_extensions = tokio::task::spawn_blocking({
        let pool = state.pool.clone();
        move || {
            let conn = pool.get().ok()?;
            let value = db::writer::get_face_setting(&conn, "excluded_extensions").ok()??;
            // Parse comma-separated string to Vec<String>
            if value.is_empty() {
                None
            } else {
                Some(value.split(',').map(|s| s.trim().to_string()).collect::<Vec<String>>())
            }
        }
    }).await.ok().flatten();

    (StatusCode::OK, Json(FaceSettings {
        confidence_threshold: Some(confidence_threshold),
        nms_iou_threshold: Some(nms_iou_threshold),
        cluster_epsilon: Some(cluster_epsilon),
        min_cluster_size: Some(min_cluster_size),
        min_samples: Some(min_samples),
        excluded_extensions,
    }))
}

pub async fn update_face_settings(State(state): State<Arc<AppState>>, Json(payload): Json<FaceSettings>) -> impl IntoResponse {
    if let Some(v) = payload.confidence_threshold {
        std::env::set_var("SEEN_FACE_CONFIDENCE_THRESHOLD", v.to_string());
    }
    if let Some(v) = payload.nms_iou_threshold {
        std::env::set_var("SEEN_FACE_NMS_IOU_THRESHOLD", v.to_string());
    }
    if let Some(v) = payload.cluster_epsilon {
        std::env::set_var("SEEN_FACE_CLUSTER_EPSILON", v.to_string());
    }
    if let Some(v) = payload.min_cluster_size {
        std::env::set_var("SEEN_FACE_HDBSCAN_MIN_CLUSTER_SIZE", v.to_string());
    }
    if let Some(v) = payload.min_samples {
        std::env::set_var("SEEN_FACE_HDBSCAN_MIN_SAMPLES", v.to_string());
    }

    // Save excluded extensions to database
    if let Some(excluded) = payload.excluded_extensions {
        let pool = state.pool.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(conn) = pool.get() {
                let value = excluded.join(",");
                let _ = db::writer::set_face_setting(&conn, "excluded_extensions", &value);
            }
        }).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"status": "updated"})))
}


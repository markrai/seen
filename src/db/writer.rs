use anyhow::Result;
use rusqlite::{params, Connection, Transaction};
use tokio::sync::mpsc::{Receiver, Sender};
use crate::pipeline::thumb::ThumbJob;
use crate::pipeline::QueueGauges;
#[cfg(feature = "facial-recognition")]
use crate::pipeline::face::{FaceJob, FaceProcessor};
use std::sync::Arc;
use std::time::{Duration, Instant};
use crate::stats::Stats;
#[cfg(feature = "facial-recognition")]
use std::path::PathBuf;
#[cfg(feature = "facial-recognition")]
use parking_lot::Mutex;

#[derive(Clone, Debug)]
pub struct DbWriteItem {
    pub path: String,
    pub dirname: String,
    pub filename: String,
    pub ext: String,
    pub size_bytes: i64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub sha256: Option<Vec<u8>>,
    pub xxh64: Option<i64>,
    pub taken_at: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<i64>,
    pub fnumber: Option<f64>,
    pub exposure: Option<f64>,
    pub video_codec: Option<String>,
    pub mime: String,
    pub flags: i64,
}

fn upsert_item(tx: &Transaction<'_>, it: &DbWriteItem) -> Result<i64> {
    // Try RETURNING first (SQLite 3.35.0+ supports RETURNING with ON CONFLICT)
    let sql = "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, sha256, xxh64, taken_at, width, height, duration_ms, camera_make, camera_model, lens_model, iso, fnumber, exposure, video_codec, mime, flags)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
         ON CONFLICT(path) DO UPDATE SET dirname=excluded.dirname, filename=excluded.filename, ext=excluded.ext, size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns, ctime_ns=excluded.ctime_ns, sha256=excluded.sha256, xxh64=excluded.xxh64, taken_at=excluded.taken_at, width=excluded.width, height=excluded.height, duration_ms=excluded.duration_ms, camera_make=excluded.camera_make, camera_model=excluded.camera_model, lens_model=excluded.lens_model, iso=excluded.iso, fnumber=excluded.fnumber, exposure=excluded.exposure, video_codec=excluded.video_codec, mime=excluded.mime, flags=excluded.flags
         RETURNING id";
    
    // Try RETURNING (SQLite 3.35.0+)
    match tx.query_row(sql, params![
        it.path,
        it.dirname,
        it.filename,
        it.ext,
        it.size_bytes,
        it.mtime_ns,
        it.ctime_ns,
        it.sha256,
        it.xxh64,
        it.taken_at,
        it.width,
        it.height,
        it.duration_ms,
        it.camera_make,
        it.camera_model,
        it.lens_model,
        it.iso,
        it.fnumber,
        it.exposure,
        it.video_codec,
        it.mime,
        it.flags,
    ], |r| r.get::<_, i64>(0)) {
        Ok(id) => Ok(id),
        Err(_) => {
            // Fallback: execute then query (for older SQLite versions)
            tx.execute(
                "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, sha256, xxh64, taken_at, width, height, duration_ms, camera_make, camera_model, lens_model, iso, fnumber, exposure, video_codec, mime, flags)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
                 ON CONFLICT(path) DO UPDATE SET dirname=excluded.dirname, filename=excluded.filename, ext=excluded.ext, size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns, ctime_ns=excluded.ctime_ns, sha256=excluded.sha256, xxh64=excluded.xxh64, taken_at=excluded.taken_at, width=excluded.width, height=excluded.height, duration_ms=excluded.duration_ms, camera_make=excluded.camera_make, camera_model=excluded.camera_model, lens_model=excluded.lens_model, iso=excluded.iso, fnumber=excluded.fnumber, exposure=excluded.exposure, video_codec=excluded.video_codec, mime=excluded.mime, flags=excluded.flags",
                params![
                    it.path,
                    it.dirname,
                    it.filename,
                    it.ext,
                    it.size_bytes,
                    it.mtime_ns,
                    it.ctime_ns,
                    it.sha256,
                    it.xxh64,
                    it.taken_at,
                    it.width,
                    it.height,
                    it.duration_ms,
                    it.camera_make,
                    it.camera_model,
                    it.lens_model,
                    it.iso,
                    it.fnumber,
                    it.exposure,
                    it.video_codec,
                    it.mime,
                    it.flags,
                ],
            )?;
            tx.query_row("SELECT id FROM assets WHERE path = ?", params![it.path], |r| r.get(0))
                .map_err(|e| e.into())
        }
    }
}

#[cfg(feature = "facial-recognition")]
pub fn run_writer(handle: tokio::runtime::Handle, rx: Receiver<DbWriteItem>, conn: Connection, fts_batch_size: usize, thumb_tx: Sender<ThumbJob>, gauges: Arc<QueueGauges>, stats: Option<Arc<Stats>>, face_tx: Option<Sender<FaceJob>>, face_processor: Option<Arc<Mutex<FaceProcessor>>>, db_path: PathBuf) -> Result<()> {
    run_writer_impl(handle, rx, conn, fts_batch_size, thumb_tx, gauges, stats, face_tx, face_processor, Some(db_path))
}

#[cfg(not(feature = "facial-recognition"))]
pub fn run_writer(handle: tokio::runtime::Handle, mut rx: Receiver<DbWriteItem>, conn: Connection, fts_batch_size: usize, thumb_tx: Sender<ThumbJob>, gauges: Arc<QueueGauges>, stats: Option<Arc<Stats>>) -> Result<()> {
    run_writer_impl(handle, rx, conn, fts_batch_size, thumb_tx, gauges, stats)
}

fn run_writer_impl(handle: tokio::runtime::Handle, mut rx: Receiver<DbWriteItem>, conn: Connection, fts_batch_size: usize, thumb_tx: Sender<ThumbJob>, gauges: Arc<QueueGauges>, stats: Option<Arc<Stats>>, #[cfg(feature = "facial-recognition")] face_tx: Option<Sender<FaceJob>>, #[cfg(feature = "facial-recognition")] face_processor: Option<Arc<Mutex<FaceProcessor>>>, #[cfg(feature = "facial-recognition")] db_path: Option<PathBuf>) -> Result<()> {
    let mut buf: Vec<DbWriteItem> = Vec::with_capacity(4096);
    let mut fts_rows: Vec<(i64, String, String, String, Option<Vec<u8>>, String)> = Vec::with_capacity(4096);
    let mut last_flush = Instant::now();
    const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
    const BATCH_SIZE: usize = 500;  // Batch size for efficient transaction processing
    
    // Enter the runtime context
    let _guard = handle.enter();
    
    loop {
        let elapsed = last_flush.elapsed();
        let timeout = if elapsed >= FLUSH_INTERVAL {
            Duration::from_millis(100)  // Short timeout to flush immediately
        } else {
            FLUSH_INTERVAL - elapsed
        };
        
        match handle.block_on(tokio::time::timeout(timeout, rx.recv())) {
            Ok(Some(item)) => {
                gauges.db_write.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                buf.push(item);
                
                let should_flush = buf.len() >= BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL;
                if should_flush && !buf.is_empty() {
                    let n = buf.len();
                    let bytes: u64 = buf.iter().map(|it| it.size_bytes as u64).sum();
                    match commit_batch(&conn, &mut buf, &mut fts_rows, fts_batch_size, thumb_tx.clone(), &gauges, #[cfg(feature = "facial-recognition")] face_tx.as_ref(), #[cfg(feature = "facial-recognition")] face_processor.as_ref(), #[cfg(feature = "facial-recognition")] db_path.as_ref()) {
                        Ok(_) => {
                            // Track files committed to SQLite (this is where files are actually committed in this codebase)
                            if let Some(s) = &stats {
                                s.inc_files_committed(n as u64);
                                s.inc_bytes(bytes);
                            }
                        }
                        Err(e) => {
                            eprintln!("ERROR committing batch: {:?}", e);
                            return Err(e);
                        }
                    }
                    last_flush = Instant::now();
                }
            }
            Ok(None) => break,  // Channel closed
            Err(_) => {
                // Timeout - check if we should flush
                if !buf.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL {
                    let n = buf.len();
                    let bytes: u64 = buf.iter().map(|it| it.size_bytes as u64).sum();
                    match commit_batch(&conn, &mut buf, &mut fts_rows, fts_batch_size, thumb_tx.clone(), &gauges, #[cfg(feature = "facial-recognition")] face_tx.as_ref(), #[cfg(feature = "facial-recognition")] face_processor.as_ref(), #[cfg(feature = "facial-recognition")] db_path.as_ref()) {
                        Ok(_) => {
                            // Track files committed to SQLite (this is where files are actually committed in this codebase)
                            if let Some(s) = &stats {
                                s.inc_files_committed(n as u64);
                                s.inc_bytes(bytes);
                            }
                        }
                        Err(e) => {
                            eprintln!("ERROR committing timeout batch: {:?}", e);
                            return Err(e);
                        }
                    }
                    last_flush = Instant::now();
                }
            }
        }
    }
    if !buf.is_empty() {
        let n = buf.len();
        let bytes: u64 = buf.iter().map(|it| it.size_bytes as u64).sum();
        match commit_batch(&conn, &mut buf, &mut fts_rows, fts_batch_size, thumb_tx.clone(), &gauges, #[cfg(feature = "facial-recognition")] face_tx.as_ref(), #[cfg(feature = "facial-recognition")] face_processor.as_ref(), #[cfg(feature = "facial-recognition")] db_path.as_ref()) {
            Ok(_) => {
                // Track files committed to SQLite (this is where files are actually committed in this codebase)
                if let Some(s) = &stats {
                    s.inc_files_committed(n as u64);
                    s.inc_bytes(bytes);
                }
            }
            Err(e) => {
                eprintln!("ERROR committing final batch: {:?}", e);
                return Err(e);
            }
        }
    }
    Ok(())
}

fn commit_batch(conn: &Connection, buf: &mut Vec<DbWriteItem>, fts_rows: &mut Vec<(i64, String, String, String, Option<Vec<u8>>, String)>, _fts_batch_size: usize, thumb_tx: Sender<ThumbJob>, gauges: &QueueGauges, #[cfg(feature = "facial-recognition")] face_tx: Option<&Sender<FaceJob>>, #[cfg(feature = "facial-recognition")] face_processor: Option<&Arc<Mutex<FaceProcessor>>>, #[cfg(feature = "facial-recognition")] db_path: Option<&PathBuf>) -> Result<()> {
    #[cfg(feature = "facial-recognition")]
    let mut image_assets_for_face_detection: Vec<(i64, PathBuf, String)> = Vec::new();
    
    let tx = conn.unchecked_transaction()?;
    for it in buf.drain(..) {
        match upsert_item(&tx, &it) {
            Ok(id) => {
                fts_rows.push((id, it.filename.clone(), it.dirname.clone(), it.path.clone(), it.sha256.clone(), it.mime.clone()));
                
                // Collect image assets for potential face detection
                #[cfg(feature = "facial-recognition")]
                if it.mime.starts_with("image/") {
                    image_assets_for_face_detection.push((id, PathBuf::from(&it.path), it.ext.clone()));
                }
            }
            Err(e) => {
                eprintln!("ERROR upserting item {:?}: {:?}", it.path, e);
                return Err(e);
            }
        }
    }
    tx.commit()?;
    if !fts_rows.is_empty() {
        let tx2 = conn.unchecked_transaction()?;
        {
            let mut stmt = tx2.prepare("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (?1,?2,?3,?4)")?;
            for chunk in fts_rows.drain(..).collect::<Vec<_>>() {
                match stmt.execute(params![chunk.0, chunk.1, chunk.2, chunk.3]) {
                    Ok(_) => {
                        if let Some(sha) = chunk.4 {
                            // Only queue thumbnail job if SHA256 is available and not empty
                            if !sha.is_empty() {
                                let _ = thumb_tx.try_send(ThumbJob {
                                    id: chunk.0,
                                    path: chunk.3.clone(),
                                    sha256_hex: hex::encode(&sha),
                                    mime: chunk.5.clone(),
                                });
                                gauges.thumb.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            } else {
                                tracing::warn!("Skipping thumbnail generation for asset {}: SHA256 is empty", chunk.0);
                            }
                        } else {
                            tracing::warn!("Skipping thumbnail generation for asset {}: SHA256 is None", chunk.0);
                        }
                    }
                    Err(e) => {
                        eprintln!("ERROR inserting FTS row for id {}: {:?}", chunk.0, e);
                        return Err(e.into());
                    }
                }
            }
        }
        tx2.commit()?;
    }
    
    // Auto-queue image assets for face detection if enabled
    #[cfg(feature = "facial-recognition")]
    if let (Some(face_tx_ref), Some(processor_ref), Some(_db_path_ref)) = (face_tx, face_processor, db_path) {
        // Check if face detection is enabled
        let face_detection_enabled = match get_face_detection_enabled(conn) {
            Ok(enabled) => enabled,
            Err(_) => false,
        };
        
        if !face_detection_enabled {
            return Ok(());
        }
        
        // Check if models are loaded
        let models_loaded = {
            let guard = processor_ref.lock();
            guard.scrfd_loaded() && guard.arcface_loaded()
        };
        
        if !models_loaded {
            return Ok(());
        }
        
        // Get excluded extensions from database
        let excluded_extensions: Vec<String> = match get_face_setting(conn, "excluded_extensions") {
            Ok(Some(value)) => value.split(',').map(|s| s.trim().to_lowercase()).collect(),
            _ => Vec::new(),
        };
        
        // Default allowed extensions (if no exclusions set)
        let default_allowed = vec!["jpg", "jpeg", "png", "webp", "heic", "heif", "tiff", "tif"];
        
        // Determine allowed extensions
        let allowed_exts: Vec<&str> = if excluded_extensions.is_empty() {
            default_allowed
        } else {
            let all_image_exts = vec![
                "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "heic", "heif",
                "raw", "cr2", "nef", "orf", "sr2", "arw", "dng", "rw2", "raf", "pef",
                "srw", "3fr", "x3f", "mrw", "mef", "mos", "erf", "dcr", "kdc", "fff",
                "iiq", "rwl", "r3d", "ari", "bay", "cap", "data", "dcs", "drf", "eip",
                "k25", "mdc", "nrw", "obm", "ptx", "pxn", "rwz", "srf", "crw"
            ];
            all_image_exts.into_iter()
                .filter(|ext| !excluded_extensions.contains(&ext.to_lowercase()))
                .collect()
        };
        
        // Check each image asset and queue if conditions are met
        for (asset_id, path, ext) in image_assets_for_face_detection {
            // Normalize extension (lowercase, remove leading dot)
            let ext_normalized = ext.trim_start_matches('.').to_lowercase();
            
            // Check if extension is allowed
            if !allowed_exts.iter().any(|&allowed| allowed.to_lowercase() == ext_normalized) {
                continue;
            }
            
            // Check if asset already has face embeddings
            let has_existing_faces: bool = match conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM face_embeddings WHERE asset_id = ?)",
                params![asset_id],
                |row| row.get(0)
            ) {
                Ok(has) => has,
                Err(_) => false,
            };
            
            if has_existing_faces {
                continue;
            }
            
            // Queue for face detection
            if let Err(_) = face_tx_ref.try_send(FaceJob { asset_id, image_path: path }) {
                // Channel is full or closed - skip this file, it will be picked up later
                continue;
            }
            gauges.face.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    
    Ok(())
}

// Face and Person write functions
#[cfg(feature = "facial-recognition")]
pub fn insert_person(conn: &Connection, name: Option<String>) -> Result<i64> {
    let created_at = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO persons (name, created_at) VALUES (?1, ?2)",
        params![name, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

#[cfg(feature = "facial-recognition")]
pub fn update_person_name(conn: &Connection, person_id: i64, name: Option<String>) -> Result<bool> {
    let updated = conn.execute(
        "UPDATE persons SET name = ?1 WHERE id = ?2",
        params![name, person_id],
    )?;
    Ok(updated > 0)
}

#[cfg(feature = "facial-recognition")]
pub fn delete_person(conn: &Connection, person_id: i64) -> Result<bool> {
    // First, unlink all face embeddings from this person
    conn.execute(
        "UPDATE face_embeddings SET person_id = NULL WHERE person_id = ?1",
        params![person_id],
    )?;
    
    // Then delete the person
    let deleted = conn.execute("DELETE FROM persons WHERE id = ?1", params![person_id])?;
    Ok(deleted > 0)
}

#[cfg(feature = "facial-recognition")]
pub struct MergePersonsResult {
    pub faces_updated: i64,
    pub moved_face_ids: Vec<i64>,
}

#[cfg(feature = "facial-recognition")]
pub fn merge_persons(conn: &Connection, source_person_id: i64, target_person_id: i64) -> Result<MergePersonsResult> {
    // Use a transaction to ensure atomicity
    let tx = conn.unchecked_transaction()?;

    let moved_face_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM face_embeddings WHERE person_id = ?1")?;
        let rows = stmt.query_map(params![source_person_id], |row| row.get::<_, i64>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        ids
    };
    
    // Update all face embeddings from source person to target person
    let faces_updated = tx.execute(
        "UPDATE face_embeddings SET person_id = ?1 WHERE person_id = ?2",
        params![target_person_id, source_person_id],
    )?;
    
    // Delete the person_profiles entry for the source person
    // (must be done before deleting the person due to foreign key constraint)
    tx.execute("DELETE FROM person_profiles WHERE person_id = ?1", params![source_person_id])?;
    
    // Delete the source person
    tx.execute("DELETE FROM persons WHERE id = ?1", params![source_person_id])?;
    
    // Commit the transaction
    tx.commit()?;
    
    Ok(MergePersonsResult {
        faces_updated: faces_updated as i64,
        moved_face_ids,
    })
}

#[cfg(feature = "facial-recognition")]
fn encode_embedding(embedding: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(embedding.len() * 4);
    for value in embedding {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[cfg(feature = "facial-recognition")]
#[derive(Debug, Clone)]
pub struct PersonProfileSummary {
    pub person_id: i64,
    pub face_count: usize,
    pub centroid_dim: usize,
}

#[cfg(feature = "facial-recognition")]
pub fn rebuild_person_profile(conn: &Connection, person_id: i64) -> Result<Option<PersonProfileSummary>> {
    use crate::db::query;

    let embeddings = query::get_person_face_embeddings(conn, person_id)?;
    if embeddings.is_empty() {
        conn.execute("DELETE FROM person_profiles WHERE person_id = ?1", params![person_id])?;
        return Ok(None);
    }

    let mut centroid = vec![0f32; embeddings[0].len()];
    let mut used = 0usize;

    for emb in embeddings.iter() {
        if emb.len() != centroid.len() {
            continue;
        }
        for (idx, value) in emb.iter().enumerate() {
            centroid[idx] += value;
        }
        used += 1;
    }

    if used == 0 {
        conn.execute("DELETE FROM person_profiles WHERE person_id = ?1", params![person_id])?;
        return Ok(None);
    }

    let inv = 1.0f32 / used as f32;
    for value in centroid.iter_mut() {
        *value *= inv;
    }

    let norm = centroid.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in centroid.iter_mut() {
            *value /= norm;
        }
    }

    let blob = encode_embedding(&centroid);
    conn.execute(
        "INSERT INTO person_profiles (person_id, centroid_blob, face_count, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now'))
         ON CONFLICT(person_id) DO UPDATE SET centroid_blob = excluded.centroid_blob, face_count = excluded.face_count, updated_at = excluded.updated_at",
        params![person_id, blob, used as i64],
    )?;

    Ok(Some(PersonProfileSummary {
        person_id,
        face_count: used,
        centroid_dim: centroid.len(),
    }))
}

#[cfg(all(test, feature = "facial-recognition"))]
mod tests {
    use super::*;
    use crate::db::schema;

    fn insert_dummy_asset(conn: &Connection, asset_id: i64) {
        conn.execute(
            "INSERT INTO assets (id, path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags)
             VALUES (?1, ?2, ?3, ?4, ?5, 123, 0, 0, 'image/jpeg', 0)",
            params![asset_id, format!("asset-{asset_id}"), ".", format!("asset-{asset_id}.jpg"), ".jpg"],
        )
        .unwrap();
    }

    #[test]
    fn rebuilds_profile_for_person() {
        let conn = Connection::open_in_memory().unwrap();
        schema::apply_schema(&conn).unwrap();
        insert_dummy_asset(&conn, 1);
        insert_dummy_asset(&conn, 2);

        let person_id = insert_person(&conn, Some("Test".to_string())).unwrap();
        insert_face_embedding(&conn, 1, Some(person_id), &[1.0, 0.0, 0.0], "{}", 0.9).unwrap();
        insert_face_embedding(&conn, 2, Some(person_id), &[0.0, 1.0, 0.0], "{}", 0.8).unwrap();

        let profile = rebuild_person_profile(&conn, person_id).unwrap().unwrap();
        assert_eq!(profile.person_id, person_id);
        assert_eq!(profile.face_count, 2);
        assert_eq!(profile.centroid_dim, 3);
    }
}

#[cfg(feature = "facial-recognition")]
pub fn smart_merge_persons(conn: &Connection, merge_threshold: f32) -> Result<(i64, i64)> {
    use crate::db::query;
    use crate::pipeline::face::cosine_distance;
    
    // Get all persons
    let persons = query::list_persons(conn)?;
    if persons.len() < 2 {
        return Ok((0, 0));
    }
    
    // Ensure all persons have profiles before starting
    // This ensures centroids are available for fast comparison
    tracing::info!("Ensuring person profiles are built before smart merge...");
    for (person_id, _, _) in &persons {
        // Check if profile exists
        let profile_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM person_profiles WHERE person_id = ?)",
            params![person_id],
            |row| row.get(0)
        ).unwrap_or(false);
        
        if !profile_exists {
            // Rebuild profile if missing
            if let Err(e) = rebuild_person_profile(conn, *person_id) {
                tracing::warn!("Failed to build profile for person {}: {}", person_id, e);
            }
        }
    }
    
    // Use a transaction for atomicity
    let tx = conn.unchecked_transaction()?;
    
    let mut persons_merged = 0i64;
    let mut faces_merged = 0i64;
    let mut merged_person_ids = std::collections::HashSet::new();
    
    // Helper function to get centroid, computing on-the-fly if needed
    let get_centroid = |person_id: i64| -> Option<Vec<f32>> {
        // Try to get from profile first
        match query::get_person_centroid(&tx, person_id) {
            Ok(Some(centroid)) => Some(centroid),
            Ok(None) => {
                // Profile doesn't exist, compute centroid from embeddings
                match query::get_person_face_embeddings(&tx, person_id) {
                    Ok(embeddings) if !embeddings.is_empty() => {
                        // Compute centroid
                        let mut centroid = vec![0f32; embeddings[0].len()];
                        let mut used = 0usize;
                        
                        for emb in &embeddings {
                            if emb.len() != centroid.len() {
                                continue;
                            }
                            for (idx, value) in emb.iter().enumerate() {
                                centroid[idx] += value;
                            }
                            used += 1;
                        }
                        
                        if used == 0 {
                            return None;
                        }
                        
                        // Average
                        let inv = 1.0f32 / used as f32;
                        for value in centroid.iter_mut() {
                            *value *= inv;
                        }
                        
                        // Normalize
                        let norm = centroid.iter().map(|v| v * v).sum::<f32>().sqrt();
                        if norm > 0.0 {
                            for value in centroid.iter_mut() {
                                *value /= norm;
                            }
                        }
                        
                        Some(centroid)
                    }
                    _ => None
                }
            }
            Err(e) => {
                tracing::warn!("Failed to get centroid for person {}: {}", person_id, e);
                None
            }
        }
    };
    
    // For each pair of persons (i, j where i < j)
    for i in 0..persons.len() {
        let person_i_id = persons[i].0;
        if merged_person_ids.contains(&person_i_id) {
            continue;
        }
        
        // Get centroid for person i (mutable so we can update it after merges)
        let mut centroid_i = match get_centroid(person_i_id) {
            Some(c) => c,
            None => continue, // Skip persons with no faces/centroid
        };
        
        // Get face count for person i
        let mut face_count_i: i64 = tx.query_row(
            "SELECT COUNT(*) FROM face_embeddings WHERE person_id = ?",
            params![person_i_id],
            |row| row.get(0)
        )?;
        
        for j in (i + 1)..persons.len() {
            let person_j_id = persons[j].0;
            if merged_person_ids.contains(&person_j_id) {
                continue;
            }
            
            // Get centroid for person j
            let centroid_j = match get_centroid(person_j_id) {
                Some(c) => c,
                None => continue, // Skip persons with no faces/centroid
            };
            
            // Compute cosine distance between centroids (O(1) instead of O(n×m))
            let distance = cosine_distance(&centroid_i, &centroid_j);
            
            // If distance < merge_threshold, merge
            if distance < merge_threshold {
                // Get face count for person j
                let face_count_j: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM face_embeddings WHERE person_id = ?",
                    params![person_j_id],
                    |row| row.get(0)
                )?;
                
                // Merge smaller person into larger person, or j into i if equal
                let (source_id, target_id) = if face_count_j > face_count_i {
                    (person_i_id, person_j_id)
                } else {
                    (person_j_id, person_i_id)
                };
                
                // Update all face embeddings from source to target
                let faces_updated = tx.execute(
                    "UPDATE face_embeddings SET person_id = ?1 WHERE person_id = ?2",
                    params![target_id, source_id],
                )?;
                
                // Delete the person_profiles entry for the source person
                // (must be done before deleting the person due to foreign key constraint)
                tx.execute("DELETE FROM person_profiles WHERE person_id = ?1", params![source_id])?;
                
                // Delete the source person
                tx.execute("DELETE FROM persons WHERE id = ?1", params![source_id])?;
                
                persons_merged += 1;
                faces_merged += faces_updated as i64;
                merged_person_ids.insert(source_id);
                
                // If we merged j into i, person i now has more faces
                // Reload centroid_i for next comparisons
                if source_id == person_j_id {
                    // Person j was merged into i, so reload centroid_i
                    match get_centroid(person_i_id) {
                        Some(new_centroid) => {
                            centroid_i = new_centroid; // Update for next comparisons
                        }
                        None => {
                            // If no centroid, break inner loop
                            break;
                        }
                    }
                    face_count_i = tx.query_row(
                        "SELECT COUNT(*) FROM face_embeddings WHERE person_id = ?",
                        params![person_i_id],
                        |row| row.get(0)
                    )?;
                    // Continue checking other j's with updated person i
                } else {
                    // Person i was merged into j, so person i no longer exists
                    break; // Break inner loop, continue with next person_i (which will be skipped)
                }
            }
        }
    }
    
    // Commit the transaction
    tx.commit()?;
    
    // Rebuild person profiles for all remaining persons after merging
    tracing::info!("Rebuilding person profiles after smart merge...");
    let remaining_persons = query::list_persons(conn)?;
    for (person_id, _, _) in remaining_persons {
        if let Err(e) = rebuild_person_profile(conn, person_id) {
            tracing::warn!("Failed to rebuild profile for person {}: {}", person_id, e);
        }
    }
    
    tracing::info!("Smart merge completed: {} persons merged, {} faces moved", persons_merged, faces_merged);
    Ok((persons_merged, faces_merged))
}

#[cfg(feature = "facial-recognition")]
pub fn insert_face_embedding(
    conn: &Connection,
    asset_id: i64,
    person_id: Option<i64>,
    embedding: &[f32],
    bbox_json: &str,
    confidence: f64,
) -> Result<i64> {
    // Convert embedding to bytes (little-endian f32)
    let embedding_bytes: Vec<u8> = embedding.iter()
        .flat_map(|f| f.to_le_bytes().to_vec())
        .collect();
    
    conn.execute(
        "INSERT INTO face_embeddings (asset_id, person_id, embedding_blob, bbox_json, confidence) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![asset_id, person_id, embedding_bytes, bbox_json, confidence],
    )?;
    Ok(conn.last_insert_rowid())
}

#[cfg(feature = "facial-recognition")]
pub fn update_face_person(conn: &Connection, face_id: i64, person_id: Option<i64>) -> Result<bool> {
    let updated = conn.execute(
        "UPDATE face_embeddings SET person_id = ?1 WHERE id = ?2",
        params![person_id, face_id],
    )?;
    Ok(updated > 0)
}

#[cfg(feature = "facial-recognition")]
pub fn delete_face_embedding(conn: &Connection, face_id: i64) -> Result<bool> {
    let deleted = conn.execute("DELETE FROM face_embeddings WHERE id = ?1", params![face_id])?;
    Ok(deleted > 0)
}

#[cfg(feature = "facial-recognition")]
pub fn delete_asset_faces(conn: &Connection, asset_id: i64) -> Result<usize> {
    let deleted = conn.execute("DELETE FROM face_embeddings WHERE asset_id = ?1", params![asset_id])?;
    Ok(deleted)
}

#[cfg(feature = "facial-recognition")]
pub fn clear_all_facial_data(conn: &Connection) -> Result<(usize, usize)> {
    // Use a transaction to ensure atomic deletion
    let tx = conn.unchecked_transaction()?;
    
    // Delete in order: person_profiles -> face_embeddings -> persons
    // (person_profiles has foreign key to persons)
    let _ = tx.execute("DELETE FROM person_profiles", []);
    let faces_deleted = tx.execute("DELETE FROM face_embeddings", [])?;
    let persons_deleted = tx.execute("DELETE FROM persons", [])?;
    
    // Commit the transaction
    tx.commit()?;
    
    // Force WAL checkpoint to ensure changes are visible immediately
    conn.pragma_update(None, "wal_checkpoint", "FULL")?;
    
    Ok((faces_deleted, persons_deleted))
}

#[cfg(feature = "facial-recognition")]
pub fn clear_persons_and_face_assignments(conn: &Connection) -> Result<()> {
    // Unlink all face embeddings from persons
    conn.execute("UPDATE face_embeddings SET person_id = NULL", [])?;
    // Delete all persons
    conn.execute("DELETE FROM persons", [])?;
    Ok(())
}

#[cfg(feature = "facial-recognition")]
pub fn get_face_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM face_settings WHERE key = ?1")?;
    let value = stmt.query_row(params![key], |row| row.get::<_, String>(0)).ok();
    Ok(value)
}

#[cfg(feature = "facial-recognition")]
pub fn set_face_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR REPLACE INTO face_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value, now],
    )?;
    Ok(())
}

#[cfg(feature = "facial-recognition")]
pub fn get_face_detection_enabled(conn: &Connection) -> Result<bool> {
    let value = get_face_setting(conn, "face_detection_enabled")?;
    Ok(value.map(|v| v == "true").unwrap_or(false))
}

#[cfg(feature = "facial-recognition")]
pub fn set_face_detection_enabled(conn: &Connection, enabled: bool) -> Result<()> {
    set_face_setting(conn, "face_detection_enabled", if enabled { "true" } else { "false" })
}

pub fn clear_all_data(conn: &Connection) -> Result<(usize, usize, usize)> {
    // Use a transaction to ensure atomic deletion
    let tx = conn.unchecked_transaction()?;
    
    // Delete in order: face_embeddings -> persons -> fts_assets -> assets
    let faces_deleted;
    let persons_deleted;
    
    #[cfg(feature = "facial-recognition")]
    {
        faces_deleted = tx.execute("DELETE FROM face_embeddings", [])?;
        persons_deleted = tx.execute("DELETE FROM persons", [])?;
    }
    #[cfg(not(feature = "facial-recognition"))]
    {
        faces_deleted = 0;
        persons_deleted = 0;
    }
    
    // Clear FTS table - delete all rows before deleting assets
    // For contentless FTS5 tables, we need to delete by rowid
    // Get all asset IDs first, then delete from FTS
    let asset_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM assets")?;
        let rows = stmt.query_map([], |row| {
            Ok(row.get::<_, i64>(0)?)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    
    // Delete from FTS table using rowids
    for asset_id in &asset_ids {
        let _ = tx.execute("DELETE FROM fts_assets WHERE rowid = ?1", params![asset_id]);
    }
    
    // Delete all assets
    let assets_deleted = tx.execute("DELETE FROM assets", [])?;
    
    // Commit the transaction
    tx.commit()?;
    
    // Force WAL checkpoint to ensure changes are visible immediately
    // This ensures all changes are written to the main database file
    conn.pragma_update(None, "wal_checkpoint", "FULL")?;
    
    Ok((assets_deleted, faces_deleted, persons_deleted))
}

/// Add a scan path
pub fn add_scan_path(conn: &Connection, path: &str) -> Result<i64> {
    let created_at = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO scan_paths (path, created_at) VALUES (?1, ?2)",
        params![path, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Remove a scan path
pub fn remove_scan_path(conn: &Connection, path: &str) -> Result<bool> {
    let deleted = conn.execute("DELETE FROM scan_paths WHERE path = ?1", params![path])?;
    Ok(deleted > 0)
}

/// Delete all assets that start with the given path prefix
pub fn delete_assets_by_path_prefix(conn: &Connection, path_prefix: &str) -> Result<(usize, usize)> {
    let tx = conn.unchecked_transaction()?;
    
    // Normalize path prefix - ensure it ends with / for directory matching
    let normalized_prefix = if path_prefix.ends_with('/') || path_prefix.ends_with('\\') {
        path_prefix.to_string()
    } else {
        // Try both / and \ as separators
        format!("{}/", path_prefix)
    };
    
    // Get all asset IDs that match the path prefix (path starts with prefix or equals prefix)
    // Use ESCAPE to handle special characters in LIKE
    let like_pattern = format!("{}%", normalized_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"));
    let asset_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM assets WHERE path LIKE ?1 ESCAPE '\\' OR path = ?2")?;
        let rows = stmt.query_map(params![like_pattern, path_prefix], |row| {
            Ok(row.get::<_, i64>(0)?)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    
    #[cfg(feature = "facial-recognition")]
    let faces_deleted = {
        let mut deleted = 0;
        // Delete face embeddings for these assets
        for asset_id in &asset_ids {
            deleted += crate::db::writer::delete_asset_faces(&tx, *asset_id).unwrap_or(0);
        }
        deleted
    };
    #[cfg(not(feature = "facial-recognition"))]
    let faces_deleted = 0;
    
    // Delete from FTS table
    for asset_id in &asset_ids {
        let _ = tx.execute("DELETE FROM fts_assets WHERE rowid = ?1", params![asset_id]);
    }
    
    // Delete from assets table
    let assets_deleted = tx.execute("DELETE FROM assets WHERE path LIKE ?1 ESCAPE '\\' OR path = ?2", params![like_pattern, path_prefix])?;
    
    tx.commit()?;
    
    Ok((assets_deleted, faces_deleted))
}

/// Create a new album
pub fn create_album(conn: &Connection, name: &str, description: Option<&str>) -> Result<i64> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO albums (name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, description, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Update an album's name and/or description
pub fn update_album(conn: &Connection, id: i64, name: Option<&str>, description: Option<&str>) -> Result<bool> {
    let now = chrono::Utc::now().timestamp();
    
    if let Some(name) = name {
        if let Some(description) = description {
            let updated = conn.execute(
                "UPDATE albums SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
                params![name, description, now, id],
            )?;
            Ok(updated > 0)
        } else {
            let updated = conn.execute(
                "UPDATE albums SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, now, id],
            )?;
            Ok(updated > 0)
        }
    } else if let Some(description) = description {
        let updated = conn.execute(
            "UPDATE albums SET description = ?1, updated_at = ?2 WHERE id = ?3",
            params![description, now, id],
        )?;
        Ok(updated > 0)
    } else {
        // Just update the timestamp
        let updated = conn.execute(
            "UPDATE albums SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(updated > 0)
    }
}

/// Delete an album (cascade deletes album_assets)
pub fn delete_album(conn: &Connection, id: i64) -> Result<bool> {
    let deleted = conn.execute("DELETE FROM albums WHERE id = ?1", params![id])?;
    Ok(deleted > 0)
}

/// Add assets to an album
pub fn add_assets_to_album(conn: &Connection, album_id: i64, asset_ids: &[i64]) -> Result<usize> {
    if asset_ids.is_empty() {
        return Ok(0);
    }
    
    let tx = conn.unchecked_transaction()?;
    let mut added = 0;
    
    for asset_id in asset_ids {
        match tx.execute(
            "INSERT OR IGNORE INTO album_assets (album_id, asset_id) VALUES (?1, ?2)",
            params![album_id, asset_id],
        ) {
            Ok(1) => added += 1,
            Ok(_) => {},
            Err(e) => {
                tx.rollback()?;
                return Err(e.into());
            }
        }
    }
    
    // Update album's updated_at timestamp
    let now = chrono::Utc::now().timestamp();
    let _ = tx.execute(
        "UPDATE albums SET updated_at = ?1 WHERE id = ?2",
        params![now, album_id],
    );
    
    tx.commit()?;
    Ok(added)
}

/// Remove assets from an album
pub fn remove_assets_from_album(conn: &Connection, album_id: i64, asset_ids: &[i64]) -> Result<usize> {
    if asset_ids.is_empty() {
        return Ok(0);
    }
    
    let tx = conn.unchecked_transaction()?;
    let mut removed = 0;
    
    for asset_id in asset_ids {
        match tx.execute(
            "DELETE FROM album_assets WHERE album_id = ?1 AND asset_id = ?2",
            params![album_id, asset_id],
        ) {
            Ok(count) => removed += count as usize,
            Err(e) => {
                tx.rollback()?;
                return Err(e.into());
            }
        }
    }
    
    // Update album's updated_at timestamp
    let now = chrono::Utc::now().timestamp();
    let _ = tx.execute(
        "UPDATE albums SET updated_at = ?1 WHERE id = ?2",
        params![now, album_id],
    );
    
    tx.commit()?;
    Ok(removed)
}
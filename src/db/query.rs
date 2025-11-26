use anyhow::Result;
use rusqlite::{Connection, params, Row, OptionalExtension};
use crate::models::asset::{Asset, Paged, SearchResult, SearchMatchCounts};

// Type aliases for complex query result types
#[cfg(feature = "facial-recognition")]
pub type AssetPathSize = (String, Option<i64>, Option<i64>);
pub type FileUnchangedInfo = (i64, Option<i64>, Option<Vec<u8>>);
#[cfg(feature = "facial-recognition")]
pub type FaceInfo = (i64, Option<i64>, String, f64);
#[cfg(feature = "facial-recognition")]
pub type FaceEmbeddingRow = (i64, i64, Vec<u8>, Option<i64>);
#[cfg(feature = "facial-recognition")]
pub type UnassignedFace = (i64, i64, Vec<u8>, f64, String);
pub type AlbumInfo = (i64, String, Option<String>, i64, i64);
pub type AlbumDetail = (i64, String, Option<String>, i64, i64, Vec<i64>);

// Search parameters struct
pub struct SearchParams<'a> {
    pub q: &'a str,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub camera_make: Option<&'a str>,
    pub camera_model: Option<&'a str>,
    pub platform_type: Option<&'a str>,
    pub offset: i64,
    pub limit: i64,
}

fn row_to_asset(row: &Row<'_>) -> rusqlite::Result<Asset> {
    let sha: Option<Vec<u8>> = row.get("sha256")?;
    let sha_hex = sha.map(|b| hex::encode(b));
    Ok(Asset {
        id: row.get("id")?,
        path: row.get("path")?,
        dirname: row.get("dirname")?,
        filename: row.get("filename")?,
        ext: row.get("ext")?,
        size_bytes: row.get("size_bytes")?,
        mtime_ns: row.get("mtime_ns")?,
        ctime_ns: row.get("ctime_ns")?,
        sha256: sha_hex,
        xxh64: row.get("xxh64").ok(),
        taken_at: row.get("taken_at").ok(),
        width: row.get("width").ok(),
        height: row.get("height").ok(),
        duration_ms: row.get("duration_ms").ok(),
        camera_make: row.get("camera_make").ok(),
        camera_model: row.get("camera_model").ok(),
        lens_model: row.get("lens_model").ok(),
        iso: row.get("iso").ok(),
        fnumber: row.get("fnumber").ok(),
        exposure: row.get("exposure").ok(),
        video_codec: row.get("video_codec").ok(),
        mime: row.get("mime")?,
        flags: row.get("flags")?,
    })
}

pub fn count_assets(conn: &Connection) -> Result<i64> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM assets")?;
    let n: i64 = stmt.query_row([], |r| r.get(0))?;
    Ok(n)
}

#[cfg(feature = "facial-recognition")]
pub fn get_unassigned_faces(conn: &Connection, offset: i64, limit: i64) -> Result<Vec<(i64, i64, String, f64)>> {
    let mut stmt = conn.prepare("SELECT id, asset_id, bbox_json, confidence FROM face_embeddings WHERE person_id IS NULL ORDER BY id DESC LIMIT ? OFFSET ?")?;
    let rows = stmt.query_map(params![limit, offset], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[cfg(feature = "facial-recognition")]
pub fn get_face_row(conn: &Connection, face_id: i64) -> Result<Option<(i64, i64, String, f64)>> {
    let mut stmt = conn.prepare("SELECT id, asset_id, bbox_json, confidence FROM face_embeddings WHERE id = ?")?;
    let row = stmt.query_row(params![face_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    }).optional()?;
    Ok(row)
}

#[cfg(feature = "facial-recognition")]
pub fn get_asset_path_size(conn: &Connection, asset_id: i64) -> Result<Option<AssetPathSize>> {
    let mut stmt = conn.prepare("SELECT path, width, height FROM assets WHERE id = ?")?;
    let row = stmt.query_row(params![asset_id], |row| {
        Ok((row.get(0)?, row.get(1).ok(), row.get(2).ok()))
    }).optional()?;
    Ok(row)
}

pub fn list_assets(conn: &Connection, offset: i64, limit: i64, sort: &str, order: &str) -> Result<Paged<Asset>> {
    let total = count_assets(conn)?;
    
    // Handle "none" sort - return assets in natural order (by ID)
    if sort == "none" {
        let order_dir = match order { "asc" => "ASC", _ => "DESC" };
        let sql = format!("SELECT * FROM assets ORDER BY id {} LIMIT ? OFFSET ?", order_dir);
        let mut stmt = conn.prepare(&sql)?;
        let items = stmt.query_map(params![limit, offset], row_to_asset)?.collect::<std::result::Result<Vec<_>, _>>()?;
        return Ok(Paged { total, items });
    }
    
    // Map frontend sort field names to database column names
    // Handle NULL values properly for nullable columns
    let (sort_col, nulls_clause) = match sort {
        "taken_at" => ("taken_at", "NULLS LAST"), // NULLS LAST for taken_at (photos without EXIF)
        "filename" => ("filename", ""),
        "size_bytes" => ("size_bytes", ""),
        "mtime" | "mtime_ns" => ("mtime_ns", ""),
        _ => ("mtime_ns", ""), // Default to mtime_ns for unrecognized values
    };
    let order_dir = match order { "asc" => "ASC", _ => "DESC" };
    
    // Build SQL with proper NULL handling
    let sql = if nulls_clause.is_empty() {
        format!("SELECT * FROM assets ORDER BY {} {} LIMIT ? OFFSET ?", sort_col, order_dir)
    } else {
        format!("SELECT * FROM assets ORDER BY {} {} {} LIMIT ? OFFSET ?", sort_col, order_dir, nulls_clause)
    };
    
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(params![limit, offset], row_to_asset)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Paged { total, items })
}

#[cfg(feature = "facial-recognition")]
pub fn list_assets_by_person(conn: &Connection, person_id: i64, offset: i64, limit: i64, sort: &str, order: &str) -> Result<Paged<Asset>> {
    // Count total assets for this person
    let total: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT asset_id) FROM face_embeddings WHERE person_id = ?",
        params![person_id],
        |r| r.get(0)
    )?;
    
    // Handle "none" sort - return assets in natural order (by ID)
    if sort == "none" {
        let order_dir = match order { "asc" => "ASC", _ => "DESC" };
        let sql = format!(
            "SELECT a.* FROM assets a 
             INNER JOIN face_embeddings fe ON a.id = fe.asset_id 
             WHERE fe.person_id = ? 
             GROUP BY a.id 
             ORDER BY a.id {} 
             LIMIT ? OFFSET ?",
            order_dir
        );
        let mut stmt = conn.prepare(&sql)?;
        let items = stmt.query_map(params![person_id, limit, offset], row_to_asset)?.collect::<std::result::Result<Vec<_>, _>>()?;
        return Ok(Paged { total, items });
    }
    
    // Map frontend sort field names to database column names
    let (sort_col, nulls_clause) = match sort {
        "taken_at" => ("taken_at", "NULLS LAST"),
        "filename" => ("filename", ""),
        "size_bytes" => ("size_bytes", ""),
        "mtime" | "mtime_ns" => ("mtime_ns", ""),
        _ => ("mtime_ns", ""),
    };
    let order_dir = match order { "asc" => "ASC", _ => "DESC" };
    
    // Build SQL to get assets filtered by person_id
    let sql = if nulls_clause.is_empty() {
        format!(
            "SELECT a.* FROM assets a 
             INNER JOIN face_embeddings fe ON a.id = fe.asset_id 
             WHERE fe.person_id = ? 
             GROUP BY a.id 
             ORDER BY a.{} {} 
             LIMIT ? OFFSET ?",
            sort_col, order_dir
        )
    } else {
        format!(
            "SELECT a.* FROM assets a 
             INNER JOIN face_embeddings fe ON a.id = fe.asset_id 
             WHERE fe.person_id = ? 
             GROUP BY a.id 
             ORDER BY a.{} {} {} 
             LIMIT ? OFFSET ?",
            sort_col, order_dir, nulls_clause
        )
    };
    
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(params![person_id, limit, offset], row_to_asset)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Paged { total, items })
}

pub fn search_assets(conn: &Connection, params: &SearchParams<'_>) -> Result<SearchResult> {
    // Parse query for wildcard patterns and text terms
    let query_trimmed = params.q.trim();
    let has_wildcards = query_trimmed.contains('*') || query_trimmed.contains('?');
    
    let (wildcard_patterns, text_terms) = if has_wildcards {
        // Split query into tokens and separate wildcard patterns from text terms
        let tokens: Vec<&str> = query_trimmed.split_whitespace().collect();
        let mut wildcards = Vec::new();
        let mut text = Vec::new();
        
        for token in tokens {
            if token.contains('*') || token.contains('?') {
                wildcards.push(token);
            } else {
                text.push(token);
            }
        }
        (wildcards, text.join(" "))
    } else {
        (Vec::new(), query_trimmed.to_string())
    };
    
    // Prepare FTS5 query only if we have text terms (not just wildcards)
    let use_fts5 = !text_terms.trim().is_empty();
    let fts_query = if use_fts5 {
        // Split by whitespace and add * to each word for prefix matching
        // Escape special FTS5 characters: ", ', \
        let escaped_q = text_terms.replace("\\", "\\\\").replace("\"", "\\\"").replace("'", "''");
        escaped_q
            .split_whitespace()
            .map(|word| {
                // Don't add * if word already ends with * or contains FTS5 operators
                if word.ends_with('*') || word.contains('"') || word.contains(':') {
                    word.to_string()
                } else {
                    format!("{}*", word)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };
    
    let mut where_clauses = Vec::new();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
    
    // Add FTS5 search only if we have text terms
    if use_fts5 {
        where_clauses.push("id IN (SELECT rowid FROM fts_assets WHERE fts_assets MATCH ?)".to_string());
        params_vec.push(rusqlite::types::Value::from(fts_query));
    }
    
    // Apply GLOB filename filters for wildcard patterns
    let has_wildcard_patterns = !wildcard_patterns.is_empty();
    if has_wildcard_patterns {
        for pattern in &wildcard_patterns {
            // Treat *.* as "match all files" – no filename filter needed
            // This aligns with common shell semantics and our UI expectations
            if *pattern == "*.*" {
                continue;
            }
            // Escape special GLOB characters: [, ], \, and single quotes
            // Note: SQLite GLOB uses * and ? as wildcards, so we keep those
            // Convert pattern to lowercase for case-insensitive matching
            let escaped_pattern = pattern
                .to_lowercase()
                .replace("\\", "\\\\")
                .replace("'", "''")
                .replace("[", "\\[")
                .replace("]", "\\]");
            // Use LOWER() on filename for case-insensitive matching
            where_clauses.push(format!("LOWER(filename) GLOB '{}'", escaped_pattern));
        }
    }
    if let Some(f) = params.from { where_clauses.push("taken_at >= ?".to_string()); params_vec.push(f.into()); }
    if let Some(t) = params.to { where_clauses.push("taken_at <= ?".to_string()); params_vec.push(t.into()); }
    if let Some(m) = params.camera_make { where_clauses.push("camera_make = ?".to_string()); params_vec.push(rusqlite::types::Value::from(m.to_string())); }
    if let Some(m) = params.camera_model { where_clauses.push("camera_model = ?".to_string()); params_vec.push(rusqlite::types::Value::from(m.to_string())); }
    if let Some(pt) = params.platform_type {
        if pt == "whatsapp" {
            // WhatsApp filename pattern: [A-Z]{3}-\d{8}-WA\d{4}\.\w+
            // SQLite GLOB pattern: [A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-WA[0-9][0-9][0-9][0-9].*
            where_clauses.push("filename GLOB '[A-Z][A-Z][A-Z]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-WA[0-9][0-9][0-9][0-9].*'".to_string());
        } else if pt == "pxl" {
            // PXL filename pattern: PXL_YYYYMMDD_HHMMSSsss.[MODE].EXT
            // SQLite GLOB pattern: PXL_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].*
            where_clauses.push("filename GLOB 'PXL_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].*'".to_string());
        }
    }
    let where_sql = if where_clauses.is_empty() { String::new() } else { format!("WHERE {}", where_clauses.join(" AND ")) };
    let count_sql = format!("SELECT COUNT(*) FROM assets {}", where_sql);
    let total: i64 = conn.query_row(&count_sql, rusqlite::params_from_iter(params_vec.clone()), |r| r.get(0))?;
    
    // Calculate match type counts
    // For text queries: calculate filename/dirname/path breakdown
    // For wildcard-only queries: all matches are filename matches
    let match_counts = if use_fts5 && !text_terms.trim().is_empty() {
        // Text query (with or without wildcards) - calculate breakdown by match type
        // Escape query for LIKE patterns
        let escaped_q = text_terms.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        let escaped_q_sql = escaped_q.replace("'", "''");
        
        // Build additional WHERE conditions for match type filtering
        let filename_where = if where_sql.is_empty() {
            format!("WHERE LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\'", escaped_q_sql)
        } else {
            format!("{} AND LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\'", where_sql, escaped_q_sql)
        };
        
        let dirname_where = if where_sql.is_empty() {
            format!("WHERE LOWER(dirname) LIKE LOWER('%{}%') ESCAPE '\\' AND NOT (LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\')", escaped_q_sql, escaped_q_sql)
        } else {
            format!("{} AND LOWER(dirname) LIKE LOWER('%{}%') ESCAPE '\\' AND NOT (LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\')", where_sql, escaped_q_sql, escaped_q_sql)
        };
        
        let path_where = if where_sql.is_empty() {
            format!("WHERE LOWER(path) LIKE LOWER('%{}%') ESCAPE '\\' AND NOT (LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\') AND NOT (LOWER(dirname) LIKE LOWER('%{}%') ESCAPE '\\')", escaped_q_sql, escaped_q_sql, escaped_q_sql)
        } else {
            format!("{} AND LOWER(path) LIKE LOWER('%{}%') ESCAPE '\\' AND NOT (LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\') AND NOT (LOWER(dirname) LIKE LOWER('%{}%') ESCAPE '\\')", where_sql, escaped_q_sql, escaped_q_sql, escaped_q_sql)
        };
        
        // Count filename matches
        let filename_count_sql = format!("SELECT COUNT(*) FROM assets {}", filename_where);
        let filename_count: i64 = match conn.query_row(&filename_count_sql, rusqlite::params_from_iter(params_vec.clone()), |r| r.get(0)) {
            Ok(count) => count,
            Err(e) => {
                eprintln!("Error counting filename matches: {}", e);
                0
            }
        };
        
        // Count dirname matches (excluding filename matches)
        let dirname_count_sql = format!("SELECT COUNT(*) FROM assets {}", dirname_where);
        let dirname_count: i64 = match conn.query_row(&dirname_count_sql, rusqlite::params_from_iter(params_vec.clone()), |r| r.get(0)) {
            Ok(count) => count,
            Err(e) => {
                eprintln!("Error counting dirname matches: {}", e);
                0
            }
        };
        
        // Count path matches (excluding filename and dirname matches)
        let path_count_sql = format!("SELECT COUNT(*) FROM assets {}", path_where);
        let path_count: i64 = match conn.query_row(&path_count_sql, rusqlite::params_from_iter(params_vec.clone()), |r| r.get(0)) {
            Ok(count) => count,
            Err(e) => {
                eprintln!("Error counting path matches: {}", e);
                0
            }
        };
        
        Some(SearchMatchCounts {
            filename: filename_count,
            dirname: dirname_count,
            path: path_count,
        })
    } else if has_wildcard_patterns && text_terms.trim().is_empty() {
        // Wildcard-only query - all matches are filename matches
        Some(SearchMatchCounts {
            filename: total,
            dirname: 0,
            path: 0,
        })
    } else {
        None
    };
    
    // Build sorting logic
    // If we have wildcard patterns, prioritize filename matches
    // If we have text terms, use LIKE-based priority sorting
    let order_by_clause = if has_wildcard_patterns {
        // When wildcards are used, prioritize exact filename matches
        "filename ASC, taken_at DESC NULLS LAST, mtime_ns DESC".to_string()
    } else if use_fts5 {
        // Use priority-based sorting for text search: 1 = filename match, 2 = dirname match, 3 = path match
        // Escape query for LIKE patterns to prevent SQL injection
        let escaped_q = text_terms.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        let escaped_q_sql = escaped_q.replace("'", "''");
        format!(
            "CASE 
               WHEN LOWER(filename) LIKE LOWER('%{}%') ESCAPE '\\' THEN 1
               WHEN LOWER(dirname) LIKE LOWER('%{}%') ESCAPE '\\' THEN 2
               WHEN LOWER(path) LIKE LOWER('%{}%') ESCAPE '\\' THEN 3
               ELSE 4
             END ASC,
             taken_at DESC NULLS LAST, 
             mtime_ns DESC",
            escaped_q_sql, escaped_q_sql, escaped_q_sql
        )
    } else {
        // Fallback: no text terms and no wildcards (shouldn't happen, but handle gracefully)
        "taken_at DESC NULLS LAST, mtime_ns DESC".to_string()
    };
    
    let list_sql = format!(
        "SELECT * FROM assets {} ORDER BY {} LIMIT ? OFFSET ?",
        where_sql, order_by_clause
    );
    let mut all_params = params_vec.clone();
    all_params.push((params.limit as i64).into());
    all_params.push((params.offset as i64).into());
    let mut stmt = conn.prepare(&list_sql)?;
    let items = stmt.query_map(rusqlite::params_from_iter(all_params.into_iter()), row_to_asset)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(SearchResult { total, items, match_counts })
}

pub fn get_asset_sha256(conn: &Connection, id: i64) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT sha256 FROM assets WHERE id = ?")?;
    let sha: Option<Vec<u8>> = stmt.query_row(params![id], |row| row.get(0))?;
    Ok(sha.map(|b| hex::encode(b)))
}

pub fn get_thumb_info(conn: &Connection, id: i64) -> Result<(Option<String>, String)> {
    let mut stmt = conn.prepare("SELECT sha256, mime FROM assets WHERE id = ?")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let sha: Option<Vec<u8>> = row.get(0)?;
        let mime: String = row.get(1)?;
        Ok((sha.map(|b| hex::encode(b)), mime))
    } else {
        Ok((None, String::new()))
    }
}

/// Check if a file is unchanged (path and mtime match)
/// Returns Some(id, xxh64, sha256) if unchanged, None if changed or not found
pub fn check_file_unchanged(conn: &Connection, path: &str, mtime_ns: i64, size_bytes: i64) -> Result<Option<FileUnchangedInfo>> {
    let mut stmt = conn.prepare("SELECT id, xxh64, sha256 FROM assets WHERE path = ? AND mtime_ns = ? AND size_bytes = ?")?;
    let mut rows = stmt.query(params![path, mtime_ns, size_bytes])?;
    if let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let xxh64: Option<i64> = row.get(1).ok();
        let sha256: Option<Vec<u8>> = row.get(2).ok();
        Ok(Some((id, xxh64, sha256)))
    } else {
        Ok(None)
    }
}

/// Check if a file has complete metadata
/// Returns true if metadata is sufficient to skip re-extraction
pub fn check_metadata_complete(conn: &Connection, id: i64, mime: &str) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT width, height, duration_ms FROM assets WHERE id = ?")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let width: Option<i64> = row.get(0).ok();
        let height: Option<i64> = row.get(1).ok();
        let duration_ms: Option<i64> = row.get(2).ok();
        
        if mime.starts_with("image/") {
            // Images need width and height
            Ok(width.is_some() && height.is_some())
        } else if mime.starts_with("video/") {
            // Videos need at least duration_ms, or width/height as fallback
            Ok(duration_ms.is_some() || (width.is_some() && height.is_some()))
        } else {
            // Unknown type - assume incomplete to be safe
            Ok(false)
        }
    } else {
        Ok(false)
    }
}

/// Get asset path by ID
pub fn get_asset_path(conn: &Connection, id: i64) -> Result<Option<String>> {
    let path: Option<String> = conn.query_row("SELECT path FROM assets WHERE id = ?", params![id], |r| r.get(0)).ok();
    Ok(path)
}

/// Get a single asset by ID
pub fn get_asset_by_id(conn: &Connection, id: i64) -> Result<Option<Asset>> {
    let mut stmt = conn.prepare("SELECT * FROM assets WHERE id = ?")?;
    let mut rows = stmt.query_map(params![id], row_to_asset)?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

/// Delete an asset by ID from both assets and fts_assets tables
pub fn delete_asset_by_id(conn: &Connection, id: i64) -> Result<bool> {
    // Delete from assets table
    let deleted = conn.execute("DELETE FROM assets WHERE id = ?", params![id])?;
    
    // Delete from FTS table
    let _ = conn.execute("DELETE FROM fts_assets WHERE rowid = ?", params![id]);
    
    Ok(deleted > 0)
}

/// Get all scan paths
pub fn get_scan_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM scan_paths ORDER BY created_at")?;
    let paths = stmt.query_map([], |row| {
        Ok(row.get::<_, String>(0)?)
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(paths)
}

/// Delete an asset by path from both assets and fts_assets tables
pub fn delete_asset_by_path(conn: &Connection, path: &str) -> Result<bool> {
    // First get the id to delete from FTS
    let id: Option<i64> = conn.query_row("SELECT id FROM assets WHERE path = ?", params![path], |r| r.get(0)).ok();
    
    // Delete from assets table
    let deleted = conn.execute("DELETE FROM assets WHERE path = ?", params![path])?;
    
    // Delete from FTS table if we found an id
    if let Some(asset_id) = id {
        let _ = conn.execute("DELETE FROM fts_assets WHERE rowid = ?", params![asset_id]);
    }
    
    Ok(deleted > 0)
}

/// Find an asset by filename and size that doesn't exist at its stored path
/// Returns the old path if found, None otherwise
pub fn find_moved_asset(conn: &Connection, filename: &str, size_bytes: i64) -> Result<Option<String>> {
    use std::path::Path;
    
    let mut stmt = conn.prepare("SELECT path FROM assets WHERE filename = ? AND size_bytes = ?")?;
    let rows = stmt.query_map(params![filename, size_bytes], |row| {
        Ok(row.get::<_, String>(0)?)
    })?;
    
    for path_result in rows {
        let path = path_result?;
        let path_obj = Path::new(&path);
        // Check if the file doesn't exist at the stored path
        if !path_obj.exists() {
            return Ok(Some(path));
        }
    }
    
    Ok(None)
}

/// Update an asset's path (for file moves/renames) in both assets and fts_assets tables
pub fn update_asset_path(conn: &Connection, old_path: &str, new_path: &str) -> Result<bool> {
    use std::path::Path;
    
    // Extract dirname and filename from new path
    let new_path_obj = Path::new(new_path);
    let dirname = new_path_obj
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();
    let filename = new_path_obj
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    
    // Use transaction for atomicity
    let tx = conn.unchecked_transaction()?;
    
    // First get the id to update in FTS
    let id: Option<i64> = tx.query_row("SELECT id FROM assets WHERE path = ?", params![old_path], |r| r.get(0)).ok();
    
    if id.is_none() {
        // Asset not found - return false
        return Ok(false);
    }
    
    // Update assets table
    let updated = tx.execute(
        "UPDATE assets SET path = ?1, dirname = ?2, filename = ?3 WHERE path = ?4",
        params![new_path, dirname, filename, old_path],
    )?;
    
    if updated == 0 {
        tx.rollback()?;
        return Ok(false);
    }
    
    // Update FTS table if we found an id
    if let Some(asset_id) = id {
        let _ = tx.execute(
            "UPDATE fts_assets SET path = ?1, dirname = ?2, filename = ?3 WHERE rowid = ?4",
            params![new_path, dirname, filename, asset_id],
        );
    }
    
    tx.commit()?;
    Ok(true)
}

// Face and Person query functions
#[cfg(feature = "facial-recognition")]
pub fn list_persons(conn: &Connection) -> Result<Vec<(i64, Option<String>, i64)>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at FROM persons ORDER BY created_at DESC")?;
    let persons = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(persons)
}

#[cfg(feature = "facial-recognition")]
pub fn get_person(conn: &Connection, person_id: i64) -> Result<Option<(i64, Option<String>, i64)>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at FROM persons WHERE id = ?")?;
    let person = stmt.query_row(params![person_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).optional()?;
    Ok(person)
}

#[cfg(feature = "facial-recognition")]
pub fn get_person_assets(conn: &Connection, person_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT DISTINCT asset_id FROM face_embeddings WHERE person_id = ?")?;
    let assets = stmt.query_map(params![person_id], |row| {
        row.get(0)
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(assets)
}

#[cfg(feature = "facial-recognition")]
pub fn get_person_representative_face(conn: &Connection, person_id: i64) -> Result<Option<i64>> {
    // Get the face with highest confidence for this person
    let mut stmt = conn.prepare("SELECT id FROM face_embeddings WHERE person_id = ? ORDER BY confidence DESC LIMIT 1")?;
    let face_id: Option<i64> = stmt.query_row(params![person_id], |row| {
        row.get(0)
    }).optional()?;
    Ok(face_id)
}

#[cfg(feature = "facial-recognition")]
pub fn get_asset_faces(conn: &Connection, asset_id: i64) -> Result<Vec<FaceInfo>> {
    let mut stmt = conn.prepare("SELECT id, person_id, bbox_json, confidence FROM face_embeddings WHERE asset_id = ?")?;
    let faces = stmt.query_map(params![asset_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(faces)
}

#[cfg(feature = "facial-recognition")]
pub fn get_all_face_embeddings(conn: &Connection) -> Result<Vec<FaceEmbeddingRow>> {
    let mut stmt = conn.prepare("SELECT id, asset_id, embedding_blob, person_id FROM face_embeddings")?;
    let embeddings = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(embeddings)
}

#[cfg(feature = "facial-recognition")]
pub fn get_unassigned_faces_with_embeddings(conn: &Connection) -> Result<Vec<UnassignedFace>> {
    let mut stmt = conn.prepare("SELECT id, asset_id, embedding_blob, confidence, bbox_json FROM face_embeddings WHERE person_id IS NULL ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[cfg(feature = "facial-recognition")]
pub fn decode_embedding_blob(blob: &[u8]) -> Result<Vec<f32>> {
    // Convert bytes back to f32 (little-endian)
    if blob.len() % 4 != 0 {
        anyhow::bail!("Embedding blob length is not a multiple of 4");
    }
    let mut embeddings = Vec::with_capacity(blob.len() / 4);
    for chunk in blob.chunks_exact(4) {
        let bytes: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];
        embeddings.push(f32::from_le_bytes(bytes));
    }
    Ok(embeddings)
}

#[cfg(feature = "facial-recognition")]
pub fn get_person_face_embeddings(conn: &Connection, person_id: i64) -> Result<Vec<Vec<f32>>> {
    let mut stmt = conn.prepare("SELECT embedding_blob FROM face_embeddings WHERE person_id = ?")?;
    let rows = stmt.query_map(params![person_id], |row| {
        let blob: Vec<u8> = row.get(0)?;
        Ok(blob)
    })?;
    let mut embeddings = Vec::new();
    for row in rows {
        let blob = row?;
        match decode_embedding_blob(&blob) {
            Ok(embedding) => embeddings.push(embedding),
            Err(e) => {
                tracing::warn!("Failed to decode embedding for person {}: {}", person_id, e);
                continue;
            }
        }
    }
    Ok(embeddings)
}

#[cfg(feature = "facial-recognition")]
pub fn get_person_centroid(conn: &Connection, person_id: i64) -> Result<Option<Vec<f32>>> {
    let mut stmt = conn.prepare("SELECT centroid_blob FROM person_profiles WHERE person_id = ?")?;
    let blob: Option<Vec<u8>> = stmt.query_row(params![person_id], |row| row.get(0)).optional()?;
    
    match blob {
        Some(blob) => {
            match decode_embedding_blob(&blob) {
                Ok(centroid) => Ok(Some(centroid)),
                Err(e) => {
                    tracing::warn!("Failed to decode centroid for person {}: {}", person_id, e);
                    Ok(None)
                }
            }
        }
        None => Ok(None)
    }
}

/// List all albums
pub fn list_albums(conn: &Connection) -> Result<Vec<AlbumInfo>> {
    let mut stmt = conn.prepare("SELECT id, name, description, created_at, updated_at FROM albums ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2).ok(),
            row.get(3)?,
            row.get(4)?,
        ))
    })?;
    let mut albums = Vec::new();
    for row in rows {
        albums.push(row?);
    }
    Ok(albums)
}

/// Get a single album with its asset IDs
pub fn get_album(conn: &Connection, album_id: i64) -> Result<Option<AlbumDetail>> {
    // Get album info
    let mut stmt = conn.prepare("SELECT id, name, description, created_at, updated_at FROM albums WHERE id = ?1")?;
    let album_info = stmt.query_row(params![album_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2).ok(),
            row.get(3)?,
            row.get(4)?,
        ))
    }).optional()?;
    
    if let Some((id, name, description, created_at, updated_at)) = album_info {
        // Get asset IDs for this album
        let mut asset_stmt = conn.prepare("SELECT asset_id FROM album_assets WHERE album_id = ?1 ORDER BY asset_id")?;
        let asset_rows = asset_stmt.query_map(params![album_id], |row| {
            row.get::<_, i64>(0)
        })?;
        let mut asset_ids = Vec::new();
        for row in asset_rows {
            asset_ids.push(row?);
        }
        Ok(Some((id, name, description, created_at, updated_at, asset_ids)))
    } else {
        Ok(None)
    }
}

/// Get all albums that contain a specific asset
pub fn get_albums_for_asset(conn: &Connection, asset_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT album_id FROM album_assets WHERE asset_id = ?1")?;
    let rows = stmt.query_map(params![asset_id], |row| {
        row.get::<_, i64>(0)
    })?;
    let mut album_ids = Vec::new();
    for row in rows {
        album_ids.push(row?);
    }
    Ok(album_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, Connection) {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("test.db");
        let conn = db::open_or_create(&db_path).unwrap();
        (tmp, conn)
    }

    #[test]
    fn test_count_assets_empty() {
        let (_tmp, conn) = setup_test_db();
        let count = count_assets(&conn).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_list_assets_empty() {
        let (_tmp, conn) = setup_test_db();
        let result = list_assets(&conn, 0, 10, "none", "desc").unwrap();
        assert_eq!(result.total, 0);
        assert_eq!(result.items.len(), 0);
    }

    #[test]
    fn test_list_assets_pagination() {
        let (_tmp, conn) = setup_test_db();
        
        // Insert test assets
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/2.jpg", "/test", "2.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
        ).unwrap();

        let result = list_assets(&conn, 0, 1, "none", "desc").unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items.len(), 1);
        
        let result = list_assets(&conn, 1, 1, "none", "desc").unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items.len(), 1);
    }

    #[test]
    fn test_list_assets_sorting() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/a.jpg", "/test", "a.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/b.jpg", "/test", "b.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
        ).unwrap();

        let result = list_assets(&conn, 0, 10, "filename", "asc").unwrap();
        assert_eq!(result.items[0].filename, "a.jpg");
        
        let result = list_assets(&conn, 0, 10, "filename", "desc").unwrap();
        assert_eq!(result.items[0].filename, "b.jpg");
    }

    #[test]
    fn test_get_asset_by_id() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        
        let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", params!["/test/1.jpg"], |r| r.get(0)).unwrap();
        
        let asset = get_asset_by_id(&conn, id).unwrap();
        assert!(asset.is_some());
        assert_eq!(asset.unwrap().path, "/test/1.jpg");
        
        let asset = get_asset_by_id(&conn, 99999).unwrap();
        assert!(asset.is_none());
    }

    #[test]
    fn test_get_asset_path() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        
        let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", params!["/test/1.jpg"], |r| r.get(0)).unwrap();
        
        let path = get_asset_path(&conn, id).unwrap();
        assert_eq!(path, Some("/test/1.jpg".to_string()));
        
        let path = get_asset_path(&conn, 99999).unwrap();
        assert_eq!(path, None);
    }

    #[test]
    fn test_delete_asset_by_id() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        
        let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", params!["/test/1.jpg"], |r| r.get(0)).unwrap();
        
        let deleted = delete_asset_by_id(&conn, id).unwrap();
        assert!(deleted);
        
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        
        let deleted = delete_asset_by_id(&conn, 99999).unwrap();
        assert!(!deleted);
    }

    #[test]
    fn test_search_assets_simple() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/photo2.jpg", "/test", "photo2.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
        ).unwrap();
        
        // Update FTS table
        conn.execute("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (1, 'photo1.jpg', '/test', '/test/photo1.jpg')", []).unwrap();
        conn.execute("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (2, 'photo2.jpg', '/test', '/test/photo2.jpg')", []).unwrap();
        
        let search_params = SearchParams {
            q: "photo1",
            from: None,
            to: None,
            camera_make: None,
            camera_model: None,
            platform_type: None,
            offset: 0,
            limit: 10,
        };
        let result = search_assets(&conn, &search_params).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].filename, "photo1.jpg");
    }

    #[test]
    fn test_search_assets_wildcard() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/image2.png", "/test", "image2.png", "png", 2000, 2000000, 2000000, "image/png", 0]
        ).unwrap();
        
        let search_params = SearchParams {
            q: "*.jpg",
            from: None,
            to: None,
            camera_make: None,
            camera_model: None,
            platform_type: None,
            offset: 0,
            limit: 10,
        };
        let result = search_assets(&conn, &search_params).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].ext, "jpg");
    }

    #[test]
    fn test_check_file_unchanged() {
        let (_tmp, conn) = setup_test_db();
        
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        
        let result = check_file_unchanged(&conn, "/test/1.jpg", 1000000, 1000).unwrap();
        assert!(result.is_some());
        
        let result = check_file_unchanged(&conn, "/test/1.jpg", 2000000, 1000).unwrap();
        assert!(result.is_none());
        
        let result = check_file_unchanged(&conn, "/test/nonexistent.jpg", 1000000, 1000).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_check_metadata_complete() {
        let (_tmp, conn) = setup_test_db();
        
        // Image with complete metadata
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, width, height, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params!["/test/1.jpg", "/test", "1.jpg", "jpg", 1000, 1000000, 1000000, 1920, 1080, "image/jpeg", 0]
        ).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", params!["/test/1.jpg"], |r| r.get(0)).unwrap();
        
        assert!(check_metadata_complete(&conn, id, "image/jpeg").unwrap());
        
        // Image without metadata
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["/test/2.jpg", "/test", "2.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
        ).unwrap();
        let id2: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", params!["/test/2.jpg"], |r| r.get(0)).unwrap();
        
        assert!(!check_metadata_complete(&conn, id2, "image/jpeg").unwrap());
    }

    #[test]
    fn test_get_scan_paths() {
        let (_tmp, conn) = setup_test_db();
        
        let paths = get_scan_paths(&conn).unwrap();
        assert_eq!(paths.len(), 0);
        
        conn.execute(
            "INSERT INTO scan_paths (path, created_at) VALUES (?1, ?2)",
            params!["/test/path1", 1000000]
        ).unwrap();
        
        let paths = get_scan_paths(&conn).unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], "/test/path1");
    }
}
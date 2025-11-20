use anyhow::Result;
use rusqlite::{Connection, params, Row};
#[cfg(feature = "facial-recognition")]
use rusqlite::OptionalExtension;
use crate::models::asset::{Asset, Paged, SearchResult, SearchMatchCounts};

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
pub fn get_asset_path_size(conn: &Connection, asset_id: i64) -> Result<Option<(String, Option<i64>, Option<i64>)>> {
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

pub fn search_assets(conn: &Connection, q: &str, from: Option<i64>, to: Option<i64>, camera_make: Option<&str>, camera_model: Option<&str>, platform_type: Option<&str>, offset: i64, limit: i64) -> Result<SearchResult> {
    // Parse query for wildcard patterns and text terms
    let query_trimmed = q.trim();
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
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    
    // Add FTS5 search only if we have text terms
    if use_fts5 {
        where_clauses.push("id IN (SELECT rowid FROM fts_assets WHERE fts_assets MATCH ?)".to_string());
        params.push(rusqlite::types::Value::from(fts_query));
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
    if let Some(f) = from { where_clauses.push("taken_at >= ?".to_string()); params.push(f.into()); }
    if let Some(t) = to { where_clauses.push("taken_at <= ?".to_string()); params.push(t.into()); }
    if let Some(m) = camera_make { where_clauses.push("camera_make = ?".to_string()); params.push(rusqlite::types::Value::from(m.to_string())); }
    if let Some(m) = camera_model { where_clauses.push("camera_model = ?".to_string()); params.push(rusqlite::types::Value::from(m.to_string())); }
    if let Some(pt) = platform_type {
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
    let total: i64 = conn.query_row(&count_sql, rusqlite::params_from_iter(params.clone()), |r| r.get(0))?;
    
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
        let filename_count: i64 = match conn.query_row(&filename_count_sql, rusqlite::params_from_iter(params.clone()), |r| r.get(0)) {
            Ok(count) => count,
            Err(e) => {
                eprintln!("Error counting filename matches: {}", e);
                0
            }
        };
        
        // Count dirname matches (excluding filename matches)
        let dirname_count_sql = format!("SELECT COUNT(*) FROM assets {}", dirname_where);
        let dirname_count: i64 = match conn.query_row(&dirname_count_sql, rusqlite::params_from_iter(params.clone()), |r| r.get(0)) {
            Ok(count) => count,
            Err(e) => {
                eprintln!("Error counting dirname matches: {}", e);
                0
            }
        };
        
        // Count path matches (excluding filename and dirname matches)
        let path_count_sql = format!("SELECT COUNT(*) FROM assets {}", path_where);
        let path_count: i64 = match conn.query_row(&path_count_sql, rusqlite::params_from_iter(params.clone()), |r| r.get(0)) {
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
    let mut all_params = params.clone();
    all_params.push((limit as i64).into());
    all_params.push((offset as i64).into());
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
pub fn check_file_unchanged(conn: &Connection, path: &str, mtime_ns: i64, size_bytes: i64) -> Result<Option<(i64, Option<i64>, Option<Vec<u8>>)>> {
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
pub fn get_asset_faces(conn: &Connection, asset_id: i64) -> Result<Vec<(i64, Option<i64>, String, f64)>> {
    let mut stmt = conn.prepare("SELECT id, person_id, bbox_json, confidence FROM face_embeddings WHERE asset_id = ?")?;
    let faces = stmt.query_map(params![asset_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(faces)
}

#[cfg(feature = "facial-recognition")]
pub fn get_all_face_embeddings(conn: &Connection) -> Result<Vec<(i64, i64, Vec<u8>, Option<i64>)>> {
    let mut stmt = conn.prepare("SELECT id, asset_id, embedding_blob, person_id FROM face_embeddings")?;
    let embeddings = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(embeddings)
}

#[cfg(feature = "facial-recognition")]
pub fn get_unassigned_faces_with_embeddings(conn: &Connection) -> Result<Vec<(i64, i64, Vec<u8>, f64, String)>> {
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
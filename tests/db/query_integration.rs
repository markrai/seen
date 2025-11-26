use nazr_backend_sqlite::db;
use nazr_backend_sqlite::db::query;
use tempfile::TempDir;

fn setup_test_db() -> (TempDir, rusqlite::Connection) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let conn = db::open_or_create(&db_path).unwrap();
    (tmp, conn)
}

#[test]
fn test_list_assets_integration() {
    let (_tmp, conn) = setup_test_db();
    
    // Insert multiple assets
    for i in 1..=10 {
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                format!("/test/photo{}.jpg", i),
                "/test",
                format!("photo{}.jpg", i),
                "jpg",
                1000 * i as i64,
                i * 1000000,
                i * 1000000,
                "image/jpeg",
                0
            ]
        ).unwrap();
    }
    
    // Test listing with different sorts
    let result = query::list_assets(&conn, 0, 5, "mtime_ns", "desc").unwrap();
    assert_eq!(result.total, 10);
    assert_eq!(result.items.len(), 5);
    
    // Verify sorting
    let mtimes: Vec<i64> = result.items.iter().map(|a| a.mtime_ns).collect();
    assert!(mtimes.windows(2).all(|w| w[0] >= w[1])); // Descending order
}

#[test]
fn test_search_assets_integration() {
    let (_tmp, conn) = setup_test_db();
    
    // Insert test assets
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/vacation/beach.jpg", "/vacation", "beach.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/vacation/mountain.jpg", "/vacation", "mountain.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
    ).unwrap();
    
    // Update FTS table
    conn.execute("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (1, 'beach.jpg', '/vacation', '/vacation/beach.jpg')", []).unwrap();
    conn.execute("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (2, 'mountain.jpg', '/vacation', '/vacation/mountain.jpg')", []).unwrap();
    
    // Test text search
    let result = query::search_assets(&conn, "beach", None, None, None, None, None, 0, 10).unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.items[0].filename, "beach.jpg");
    
    // Test wildcard search
    let result = query::search_assets(&conn, "*.jpg", None, None, None, None, None, 0, 10).unwrap();
    assert_eq!(result.total, 2);
}

#[test]
fn test_search_with_filters() {
    let (_tmp, conn) = setup_test_db();
    
    // Insert assets with different metadata
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, taken_at, camera_make, camera_model, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            "/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000,
            1609459200000, // 2021-01-01
            "Canon", "EOS 5D",
            "image/jpeg", 0
        ]
    ).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, taken_at, camera_make, camera_model, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            "/test/photo2.jpg", "/test", "photo2.jpg", "jpg", 2000, 2000000, 2000000,
            1640995200000, // 2022-01-01
            "Nikon", "D850",
            "image/jpeg", 0
        ]
    ).unwrap();
    
    // Test date range filter
    let result = query::search_assets(&conn, "", Some(1609459200000), Some(1640995200000), None, None, None, 0, 10).unwrap();
    assert_eq!(result.total, 2);
    
    // Test camera make filter
    let result = query::search_assets(&conn, "", None, None, Some("Canon"), None, None, 0, 10).unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.items[0].camera_make, Some("Canon".to_string()));
}

#[test]
fn test_album_queries() {
    let (_tmp, conn) = setup_test_db();
    
    // Create album
    let album_id: i64 = conn.query_row(
        "INSERT INTO albums (name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
        rusqlite::params!["Test Album", "Test Description", 1000000, 1000000],
        |r| r.get(0)
    ).unwrap();
    
    // Insert assets
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    let asset_id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo1.jpg"], |r| r.get(0)).unwrap();
    
    // Add asset to album
    conn.execute(
        "INSERT INTO album_assets (album_id, asset_id) VALUES (?1, ?2)",
        rusqlite::params![album_id, asset_id]
    ).unwrap();
    
    // Test get_album
    let album = query::get_album(&conn, album_id).unwrap();
    assert!(album.is_some());
    let (id, name, description, _, _, asset_ids) = album.unwrap();
    assert_eq!(id, album_id);
    assert_eq!(name, "Test Album");
    assert_eq!(asset_ids.len(), 1);
    assert_eq!(asset_ids[0], asset_id);
    
    // Test get_albums_for_asset
    let albums = query::get_albums_for_asset(&conn, asset_id).unwrap();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0], album_id);
}


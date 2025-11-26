use nazr_backend_sqlite::db;
use nazr_backend_sqlite::db::query;
use tempfile::TempDir;
use std::path::PathBuf;

fn setup_test_db() -> (TempDir, rusqlite::Connection) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let conn = db::open_or_create(&db_path).unwrap();
    (tmp, conn)
}

#[test]
fn test_asset_with_special_characters() {
    let (_tmp, conn) = setup_test_db();
    
    // Test filename with special characters
    let path = "/test/file with spaces.jpg";
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![path, "/test", "file with spaces.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params![path], |r| r.get(0)).unwrap();
    let asset = query::get_asset_by_id(&conn, id).unwrap();
    assert!(asset.is_some());
    assert_eq!(asset.unwrap().filename, "file with spaces.jpg");
}

#[test]
fn test_asset_with_unicode() {
    let (_tmp, conn) = setup_test_db();
    
    // Test filename with Unicode characters
    let path = "/test/照片.jpg";
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![path, "/test", "照片.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params![path], |r| r.get(0)).unwrap();
    let asset = query::get_asset_by_id(&conn, id).unwrap();
    assert!(asset.is_some());
    assert_eq!(asset.unwrap().filename, "照片.jpg");
}

#[test]
fn test_asset_without_metadata() {
    let (_tmp, conn) = setup_test_db();
    
    // Test asset with no EXIF metadata
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo.jpg", "/test", "photo.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo.jpg"], |r| r.get(0)).unwrap();
    let asset = query::get_asset_by_id(&conn, id).unwrap();
    assert!(asset.is_some());
    let asset = asset.unwrap();
    assert_eq!(asset.taken_at, None);
    assert_eq!(asset.width, None);
    assert_eq!(asset.height, None);
}

#[test]
fn test_duplicate_paths() {
    let (_tmp, conn) = setup_test_db();
    
    // SQLite UNIQUE constraint should prevent duplicate paths
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo.jpg", "/test", "photo.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    // Attempting to insert duplicate path should fail
    let result = conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo.jpg", "/test", "photo.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
    );
    
    assert!(result.is_err());
}

#[test]
fn test_asset_with_null_values() {
    let (_tmp, conn) = setup_test_db();
    
    // Test asset with many NULL values
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo.jpg", "/test", "photo.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo.jpg"], |r| r.get(0)).unwrap();
    let asset = query::get_asset_by_id(&conn, id).unwrap();
    assert!(asset.is_some());
    let asset = asset.unwrap();
    
    // Verify NULL values are handled correctly
    assert_eq!(asset.sha256, None);
    assert_eq!(asset.xxh64, None);
    assert_eq!(asset.taken_at, None);
    assert_eq!(asset.camera_make, None);
}


use nazr_backend_sqlite::db;
use nazr_backend_sqlite::db::writer;
use tempfile::TempDir;

fn setup_test_db() -> (TempDir, rusqlite::Connection) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let conn = db::open_or_create(&db_path).unwrap();
    (tmp, conn)
}

#[test]
fn test_add_scan_path() {
    let (_tmp, conn) = setup_test_db();
    
    let id = writer::add_scan_path(&conn, "/test/path").unwrap();
    assert!(id > 0);
    
    // Verify path was added
    let paths: Vec<String> = conn.query_row(
        "SELECT path FROM scan_paths WHERE id = ?",
        rusqlite::params![id],
        |r| Ok(r.get(0)?)
    ).unwrap();
    assert_eq!(paths.len(), 1);
}

#[test]
fn test_remove_scan_path() {
    let (_tmp, conn) = setup_test_db();
    
    let id = writer::add_scan_path(&conn, "/test/path").unwrap();
    let removed = writer::remove_scan_path(&conn, "/test/path").unwrap();
    assert!(removed);
    
    // Verify path was removed
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scan_paths WHERE id = ?",
        rusqlite::params![id],
        |r| r.get(0)
    ).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_create_album() {
    let (_tmp, conn) = setup_test_db();
    
    let id = writer::create_album(&conn, "Test Album", Some("Test Description")).unwrap();
    assert!(id > 0);
    
    // Verify album was created
    let (name, description): (String, Option<String>) = conn.query_row(
        "SELECT name, description FROM albums WHERE id = ?",
        rusqlite::params![id],
        |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap();
    assert_eq!(name, "Test Album");
    assert_eq!(description, Some("Test Description".to_string()));
}

#[test]
fn test_update_album() {
    let (_tmp, conn) = setup_test_db();
    
    let id = writer::create_album(&conn, "Test Album", None).unwrap();
    let updated = writer::update_album(&conn, id, Some("Updated Album"), Some("Updated Description")).unwrap();
    assert!(updated);
    
    // Verify update
    let (name, description): (String, Option<String>) = conn.query_row(
        "SELECT name, description FROM albums WHERE id = ?",
        rusqlite::params![id],
        |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap();
    assert_eq!(name, "Updated Album");
    assert_eq!(description, Some("Updated Description".to_string()));
}

#[test]
fn test_delete_album() {
    let (_tmp, conn) = setup_test_db();
    
    let id = writer::create_album(&conn, "Test Album", None).unwrap();
    let deleted = writer::delete_album(&conn, id).unwrap();
    assert!(deleted);
    
    // Verify deletion
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM albums WHERE id = ?",
        rusqlite::params![id],
        |r| r.get(0)
    ).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_add_assets_to_album() {
    let (_tmp, conn) = setup_test_db();
    
    // Create album
    let album_id = writer::create_album(&conn, "Test Album", None).unwrap();
    
    // Insert assets
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    let asset_id1: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo1.jpg"], |r| r.get(0)).unwrap();
    
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo2.jpg", "/test", "photo2.jpg", "jpg", 2000, 2000000, 2000000, "image/jpeg", 0]
    ).unwrap();
    let asset_id2: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo2.jpg"], |r| r.get(0)).unwrap();
    
    // Add assets to album
    let count = writer::add_assets_to_album(&conn, album_id, &[asset_id1, asset_id2]).unwrap();
    assert_eq!(count, 2);
    
    // Verify assets were added
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM album_assets WHERE album_id = ?",
        rusqlite::params![album_id],
        |r| r.get(0)
    ).unwrap();
    assert_eq!(count, 2);
}

#[test]
fn test_remove_assets_from_album() {
    let (_tmp, conn) = setup_test_db();
    
    // Create album and add assets
    let album_id = writer::create_album(&conn, "Test Album", None).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    let asset_id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo1.jpg"], |r| r.get(0)).unwrap();
    writer::add_assets_to_album(&conn, album_id, &[asset_id]).unwrap();
    
    // Remove asset from album
    let count = writer::remove_assets_from_album(&conn, album_id, &[asset_id]).unwrap();
    assert_eq!(count, 1);
    
    // Verify asset was removed
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM album_assets WHERE album_id = ?",
        rusqlite::params![album_id],
        |r| r.get(0)
    ).unwrap();
    assert_eq!(count, 0);
}


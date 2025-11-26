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
fn test_get_asset_by_id_not_found() {
    let (_tmp, conn) = setup_test_db();
    
    let asset = query::get_asset_by_id(&conn, 99999).unwrap();
    assert!(asset.is_none());
}

#[test]
fn test_get_asset_path_not_found() {
    let (_tmp, conn) = setup_test_db();
    
    let path = query::get_asset_path(&conn, 99999).unwrap();
    assert_eq!(path, None);
}

#[test]
fn test_delete_asset_by_id_not_found() {
    let (_tmp, conn) = setup_test_db();
    
    let deleted = query::delete_asset_by_id(&conn, 99999).unwrap();
    assert!(!deleted);
}

#[test]
fn test_search_assets_empty_query() {
    let (_tmp, conn) = setup_test_db();
    
    // Empty query should return all assets (if any)
    let result = query::search_assets(&conn, "", None, None, None, None, None, 0, 10).unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.items.len(), 0);
}

#[test]
fn test_list_assets_invalid_sort() {
    let (_tmp, conn) = setup_test_db();
    
    // Invalid sort should default to mtime_ns
    let result = query::list_assets(&conn, 0, 10, "invalid_sort", "desc").unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.items.len(), 0);
}

#[test]
fn test_list_assets_negative_offset() {
    let (_tmp, conn) = setup_test_db();
    
    // Negative offset should be handled gracefully (treated as 0)
    let result = query::list_assets(&conn, -10, 10, "none", "desc").unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.items.len(), 0);
}


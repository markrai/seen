use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use axum::serve;
use nazr_backend_sqlite::api::routes;
use nazr_backend_sqlite::db;
use tests::common::{create_test_app_state, setup_test_db, setup_test_fs, create_test_image, TestClient, wait_for_condition};

async fn setup_test_server() -> (TestClient, u16, tempfile::TempDir) {
    let (_tmp, root) = setup_test_fs();
    let (_tmp2, db_path, conn) = setup_test_db();
    let data = _tmp2.path().to_path_buf();
    
    let state = create_test_app_state(root, data, db_path.clone(), conn);
    let app = routes::router(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(&addr).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        serve(listener, app.into_make_service()).await.unwrap();
    });
    
    sleep(Duration::from_millis(100)).await;
    (TestClient::new(port), port, _tmp2)
}

#[tokio::test]
async fn test_assets_list_empty() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client.get("/assets").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 0);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_assets_list_with_data() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Insert test asset directly into database
    let db_path = _tmp.path().join("db").join("nazr.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    conn.execute(
        "INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (1, 'photo1.jpg', '/test', '/test/photo1.jpg')",
        []
    ).unwrap();
    
    let resp = client.get("/assets").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 1);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(body["items"][0]["filename"], "photo1.jpg");
}

#[tokio::test]
async fn test_assets_pagination() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Insert multiple test assets
    let db_path = _tmp.path().join("db").join("nazr.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    for i in 1..=5 {
        conn.execute(
            "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                format!("/test/photo{}.jpg", i),
                "/test",
                format!("photo{}.jpg", i),
                "jpg",
                1000,
                i * 1000000,
                i * 1000000,
                "image/jpeg",
                0
            ]
        ).unwrap();
        conn.execute(
            &format!("INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES ({}, 'photo{}.jpg', '/test', '/test/photo{}.jpg')", i, i, i),
            []
        ).unwrap();
    }
    
    // Test first page
    let resp = client.get("/assets?limit=2&offset=0").await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
    
    // Test second page
    let resp = client.get("/assets?limit=2&offset=2").await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn test_assets_search() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Insert test assets
    let db_path = _tmp.path().join("db").join("nazr.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    conn.execute(
        "INSERT INTO fts_assets(rowid, filename, dirname, path) VALUES (1, 'photo1.jpg', '/test', '/test/photo1.jpg')",
        []
    ).unwrap();
    
    let resp = client.get("/assets/search?q=photo1").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 1);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn test_assets_search_wildcard() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Insert test assets
    let db_path = _tmp.path().join("db").join("nazr.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/image2.png", "/test", "image2.png", "png", 2000, 2000000, 2000000, "image/png", 0]
    ).unwrap();
    
    let resp = client.get("/assets/search?q=*.jpg").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 1);
    assert_eq!(body["items"][0]["ext"], "jpg");
}

#[tokio::test]
async fn test_get_asset_by_id() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Insert test asset
    let db_path = _tmp.path().join("db").join("nazr.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO assets (path, dirname, filename, ext, size_bytes, mtime_ns, ctime_ns, mime, flags) VALUES 
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["/test/photo1.jpg", "/test", "photo1.jpg", "jpg", 1000, 1000000, 1000000, "image/jpeg", 0]
    ).unwrap();
    
    let id: i64 = conn.query_row("SELECT id FROM assets WHERE path = ?", rusqlite::params!["/test/photo1.jpg"], |r| r.get(0)).unwrap();
    
    let resp = client.get(&format!("/asset/{}", id)).await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["id"], id);
    assert_eq!(body["filename"], "photo1.jpg");
}

#[tokio::test]
async fn test_get_asset_not_found() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client.get("/asset/99999").await.unwrap();
    assert_eq!(resp.status(), 404);
}


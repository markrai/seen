use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use axum::serve;
use nazr_backend_sqlite::api::routes;
use tests::common::{create_test_app_state, setup_test_db, setup_test_fs, TestClient};

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
async fn test_get_scan_paths_empty() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client.get("/paths").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_add_scan_path() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client
        .post("/paths", &serde_json::json!({"path": "/test/path"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["id"].is_number());
    
    // Verify path was added
    let resp = client.get("/paths").await.unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0], "/test/path");
}

#[tokio::test]
async fn test_remove_scan_path() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Add a path first
    let resp = client
        .post("/paths", &serde_json::json!({"path": "/test/path"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    // Remove it
    let resp = client
        .delete("/paths?path=/test/path")
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    // Verify it's gone
    let resp = client.get("/paths").await.unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_get_path_status() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client.get("/paths/status").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_object());
}


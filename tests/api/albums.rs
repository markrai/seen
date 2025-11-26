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
async fn test_list_albums_empty() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client.get("/albums").await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_create_album() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    let resp = client
        .post("/albums", &serde_json::json!({"name": "Test Album", "description": "Test Description"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["id"].is_number());
    assert_eq!(body["name"], "Test Album");
    assert_eq!(body["description"], "Test Description");
}

#[tokio::test]
async fn test_get_album() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Create album
    let resp = client
        .post("/albums", &serde_json::json!({"name": "Test Album"}))
        .await
        .unwrap();
    let album_id = resp.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap();
    
    // Get album
    let resp = client.get(&format!("/albums/{}", album_id)).await.unwrap();
    assert_eq!(resp.status(), 200);
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["id"], album_id);
    assert_eq!(body["name"], "Test Album");
}

#[tokio::test]
async fn test_update_album() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Create album
    let resp = client
        .post("/albums", &serde_json::json!({"name": "Test Album"}))
        .await
        .unwrap();
    let album_id = resp.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap();
    
    // Update album
    let resp = client
        .put(&format!("/albums/{}", album_id), &serde_json::json!({"name": "Updated Album", "description": "Updated Description"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    // Verify update
    let resp = client.get(&format!("/albums/{}", album_id)).await.unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["name"], "Updated Album");
    assert_eq!(body["description"], "Updated Description");
}

#[tokio::test]
async fn test_delete_album() {
    let (client, _port, _tmp) = setup_test_server().await;
    
    // Create album
    let resp = client
        .post("/albums", &serde_json::json!({"name": "Test Album"}))
        .await
        .unwrap();
    let album_id = resp.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap();
    
    // Delete album
    let resp = client.delete(&format!("/albums/{}", album_id)).await.unwrap();
    assert_eq!(resp.status(), 200);
    
    // Verify deletion
    let resp = client.get(&format!("/albums/{}", album_id)).await.unwrap();
    assert_eq!(resp.status(), 404);
}


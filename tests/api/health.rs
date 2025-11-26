use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use axum::serve;
use nazr_backend_sqlite::api::routes;
use tests::common::{create_test_app_state, setup_test_db, setup_test_fs};

#[tokio::test]
async fn test_health_endpoint() {
    let (_tmp, root) = setup_test_fs();
    let (_tmp2, _db_path, conn) = setup_test_db();
    let data = _tmp2.path().to_path_buf();
    let db_path = _tmp2.path().join("db").join("nazr.db");
    
    let state = create_test_app_state(root, data, db_path, conn);
    let app = routes::router(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(&addr).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        serve(listener, app.into_make_service()).await.unwrap();
    });
    
    // Wait for server to start
    sleep(Duration::from_millis(100)).await;
    
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("http://127.0.0.1:{}/health", port))
        .send()
        .await
        .unwrap();
    
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["database"], "SQLite");
    assert!(body["version"].is_string());
}


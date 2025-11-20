use std::net::SocketAddr;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::time::{sleep, Duration};
use axum::Server;

#[tokio::test]
async fn smoke_end_to_end() {
    let _ = std::env::set_var("RUST_LOG", "info");
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("photos");
    let data = tmp.path().join("flash-data");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let img_bytes = base64::decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCABkAGQDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB3AAAAAP/Z").unwrap();
    std::fs::write(root.join("a.jpg"), &img_bytes).unwrap();
    std::fs::write(root.join("b.jpg"), &img_bytes).unwrap();

    let cfg = nazr_backend_sqlite::utils::config::Config::from_env();
    let _ = std::env::set_var("FLASH_ROOT", root.to_string_lossy().to_string());
    let _ = std::env::set_var("FLASH_DATA", data.to_string_lossy().to_string());
    let _ = std::env::set_var("FLASH_PORT", "18080");

    let data_dir = data.clone();
    let db_dir = data_dir.join("db");
    let derived_dir = data_dir.join("derived");
    std::fs::create_dir_all(&db_dir).unwrap();
    std::fs::create_dir_all(&derived_dir).unwrap();
    let db_path = db_dir.join("nazr.db");
    let conn = nazr_backend_sqlite::db::open_or_create(&db_path).unwrap();
    let _app = libvips::VipsApp::new("nazr", false).unwrap();

    let (discover_tx, discover_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::discover::DiscoverItem>(100_000);
    let (hash_tx, hash_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::hash::HashJob>(4_096);
    let (meta_tx, meta_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::metadata::MetaJob>(4_096);
    let (db_tx, db_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::db::writer::DbWriteItem>(65_536);
    let (thumb_tx, thumb_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::thumb::ThumbJob>(16_384);

    let gauges = std::sync::Arc::new(nazr_backend_sqlite::pipeline::QueueGauges::default());
    let stats = Arc::new(nazr_backend_sqlite::stats::Stats::new());
    nazr_backend_sqlite::pipeline::discover::start_forwarder(discover_rx, hash_tx.clone(), gauges.clone());
    nazr_backend_sqlite::pipeline::hash::start_workers(1, hash_rx, meta_tx.clone(), gauges.clone());
    nazr_backend_sqlite::pipeline::metadata::start_workers(1, meta_rx, db_tx.clone(), gauges.clone());
    {
        let dbp = db_path.clone();
        let tt = thumb_tx.clone();
        let gauges2 = gauges.clone();
        let stats2 = stats.clone();
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            if let Ok(conn2) = rusqlite::Connection::open(dbp) {
                let _ = nazr_backend_sqlite::db::writer::run_writer(handle, db_rx, conn2, 4096, tt, gauges2, Some(stats2));
            }
        });
    }
    nazr_backend_sqlite::pipeline::thumb::start_workers(1, thumb_rx, derived_dir.clone(), db_path.clone(), 256, 1600, gauges.clone());

    let paths = nazr_backend_sqlite::AppPaths { root: root.clone(), root_host: None, data: data.clone(), db_path: db_path.clone(), derived: derived_dir.clone() };
    let queues = nazr_backend_sqlite::pipeline::Queues { discover_tx: discover_tx.clone(), hash_tx: hash_tx.clone(), meta_tx: meta_tx.clone(), db_tx: db_tx.clone(), thumb_tx: thumb_tx.clone() };
    let state = Arc::new(nazr_backend_sqlite::AppState::new(paths, conn, queues, gauges.clone()));
    let app = nazr_backend_sqlite::api::routes::router(state.clone());
    let addr = SocketAddr::from(([127,0,0,1], 18080));
    tokio::spawn(async move { Server::bind(&addr).serve(app.into_make_service()).await.unwrap(); });

    let client = reqwest::Client::new();
    let _ = client.post("http://127.0.0.1:18080/scan").json(&serde_json::json!({"paths":[root.to_string_lossy().to_string()]})).send().await.unwrap();

    let mut attempts = 0;
    loop {
        attempts += 1;
        if attempts > 50 { break; }
        let st = client.get("http://127.0.0.1:18080/stats").send().await.unwrap().json::<serde_json::Value>().await.unwrap();
        let assets = st.get("db").and_then(|v| v.get("assets")).and_then(|v| v.as_i64()).unwrap_or(0);
        if assets >= 2 { break; }
        sleep(Duration::from_millis(200)).await;
    }

    let listing = client.get("http://127.0.0.1:18080/assets").send().await.unwrap().json::<serde_json::Value>().await.unwrap();
    let items = listing.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    assert!(items.len() >= 2);
    let id = items[0].get("id").and_then(|v| v.as_i64()).unwrap();
    let resp = client.get(format!("http://127.0.0.1:18080/thumb/{id}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
}

use std::net::SocketAddr;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::time::{sleep, Duration};
use axum::serve;
use tokio::net::{TcpListener, TcpStream};
use parking_lot::Mutex;
use nazr_backend_sqlite::pipeline::face::{FaceProcessor, FaceIndex};

async fn wait_for_port(port: u16) {
    for _ in 0..30 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Server never started");
}

#[tokio::test]
async fn smoke_end_to_end() {
    // Use eprintln! for immediate output that shows even without --nocapture
    eprintln!("[TEST] Starting smoke_end_to_end test");
    let result = tokio::time::timeout(std::time::Duration::from_secs(120), async {
    eprintln!("[TEST] Setting up environment variables");
    let _ = std::env::set_var("RUST_LOG", "info");
    // Disable face model auto-download to avoid hanging on network requests
    let _ = std::env::set_var("NAZR_FACE_AUTO_DOWNLOAD", "0");
    eprintln!("[TEST] Creating temp directory");
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("photos");
    let data = tmp.path().join("flash-data");
    eprintln!("[TEST] Creating directories: root={:?}, data={:?}", root, data);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    eprintln!("[TEST] Directories created");
    
    // Create valid minimal JPEG images (1x1 pixel) to avoid libvips hanging on corrupt data
    eprintln!("[TEST] Creating test JPEG images");
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(1, 1));
    let mut img_bytes = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut img_bytes), image::ImageOutputFormat::Jpeg(85))
        .unwrap();
    let file_a = root.join("a.jpg");
    let file_b = root.join("b.jpg");
    std::fs::write(&file_a, &img_bytes).unwrap();
    std::fs::write(&file_b, &img_bytes).unwrap();
    eprintln!("[TEST] Created test images: a.jpg ({} bytes), b.jpg ({} bytes)", 
             std::fs::metadata(&file_a).unwrap().len(),
             std::fs::metadata(&file_b).unwrap().len());
    
    // Small delay to ensure files are fully written to disk
    eprintln!("[TEST] Waiting for files to be written to disk");
    sleep(Duration::from_millis(100)).await;

    eprintln!("[TEST] Setting up configuration");
    let _cfg = nazr_backend_sqlite::utils::config::Config::from_env();
    let _ = std::env::set_var("FLASH_ROOT", root.to_string_lossy().to_string());
    let _ = std::env::set_var("FLASH_DATA", data.to_string_lossy().to_string());
    let _ = std::env::set_var("FLASH_PORT", "18080");
    eprintln!("[TEST] Configuration set");

    let data_dir = data.clone();
    let db_dir = data_dir.join("db");
    let derived_dir = data_dir.join("derived");
    std::fs::create_dir_all(&db_dir).unwrap();
    std::fs::create_dir_all(&derived_dir).unwrap();
    let db_path = db_dir.join("nazr.db");
    eprintln!("[TEST] Opening database: {:?}", db_path);
    let conn = nazr_backend_sqlite::db::open_or_create(&db_path).unwrap();
    eprintln!("[TEST] Initializing libvips");
    let _app = libvips::VipsApp::new("nazr", false).unwrap();
    eprintln!("[TEST] libvips initialized");

    let (discover_tx, discover_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::discover::DiscoverItem>(100_000);
    let (hash_tx, hash_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::hash::HashJob>(4_096);
    let (meta_tx, meta_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::metadata::MetaJob>(4_096);
    let (db_tx, db_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::db::writer::DbWriteItem>(65_536);
    let (thumb_tx, thumb_rx) = tokio::sync::mpsc::channel::<nazr_backend_sqlite::pipeline::thumb::ThumbJob>(16_384);
    let (face_tx, _face_rx) = tokio::sync::mpsc::channel(10);

    eprintln!("[TEST] Starting pipeline workers");
    let gauges = std::sync::Arc::new(nazr_backend_sqlite::pipeline::QueueGauges::default());
    let stats = Arc::new(nazr_backend_sqlite::stats::Stats::new());
    eprintln!("[TEST] Starting discover forwarder");
    nazr_backend_sqlite::pipeline::discover::start_forwarder(discover_rx, hash_tx.clone(), None, None, gauges.clone(), None);
    eprintln!("[TEST] Starting hash workers");
    nazr_backend_sqlite::pipeline::hash::start_workers(1, hash_rx, meta_tx.clone(), gauges.clone());
    eprintln!("[TEST] Starting metadata workers");
    nazr_backend_sqlite::pipeline::metadata::start_workers(1, meta_rx, db_tx.clone(), gauges.clone());
    eprintln!("[TEST] Starting database writer thread");
    {
        let dbp = db_path.clone();
        let tt = thumb_tx.clone();
        let gauges2 = gauges.clone();
        let stats2 = stats.clone();
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            if let Ok(conn2) = rusqlite::Connection::open(dbp.clone()) {
                let _ = nazr_backend_sqlite::db::writer::run_writer(handle, db_rx, conn2, 4096, tt, gauges2, Some(stats2), None, None, dbp);
            }
        });
    }
    eprintln!("[TEST] Starting thumbnail workers");
    nazr_backend_sqlite::pipeline::thumb::start_workers(1, thumb_rx, derived_dir.clone(), 256, 1600, gauges.clone());
    eprintln!("[TEST] All pipeline workers started");

    let paths = nazr_backend_sqlite::AppPaths { root: root.clone(), root_host: None, data: data.clone(), db_path: db_path.clone(), derived: derived_dir.clone() };
    let queues = nazr_backend_sqlite::pipeline::Queues { discover_tx: discover_tx.clone(), hash_tx: hash_tx.clone(), meta_tx: meta_tx.clone(), db_tx: db_tx.clone(), thumb_tx: thumb_tx.clone(), face_tx: face_tx.clone() };
    eprintln!("[TEST] Creating app state and router");
    let models_dir = data_dir.join("models");
    let processor = Arc::new(Mutex::new(FaceProcessor::new(models_dir)));
    let index = Arc::new(Mutex::new(FaceIndex::new()));
    let state = Arc::new(nazr_backend_sqlite::AppState::new(paths, conn, queues, gauges.clone(), stats.clone(), processor, index));
    let app = nazr_backend_sqlite::api::routes::router(state.clone());
    let addr = SocketAddr::from(([127,0,0,1], 18080));
    eprintln!("[TEST] Spawning server on {}", addr);
    let server_handle = tokio::spawn(async move {
        let listener = TcpListener::bind(addr).await.unwrap();
        eprintln!("[TEST] Server bound to {}", addr);
        serve(listener, app).await.unwrap();
    });

    // Give server time to bind to 127.0.0.1:18080
    eprintln!("[TEST] Waiting for server to bind to port 18080");
    wait_for_port(18080).await;
    eprintln!("[TEST] Server is ready");

    eprintln!("[TEST] Creating HTTP client");
    let client = reqwest::Client::new();
    // Use POST /paths to add the scan path (automatically starts scanning)
    let root_path_str = root.to_string_lossy().to_string();
    eprintln!("[TEST] Adding scan path: {:?}", root_path_str);
    eprintln!("[TEST] Files in root before scan: {:?}", 
             std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>());
    eprintln!("[TEST] Sending POST /paths request");
    let resp = client.post("http://127.0.0.1:18080/paths")
        .json(&serde_json::json!({"path": root_path_str}))
        .send()
        .await
        .unwrap();
    eprintln!("[TEST] Scan path added, status: {}, response: {:?}", resp.status(), resp.text().await.unwrap_or_default());

    let mut attempts = 0;
    loop {
        attempts += 1;
        if attempts > 100 { 
            eprintln!("[TEST] Timeout waiting for assets in stats after {} attempts", attempts);
            break; 
        }
        let st = client.get("http://127.0.0.1:18080/stats").send().await.unwrap().json::<serde_json::Value>().await.unwrap();
        let assets = st.get("db").and_then(|v| v.get("assets")).and_then(|v| v.as_i64()).unwrap_or(0);
        let scan_running = st.get("scan_running").and_then(|v| v.as_bool()).unwrap_or(false);
        let processing_active = st.get("processing_active").and_then(|v| v.as_bool()).unwrap_or(false);
        eprintln!("[TEST] Stats (attempt {}): assets={}, scan_running={}, processing_active={}", 
                 attempts, assets, scan_running, processing_active);
        if assets >= 2 { break; }
        sleep(Duration::from_millis(200)).await;
    }

    // Wait for assets to actually be queryable (not just counted in stats)
    let mut attempts = 0;
    loop {
        attempts += 1;
        if attempts > 100 { 
            eprintln!("[TEST] Giving up waiting for assets after {} attempts", attempts);
            break; 
        }
        let listing = client.get("http://127.0.0.1:18080/assets").send().await.unwrap().json::<serde_json::Value>().await.unwrap();
        let total = listing.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
        let items = listing.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        eprintln!("[TEST] Assets endpoint: total={}, items.len()={} (attempt {})", total, items.len(), attempts);
        if !items.is_empty() { break; }
        sleep(Duration::from_millis(200)).await;
    }

    eprintln!("[TEST] Final check - getting assets");
    let listing = client.get("http://127.0.0.1:18080/assets").send().await.unwrap().json::<serde_json::Value>().await.unwrap();
    let total = listing.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let items = listing.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    eprintln!("[TEST] Final check - total={}, ITEMS = {:#?}", total, items);
    assert!(!items.is_empty());
    let id = items[0].get("id").and_then(|v| v.as_i64()).unwrap();
    eprintln!("[TEST] Fetching thumbnail for asset id={}", id);
    
    // Wait for thumbnail to be generated (it's generated asynchronously)
    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        if attempts > 50 {
            eprintln!("[TEST] Timeout waiting for thumbnail after {} attempts", attempts);
            break client.get(format!("http://127.0.0.1:18080/thumb/{id}")).send().await.unwrap();
        }
        let r = client.get(format!("http://127.0.0.1:18080/thumb/{id}")).send().await.unwrap();
        if r.status() == 200 {
            eprintln!("[TEST] Thumbnail ready after {} attempts", attempts);
            break r;
        }
        eprintln!("[TEST] Thumbnail not ready yet (status: {}), attempt {}", r.status(), attempts);
        sleep(Duration::from_millis(200)).await;
    };
    
    eprintln!("[TEST] Thumbnail response status: {}", resp.status());
    assert_eq!(resp.status(), 200);
    eprintln!("[TEST] Test completed successfully!");
    
    // Abort the server task so the test can exit cleanly
    eprintln!("[TEST] Aborting server task");
    server_handle.abort();
    
    // Close channels to signal all pipeline workers to shut down
    eprintln!("[TEST] Closing channels to shut down workers");
    drop(discover_tx);
    drop(hash_tx);
    drop(meta_tx);
    drop(db_tx);
    drop(thumb_tx);
    drop(face_tx);
    
    // Give workers a moment to shut down
    sleep(Duration::from_millis(500)).await;
    eprintln!("[TEST] Test async block ending");
    }).await;
    eprintln!("[TEST] Timeout wrapper completed");
    result.expect("Test timed out after 120 seconds");
    eprintln!("[TEST] Test function returning");
}

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use axum::serve;
use nazr_backend_sqlite::api::routes;
use nazr_backend_sqlite::db;
use nazr_backend_sqlite::pipeline;
use tests::common::{create_test_app_state, setup_test_db, setup_test_fs, create_test_image, TestClient, wait_for_condition};

#[tokio::test]
async fn test_full_scan_pipeline() {
    let (_tmp, root) = setup_test_fs();
    let (_tmp2, db_path, conn) = setup_test_db();
    let data = _tmp2.path().to_path_buf();
    let db_dir = data.join("db");
    let derived_dir = data.join("derived");
    std::fs::create_dir_all(&db_dir).unwrap();
    std::fs::create_dir_all(&derived_dir).unwrap();
    
    // Create test images
    create_test_image(&root.join("photo1.jpg")).unwrap();
    create_test_image(&root.join("photo2.jpg")).unwrap();
    
    let _app = libvips::VipsApp::new("nazr", false).unwrap();
    
    // Setup pipeline
    let (discover_tx, discover_rx) = tokio::sync::mpsc::channel::<pipeline::discover::DiscoverItem>(100);
    let (hash_tx, hash_rx) = tokio::sync::mpsc::channel::<pipeline::hash::HashJob>(100);
    let (meta_tx, meta_rx) = tokio::sync::mpsc::channel::<pipeline::metadata::MetaJob>(100);
    let (db_tx, db_rx) = tokio::sync::mpsc::channel::<db::writer::DbWriteItem>(100);
    let (thumb_tx, thumb_rx) = tokio::sync::mpsc::channel::<pipeline::thumb::ThumbJob>(100);
    #[cfg(feature = "facial-recognition")]
    let (face_tx, _face_rx) = tokio::sync::mpsc::channel::<pipeline::face::FaceJob>(100);
    
    let gauges = Arc::new(pipeline::QueueGauges::default());
    let stats = Arc::new(nazr_backend_sqlite::stats::Stats::new());
    
    pipeline::discover::start_forwarder(discover_rx, hash_tx.clone(), Some(meta_tx.clone()), Some(db_path.clone()), gauges.clone(), Some(stats.clone()));
    pipeline::hash::start_workers(1, hash_rx, meta_tx.clone(), gauges.clone());
    pipeline::metadata::start_workers(1, meta_rx, db_tx.clone(), gauges.clone());
    
    {
        let dbp = db_path.clone();
        let tt = thumb_tx.clone();
        let gauges2 = gauges.clone();
        let stats2 = stats.clone();
        #[cfg(feature = "facial-recognition")]
        let face_tx_for_writer = face_tx.clone();
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            if let Ok(conn2) = rusqlite::Connection::open(dbp.clone()) {
                #[cfg(feature = "facial-recognition")]
                {
                    let models_dir = dbp.parent().unwrap().parent().unwrap().join("models");
                    let face_processor = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceProcessor::new(models_dir)));
                    let _ = db::writer::run_writer(handle, db_rx, conn2, 4096, tt, gauges2, Some(stats2), Some(face_tx_for_writer), Some(face_processor.clone()), dbp);
                }
                #[cfg(not(feature = "facial-recognition"))]
                {
                    let _ = db::writer::run_writer(handle, db_rx, conn2, 4096, tt, gauges2, Some(stats2));
                }
            }
        });
    }
    pipeline::thumb::start_workers(1, thumb_rx, derived_dir.clone(), 256, 1600, gauges.clone());
    
    let paths = nazr_backend_sqlite::AppPaths {
        root: root.clone(),
        root_host: None,
        data: data.clone(),
        db_path: db_path.clone(),
        derived: derived_dir.clone(),
    };
    #[cfg(feature = "facial-recognition")]
    let queues = nazr_backend_sqlite::pipeline::Queues {
        discover_tx: discover_tx.clone(),
        hash_tx: hash_tx.clone(),
        meta_tx: meta_tx.clone(),
        db_tx: db_tx.clone(),
        thumb_tx: thumb_tx.clone(),
        face_tx: face_tx.clone(),
    };
    #[cfg(not(feature = "facial-recognition"))]
    let queues = nazr_backend_sqlite::pipeline::Queues {
        discover_tx: discover_tx.clone(),
        hash_tx: hash_tx.clone(),
        meta_tx: meta_tx.clone(),
        db_tx: db_tx.clone(),
        thumb_tx: thumb_tx.clone(),
    };
    let state = {
        #[cfg(feature = "facial-recognition")]
        {
            let models_dir = data.join("models");
            let face_processor = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceProcessor::new(models_dir)));
            let face_index = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceIndex::new()));
            Arc::new(nazr_backend_sqlite::AppState::new(paths, conn, queues, gauges.clone(), stats.clone(), face_processor, face_index))
        }
        #[cfg(not(feature = "facial-recognition"))]
        {
            Arc::new(nazr_backend_sqlite::AppState::new(paths, conn, queues, gauges.clone(), stats.clone()))
        }
    };
    let app = routes::router(state.clone());
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(&addr).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        serve(listener, app.into_make_service()).await.unwrap();
    });
    
    sleep(Duration::from_millis(100)).await;
    
    let client = TestClient::new(port);
    
    // First add the path to scan paths
    let root_str = root.to_string_lossy().to_string();
    let resp = client
        .post("/paths", &serde_json::json!({"path": root_str.clone()}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    // Then scan it
    let resp = client
        .post("/paths/scan", &serde_json::json!({"path": root_str}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    
    // Wait for assets to be processed
    wait_for_condition(|| {
        let dbp = db_path.clone();
        if let Ok(conn) = rusqlite::Connection::open(dbp) {
            if let Ok(count) = nazr_backend_sqlite::db::query::count_assets(&conn) {
                return count >= 2;
            }
        }
        false
    }, 50, 200).await;
    
    // Verify assets are in database
    let resp = client.get("/assets").await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["total"].as_i64().unwrap() >= 2);
    assert!(body["items"].as_array().unwrap().len() >= 2);
}


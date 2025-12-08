use std::net::SocketAddr;
use std::sync::Arc;
use nazr_backend_sqlite::utils::config::Config;
use nazr_backend_sqlite::utils::logging;
use nazr_backend_sqlite::db;
use nazr_backend_sqlite::pipeline::{self, discover, hash, metadata, thumb};
use tokio::sync::mpsc;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Suppress VIPS/GLib warnings about EXIF metadata issues (null bytes, unknown fields)
    // These are harmless but clutter logs and add I/O overhead
    std::env::set_var("G_MESSAGES_DEBUG", "");
    std::env::set_var("VIPS_WARNING", "0");
    
    logging::init();
    let cfg = Config::from_env();
    let data_dir = cfg.data.clone();
    let db_dir = data_dir.join("db");
    let derived_dir = data_dir.join("derived");
    std::fs::create_dir_all(&db_dir)?;
    std::fs::create_dir_all(&derived_dir)?;
    let db_path = db_dir.join("nazr.db");
    // Create connection pool with 10 connections (good for SQLite WAL mode)
    let pool = db::create_pool(&db_path, 10)?;
    // Initialize libvips (warnings are suppressed via environment variables set above)
    #[cfg(not(target_env = "msvc"))]
    let _app = libvips::VipsApp::new("nazr", false)?;
    #[cfg(target_env = "msvc")]
    let _app = (); // libvips doesn't compile on Windows MSVC
    
    // Initialize GPU configuration
    let _gpu_config = nazr_backend_sqlite::utils::ffmpeg::init_gpu_config();

    let (discover_tx, discover_rx) = mpsc::channel::<discover::DiscoverItem>(100_000);
    let (hash_tx, hash_rx) = mpsc::channel::<hash::HashJob>(4_096);
    let (meta_tx, meta_rx) = mpsc::channel::<metadata::MetaJob>(4_096);
    let (db_tx, db_rx) = mpsc::channel::<db::writer::DbWriteItem>(65_536);
    let (thumb_tx, thumb_rx) = mpsc::channel::<thumb::ThumbJob>(16_384);
    #[cfg(feature = "facial-recognition")]
    let (face_tx, face_rx) = mpsc::channel::<pipeline::face::FaceJob>(4_096);

    let gauges = Arc::new(pipeline::QueueGauges::default());
    
    // Create stats first so we can initialize it and pass it to forwarder
    let stats = Arc::new(nazr_backend_sqlite::stats::Stats::new());
    
    // Initialize files_committed from database count on startup
    {
        let dbp = db_path.clone();
        let stats_clone = stats.clone();
        tokio::spawn(async move {
            if let Ok(Some(count)) = tokio::task::spawn_blocking(move || {
                let conn = rusqlite::Connection::open(dbp).ok()?;
                db::query::count_assets(&conn).ok()
            }).await {
                stats_clone.init_files_committed(count as u64);
            }
        });
    }
    
    discover::start_forwarder(discover_rx, hash_tx.clone(), Some(meta_tx.clone()), Some(db_path.clone()), gauges.clone(), Some(stats.clone()));
    hash::start_workers(cfg.hash_threads, hash_rx, meta_tx.clone(), gauges.clone());
    metadata::start_workers(cfg.meta_threads, meta_rx, db_tx.clone(), gauges.clone());
    // Initialize face processor (only if feature enabled)
    #[cfg(feature = "facial-recognition")]
    let models_dir = data_dir.join("models");
    #[cfg(feature = "facial-recognition")]
    let face_processor = pipeline::face::FaceProcessor::new(models_dir);
    #[cfg(feature = "facial-recognition")]
    let face_processor_arc = Arc::new(parking_lot::Mutex::new(face_processor));
    // Initialize asynchronously in background
    #[cfg(feature = "facial-recognition")]
    {
        let processor = face_processor_arc.clone();
        tokio::spawn(async move {
            // Get models_dir before holding lock, then drop lock before await
            let models_dir = {
                let proc = processor.lock();
                proc.models_dir.clone()
            };
            // Now initialize without holding lock
            let mut temp_processor = pipeline::face::FaceProcessor::new(models_dir);
            if let Err(e) = temp_processor.initialize().await {
                tracing::error!("Failed to initialize face processor: {}", e);
            } else {
                // Update the shared processor with loaded models
                let mut proc = processor.lock();
                *proc = temp_processor;
            }
        });
    }
    
    // Initialize face index
    #[cfg(feature = "facial-recognition")]
    let face_index = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceIndex::new()));
    
    let paths = nazr_backend_sqlite::AppPaths { root: cfg.root.clone(), root_host: cfg.root_host.clone(), data: cfg.data.clone(), db_path: db_path.clone(), derived: derived_dir.clone() };
    #[cfg(feature = "facial-recognition")]
    let queues = pipeline::Queues { discover_tx: discover_tx.clone(), hash_tx: hash_tx.clone(), meta_tx: meta_tx.clone(), db_tx: db_tx.clone(), thumb_tx: thumb_tx.clone(), face_tx: face_tx.clone() };
    #[cfg(not(feature = "facial-recognition"))]
    let queues = pipeline::Queues { discover_tx: discover_tx.clone(), hash_tx: hash_tx.clone(), meta_tx: meta_tx.clone(), db_tx: db_tx.clone(), thumb_tx: thumb_tx.clone() };
    #[cfg(feature = "facial-recognition")]
    let state = Arc::new(nazr_backend_sqlite::AppState::new(paths, pool, queues, gauges.clone(), stats.clone(), face_processor_arc.clone(), face_index.clone()));
    #[cfg(not(feature = "facial-recognition"))]
    let state = Arc::new(nazr_backend_sqlite::AppState::new(paths, pool, queues, gauges.clone(), stats.clone()));
    
    // Note: File watchers are now started dynamically when paths are added or scans are started
    // The old static watcher has been removed in favor of per-path watchers
    
    {
        let dbp = db_path.clone();
        let tt = thumb_tx.clone();
        let gauges2 = gauges.clone();
        let stats = state.stats.clone();
        #[cfg(feature = "facial-recognition")]
        let face_tx_for_writer = state.queues.face_tx.clone();
        #[cfg(feature = "facial-recognition")]
        let face_processor_for_writer = face_processor_arc.clone();
        #[cfg(feature = "facial-recognition")]
        let db_path_for_writer = db_path.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(conn2) = rusqlite::Connection::open(dbp.clone()) {
                let handle = tokio::runtime::Handle::current();
                #[cfg(feature = "facial-recognition")]
                {
                    let writer_config = db::writer::WriterConfig {
                        handle,
                        rx: db_rx,
                        conn: conn2,
                        fts_batch_size: 4096,
                        thumb_tx: tt,
                        gauges: gauges2,
                        stats: Some(stats),
                        #[cfg(feature = "facial-recognition")]
                        face_tx: Some(face_tx_for_writer),
                        #[cfg(feature = "facial-recognition")]
                        face_processor: Some(face_processor_for_writer),
                        #[cfg(feature = "facial-recognition")]
                        db_path: Some(db_path_for_writer),
                    };
                    if let Err(e) = db::writer::run_writer(writer_config) {
                        eprintln!("CRITICAL: DB writer thread exited with error: {:?}", e);
                    }
                }
                #[cfg(not(feature = "facial-recognition"))]
                {
                    let writer_config = db::writer::WriterConfig {
                        handle,
                        rx: db_rx,
                        conn: conn2,
                        fts_batch_size: 4096,
                        thumb_tx: tt,
                        gauges: gauges2,
                        stats: Some(stats),
                        #[cfg(feature = "facial-recognition")]
                        face_tx: None,
                        #[cfg(feature = "facial-recognition")]
                        face_processor: None,
                        #[cfg(feature = "facial-recognition")]
                        db_path: None,
                    };
                    if let Err(e) = db::writer::run_writer(writer_config) {
                        eprintln!("CRITICAL: DB writer thread exited with error: {:?}", e);
                    }
                }
            } else {
                eprintln!("CRITICAL: Failed to open database connection");
            }
        });
    }
    thumb::start_workers(cfg.thumb_threads, thumb_rx, derived_dir.clone(), cfg.thumb_size, cfg.preview_size, gauges.clone());
    
    // Start face workers (only if feature enabled)
    #[cfg(feature = "facial-recognition")]
    {
        let processor = face_processor_arc.clone();
        let dbp = db_path.clone();
        let g = gauges.clone();
        let idx = face_index.clone();
        let n_workers = std::env::var("FLASH_FACE_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        tokio::spawn(async move {
            pipeline::face::start_face_workers(n_workers, face_rx, processor, dbp, g, idx).await;
        });
    }
    let app = nazr_backend_sqlite::api::routes::router(state.clone());
    let addr = SocketAddr::from(([0,0,0,0], cfg.port));
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("listening" = %addr);
    axum::serve(listener, app).await?;
    Ok(())
}

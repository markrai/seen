pub mod utils;
pub mod stats;
pub mod models;
pub mod db;
pub mod pipeline;
pub mod api;

use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;

#[derive(Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub root_host: Option<String>,
    pub data: PathBuf,
    pub db_path: PathBuf,
    pub derived: PathBuf,
}

#[derive(Clone)]
pub struct AppState {
    pub started_at: std::time::Instant,
    pub paths: AppPaths,
    pub stats: Arc<stats::Stats>,
    pub db_path: PathBuf,
    pub scanner_ctl: broadcast::Sender<()>,
    pub queues: pipeline::Queues,
    pub gauges: Arc<pipeline::QueueGauges>,
    pub db: Arc<Mutex<rusqlite::Connection>>, 
    pub scan_running: Arc<AtomicBool>,
    pub path_scan_running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub path_watcher_paused: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub path_watchers: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    #[cfg(feature = "facial-recognition")]
    pub face_detection_enabled: Arc<AtomicBool>,
    #[cfg(feature = "facial-recognition")]
    pub face_processor: Arc<parking_lot::Mutex<pipeline::face::FaceProcessor>>,
    #[cfg(feature = "facial-recognition")]
    pub face_index: Arc<parking_lot::Mutex<pipeline::face::FaceIndex>>,
}

impl AppState {
    #[cfg(feature = "facial-recognition")]
    pub fn new(paths: AppPaths, db: rusqlite::Connection, queues: pipeline::Queues, gauges: Arc<pipeline::QueueGauges>, stats: Arc<stats::Stats>, face_processor: Arc<parking_lot::Mutex<pipeline::face::FaceProcessor>>, face_index: Arc<parking_lot::Mutex<pipeline::face::FaceIndex>>) -> Self {
        let (tx, _) = broadcast::channel(8);
        Self {
            started_at: std::time::Instant::now(),
            db_path: paths.db_path.clone(),
            paths,
            stats,
            scanner_ctl: tx,
            queues,
            gauges,
            db: Arc::new(Mutex::new(db)),
            scan_running: Arc::new(AtomicBool::new(false)),
            path_scan_running: Arc::new(Mutex::new(HashMap::new())),
            path_watcher_paused: Arc::new(Mutex::new(HashMap::new())),
            path_watchers: Arc::new(Mutex::new(HashMap::new())),
            face_detection_enabled: Arc::new(AtomicBool::new(false)),
            face_processor,
            face_index,
        }
    }

    #[cfg(not(feature = "facial-recognition"))]
    pub fn new(paths: AppPaths, db: rusqlite::Connection, queues: pipeline::Queues, gauges: Arc<pipeline::QueueGauges>, stats: Arc<stats::Stats>) -> Self {
        let (tx, _) = broadcast::channel(8);
        Self {
            started_at: std::time::Instant::now(),
            db_path: paths.db_path.clone(),
            paths,
            stats,
            scanner_ctl: tx,
            queues,
            gauges,
            db: Arc::new(Mutex::new(db)),
            scan_running: Arc::new(AtomicBool::new(false)),
            path_scan_running: Arc::new(Mutex::new(HashMap::new())),
            path_watcher_paused: Arc::new(Mutex::new(HashMap::new())),
            path_watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

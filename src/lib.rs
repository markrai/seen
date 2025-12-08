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
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64};
use std::collections::HashMap;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

/// Type alias for the SQLite connection pool
pub type DbPool = Pool<SqliteConnectionManager>;

/// Cache for expensive database counts with TTL
pub struct StatsCache {
    pub asset_count: AtomicI64,
    pub photo_count: AtomicI64,
    pub video_count: AtomicI64,
    /// Unix timestamp in seconds when cache was last updated
    pub last_updated: AtomicU64,
    /// Track if processing was active in the last stats check (for detecting completion)
    pub was_processing_active: AtomicBool,
}

impl StatsCache {
    pub fn new() -> Self {
        Self {
            asset_count: AtomicI64::new(0),
            photo_count: AtomicI64::new(0),
            video_count: AtomicI64::new(0),
            last_updated: AtomicU64::new(0),
            was_processing_active: AtomicBool::new(false),
        }
    }

    /// Check if cache is stale (older than ttl_secs)
    pub fn is_stale(&self, ttl_secs: u64) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let last = self.last_updated.load(std::sync::atomic::Ordering::Relaxed);
        now.saturating_sub(last) > ttl_secs
    }

    /// Update all cached counts
    pub fn update(&self, assets: i64, photos: i64, videos: i64) {
        use std::sync::atomic::Ordering::Relaxed;
        self.asset_count.store(assets, Relaxed);
        self.photo_count.store(photos, Relaxed);
        self.video_count.store(videos, Relaxed);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.last_updated.store(now, Relaxed);
    }

    /// Get cached counts
    pub fn get(&self) -> (i64, i64, i64) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            self.asset_count.load(Relaxed),
            self.photo_count.load(Relaxed),
            self.video_count.load(Relaxed),
        )
    }
}

impl Default for StatsCache {
    fn default() -> Self {
        Self::new()
    }
}

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
    /// Connection pool for SQLite - use pool.get() to obtain a connection
    pub pool: DbPool,
    /// Cache for expensive database counts (TTL-based)
    pub stats_cache: Arc<StatsCache>,
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
    pub fn new(paths: AppPaths, pool: DbPool, queues: pipeline::Queues, gauges: Arc<pipeline::QueueGauges>, stats: Arc<stats::Stats>, face_processor: Arc<parking_lot::Mutex<pipeline::face::FaceProcessor>>, face_index: Arc<parking_lot::Mutex<pipeline::face::FaceIndex>>) -> Self {
        let (tx, _) = broadcast::channel(8);
        Self {
            started_at: std::time::Instant::now(),
            db_path: paths.db_path.clone(),
            paths,
            stats,
            scanner_ctl: tx,
            queues,
            gauges,
            pool,
            stats_cache: Arc::new(StatsCache::new()),
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
    pub fn new(paths: AppPaths, pool: DbPool, queues: pipeline::Queues, gauges: Arc<pipeline::QueueGauges>, stats: Arc<stats::Stats>) -> Self {
        let (tx, _) = broadcast::channel(8);
        Self {
            started_at: std::time::Instant::now(),
            db_path: paths.db_path.clone(),
            paths,
            stats,
            scanner_ctl: tx,
            queues,
            gauges,
            pool,
            stats_cache: Arc::new(StatsCache::new()),
            scan_running: Arc::new(AtomicBool::new(false)),
            path_scan_running: Arc::new(Mutex::new(HashMap::new())),
            path_watcher_paused: Arc::new(Mutex::new(HashMap::new())),
            path_watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

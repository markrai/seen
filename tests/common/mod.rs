use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use rusqlite::Connection;
use nazr_backend_sqlite::db;
use nazr_backend_sqlite::{AppPaths, AppState, pipeline};
use tokio::sync::mpsc;

/// Create a temporary SQLite database for testing
pub fn setup_test_db() -> (TempDir, PathBuf, Connection) {
    let tmp = TempDir::new().unwrap();
    let db_dir = tmp.path().join("db");
    std::fs::create_dir_all(&db_dir).unwrap();
    let db_path = db_dir.join("nazr.db");
    let conn = db::open_or_create(&db_path).unwrap();
    (tmp, db_path, conn)
}

/// Create a temporary filesystem structure for testing
pub fn setup_test_fs() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("photos");
    std::fs::create_dir_all(&root).unwrap();
    (tmp, root)
}

/// Create a minimal JPEG image (1x1 pixel)
pub fn create_test_image(path: &PathBuf) -> std::io::Result<()> {
    // Minimal valid JPEG (1x1 pixel)
    use base64::{Engine as _, engine::general_purpose};
    let img_bytes = general_purpose::STANDARD.decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCABkAGQDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB3AAAAAP/Z").unwrap();
    std::fs::write(path, &img_bytes)
}

/// Create a test PNG image
pub fn create_test_png(path: &PathBuf) -> std::io::Result<()> {
    // Minimal valid PNG (1x1 pixel, red)
    let png_bytes = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // bit depth, color type, etc.
        0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
        0x08, 0x99, 0x01, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x02, // pixel data
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
    ];
    std::fs::write(path, &png_bytes)
}

/// Create a test text file (for testing non-image files)
pub fn create_test_text_file(path: &PathBuf, content: &str) -> std::io::Result<()> {
    std::fs::write(path, content)
}

/// Create AppState for testing
pub fn create_test_app_state(
    root: PathBuf,
    data: PathBuf,
    db_path: PathBuf,
    conn: Connection,
) -> Arc<AppState> {
    let db_dir = data.join("db");
    let derived_dir = data.join("derived");
    std::fs::create_dir_all(&db_dir).unwrap();
    std::fs::create_dir_all(&derived_dir).unwrap();

    let (discover_tx, _discover_rx) = mpsc::channel::<pipeline::discover::DiscoverItem>(100);
    let (hash_tx, _hash_rx) = mpsc::channel::<pipeline::hash::HashJob>(100);
    let (meta_tx, _meta_rx) = mpsc::channel::<pipeline::metadata::MetaJob>(100);
    let (db_tx, _db_rx) = mpsc::channel::<db::writer::DbWriteItem>(100);
    let (thumb_tx, _thumb_rx) = mpsc::channel::<pipeline::thumb::ThumbJob>(100);
    #[cfg(feature = "facial-recognition")]
    let (face_tx, _face_rx) = mpsc::channel::<pipeline::face::FaceJob>(100);

    let gauges = Arc::new(pipeline::QueueGauges::default());
    let paths = AppPaths {
        root,
        root_host: None,
        data,
        db_path: db_path.clone(),
        derived: derived_dir,
    };
    #[cfg(feature = "facial-recognition")]
    let queues = pipeline::Queues {
        discover_tx,
        hash_tx,
        meta_tx,
        db_tx,
        thumb_tx,
        face_tx,
    };
    #[cfg(not(feature = "facial-recognition"))]
    let queues = pipeline::Queues {
        discover_tx,
        hash_tx,
        meta_tx,
        db_tx,
        thumb_tx,
    };

    let stats = Arc::new(nazr_backend_sqlite::stats::Stats::new());
    #[cfg(feature = "facial-recognition")]
    {
        let models_dir = paths.data.join("models");
        let face_processor = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceProcessor::new(models_dir)));
        let face_index = Arc::new(parking_lot::Mutex::new(pipeline::face::FaceIndex::new()));
        Arc::new(AppState::new(paths, conn, queues, gauges, stats, face_processor, face_index))
    }
    #[cfg(not(feature = "facial-recognition"))]
    {
        Arc::new(AppState::new(paths, conn, queues, gauges, stats))
    }
}

/// Wait for a condition to become true
pub async fn wait_for_condition<F>(mut condition: F, max_attempts: usize, delay_ms: u64)
where
    F: FnMut() -> bool,
{
    use tokio::time::{sleep, Duration};
    for _ in 0..max_attempts {
        if condition() {
            return;
        }
        sleep(Duration::from_millis(delay_ms)).await;
    }
}

/// Helper to make HTTP requests to test server
pub struct TestClient {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl TestClient {
    pub fn new(port: u16) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{}", port),
            client: reqwest::Client::new(),
        }
    }

    pub async fn get(&self, path: &str) -> reqwest::Result<reqwest::Response> {
        self.client.get(&format!("{}{}", self.base_url, path)).send().await
    }

    pub async fn post(&self, path: &str, json: &serde_json::Value) -> reqwest::Result<reqwest::Response> {
        self.client
            .post(&format!("{}{}", self.base_url, path))
            .json(json)
            .send()
            .await
    }

    pub async fn delete(&self, path: &str) -> reqwest::Result<reqwest::Response> {
        self.client.delete(&format!("{}{}", self.base_url, path)).send().await
    }

    pub async fn put(&self, path: &str, json: &serde_json::Value) -> reqwest::Result<reqwest::Response> {
        self.client
            .put(&format!("{}{}", self.base_url, path))
            .json(json)
            .send()
            .await
    }
}


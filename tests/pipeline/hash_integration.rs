// Integration tests for hash pipeline
// Note: Unit tests for hash_file are in src/pipeline/hash.rs

use nazr_backend_sqlite::pipeline::hash::{HashJob, start_workers};
use nazr_backend_sqlite::pipeline::metadata::MetaJob;
use nazr_backend_sqlite::pipeline::QueueGauges;
use tempfile::TempDir;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

#[tokio::test]
async fn test_hash_worker_pipeline() {
    let tmp = TempDir::new().unwrap();
    let test_file = tmp.path().join("test.txt");
    std::fs::write(&test_file, b"test content").unwrap();
    
    let (hash_tx, hash_rx) = mpsc::channel::<HashJob>(10);
    let (meta_tx, mut meta_rx) = mpsc::channel::<MetaJob>(10);
    let gauges = Arc::new(QueueGauges::default());
    
    start_workers(1, hash_rx, meta_tx, gauges.clone());
    
    // Send a hash job
    let job = HashJob {
        path: test_file.clone(),
        size_bytes: 12,
        mtime_ns: 1000000,
        ctime_ns: 1000000,
        dirname: tmp.path().to_string_lossy().to_string(),
        filename: "test.txt".to_string(),
        ext: "txt".to_string(),
        mime: "text/plain".to_string(),
    };
    
    gauges.hash.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    hash_tx.send(job).await.unwrap();
    
    // Wait for result
    let result = tokio::time::timeout(Duration::from_secs(5), meta_rx.recv()).await;
    assert!(result.is_ok());
    
    if let Some(meta_job) = result.unwrap() {
        assert!(meta_job.xxh64.is_some());
        assert!(meta_job.xxh64.unwrap() != 0);
        assert!(meta_job.sha256.is_some());
    } else {
        panic!("No result received from hash worker");
    }
}


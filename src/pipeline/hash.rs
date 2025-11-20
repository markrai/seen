use anyhow::Result;
use sha2::{Sha256, Digest};
use std::fs::File;
use std::io::{Read, BufReader};
use tokio::sync::mpsc::{Receiver, Sender};
use xxhash_rust::xxh3::Xxh3;
use std::path::PathBuf;
use crate::pipeline::metadata::MetaJob;
use crate::pipeline::QueueGauges;
use std::sync::Arc;
use memmap2::MmapOptions;

#[derive(Clone, Debug)]
pub struct HashJob {
    pub path: PathBuf,
    pub size_bytes: i64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub dirname: String,
    pub filename: String,
    pub ext: String,
    pub mime: String,
}

#[derive(Clone, Debug)]
pub struct HashResult {
    pub job: HashJob,
    pub xxh64: i64,
    pub sha256: Option<Vec<u8>>,
}

fn hash_file(path: &PathBuf, size_bytes: i64, mime: &str) -> Result<(i64, Option<Vec<u8>>)> {
    // Always calculate SHA256 for video files (needed for thumbnails)
    // For other files, only calculate SHA256 if under 64MB (to save time on very large files)
    let is_video = mime.starts_with("video/");
    let calculate_sha256 = is_video || size_bytes < 64 * 1024 * 1024;
    
    // Use memory-mapped files for large files (faster than reading)
    // Threshold: 8MB - memory mapping is faster for larger files
    const MMAP_THRESHOLD: i64 = 8 * 1024 * 1024;
    
    if size_bytes >= MMAP_THRESHOLD {
        // Memory-mapped approach for large files (faster than buffered reads)
        // Safety: We've already checked the file exists and size_bytes matches actual file size
        let file = File::open(path)?;
        let mmap = unsafe { 
            // Safe: File is opened successfully, size_bytes was obtained from metadata
            MmapOptions::new().map(&file)? 
        };
        
        let mut xx = Xxh3::new();
        let mut sh = if calculate_sha256 { Some(Sha256::new()) } else { None };
        
        // Process in chunks for better cache behavior
        const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB chunks
        let mut offset = 0;
        while offset < mmap.len() {
            let end = (offset + CHUNK_SIZE).min(mmap.len());
            let chunk = &mmap[offset..end];
            xx.update(chunk);
            if let Some(ref mut sha) = sh {
                sha.update(chunk);
            }
            offset = end;
        }
        
        let x = xx.digest() as u64 as i64;
        let sha = sh.map(|s| s.finalize().to_vec());
        Ok((x, sha))
    } else {
        // Buffered read approach for smaller files (better for small files)
        let f = File::open(path)?;
        // Larger buffer for better I/O performance
        let mut reader = BufReader::with_capacity(4 * 1024 * 1024, f); // 4MB buffer
        let mut xx = Xxh3::new();
        let mut sh = if calculate_sha256 { Some(Sha256::new()) } else { None };
        let mut buf = vec![0u8; 4 * 1024 * 1024]; // 4MB buffer
        
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 { break; }
            xx.update(&buf[..n]);
            if let Some(ref mut sha) = sh {
                sha.update(&buf[..n]);
            }
        }
        
        let x = xx.digest() as u64 as i64;
        let sha = sh.map(|s| s.finalize().to_vec());
        Ok((x, sha))
    }
}

pub fn start_workers(n: usize, mut rx: Receiver<HashJob>, tx: Sender<MetaJob>, gauges: Arc<QueueGauges>) {
    // Distribute jobs to workers using a work-stealing pattern
    // Each worker gets its own channel, distributor round-robins jobs
    let mut worker_txs = Vec::new();
    let mut worker_rxs = Vec::new();
    for _ in 0..n {
        let (wt, wr) = tokio::sync::mpsc::channel::<HashJob>(1000);
        worker_txs.push(wt);
        worker_rxs.push(wr);
    }
    
    // Distributor task: round-robin jobs to workers
    let distributor = tokio::spawn(async move {
        let mut idx = 0;
        while let Some(job) = rx.recv().await {
            let target_idx = idx % worker_txs.len();
            if worker_txs[target_idx].send(job).await.is_err() {
                break; // Worker channel closed
            }
            idx += 1;
        }
        // Close all worker channels
        for wt in worker_txs {
            drop(wt);
        }
    });
    
    // Spawn worker tasks
    for mut worker_rx in worker_rxs.into_iter() {
        let txc = tx.clone();
        let gaugesc = gauges.clone();
        tokio::spawn(async move {
            while let Some(job) = worker_rx.recv().await {
                gaugesc.hash.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                let mut xxh64 = 0i64;
                let mut sha256 = None;
                // Move blocking I/O to spawn_blocking
                let path = job.path.clone();
                let size_bytes = job.size_bytes;
                let mime = job.mime.clone();
                match tokio::task::spawn_blocking(move || hash_file(&path, size_bytes, &mime)).await {
                    Ok(Ok((x, s))) => { 
                        xxh64 = x; 
                        sha256 = s; 
                    }
                    Ok(Err(e)) => { 
                        tracing::debug!("hash error for {:?}: {:?}", job.path, e); 
                    }
                    Err(e) => {
                        tracing::debug!("hash task error for {:?}: {:?}", job.path, e);
                    }
                }
                let out = MetaJob { job, xxh64: Some(xxh64), sha256 };
                let _ = txc.send(out).await;
                gaugesc.metadata.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
    
    // Keep distributor alive (it will exit when rx closes)
    tokio::spawn(async move {
        let _ = distributor.await;
    });
}

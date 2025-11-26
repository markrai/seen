use serde_json::Value;
use tokio::sync::mpsc::{Receiver, Sender};
use crate::db::writer::DbWriteItem;
use crate::pipeline::hash::HashJob;
use crate::pipeline::QueueGauges;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct MetaJob {
    pub job: HashJob,
    pub xxh64: Option<i64>,
    pub sha256: Option<Vec<u8>>,
}

fn parse_duration_ms(v: &Value) -> Option<i64> {
    if let Some(s) = v.as_str() {
        if let Ok(f) = s.parse::<f64>() { return Some((f * 1000.0) as i64); }
    }
    if let Some(n) = v.as_f64() { return Some((n * 1000.0) as i64); }
    None
}

async fn probe_video(path: &str) -> (Option<i64>, Option<i64>, Option<i64>, Option<String>) {
    let args = ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path];
    let (code, stdout, _) = crate::utils::exec::exec_capture("ffprobe", &args).await.unwrap_or((1, Vec::new(), Vec::new()));
    if code != 0 { return (None, None, None, None); }
    if let Ok(v) = serde_json::from_slice::<Value>(&stdout) {
        let mut w = None;
        let mut h = None;
        let mut codec = None;
        if let Some(streams) = v.get("streams").and_then(|x| x.as_array()) {
            for s in streams {
                if let Some(c) = s.get("codec_type").and_then(|x| x.as_str()) {
                    if c == "video" {
                        w = s.get("width").and_then(|x| x.as_i64());
                        h = s.get("height").and_then(|x| x.as_i64());
                        codec = s.get("codec_name").and_then(|x| x.as_str()).map(|s| s.to_string());
                        break;
                    }
                }
            }
        }
        let dur = v.get("format").and_then(|f| f.get("duration")).and_then(parse_duration_ms);
        return (w, h, dur, codec);
    }
    (None, None, None, None)
}

pub fn start_workers(n: usize, mut rx: Receiver<MetaJob>, tx: Sender<DbWriteItem>, gauges: Arc<QueueGauges>) {
    // Distribute jobs to workers using round-robin
    let mut worker_txs = Vec::new();
    let mut worker_rxs = Vec::new();
    for _ in 0..n {
        let (wt, wr) = tokio::sync::mpsc::channel::<MetaJob>(1000);
        worker_txs.push(wt);
        worker_rxs.push(wr);
    }
    
    // Distributor task
    let distributor = tokio::spawn(async move {
        let mut idx = 0;
        while let Some(job) = rx.recv().await {
            let target_idx = idx % worker_txs.len();
            if worker_txs[target_idx].send(job).await.is_err() {
                break;
            }
            idx += 1;
        }
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
                gaugesc.metadata.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                let mut width = None;
                let mut height = None;
                let mut duration_ms = None;
                let mut video_codec = None;

                if job.job.mime.starts_with("image/") {
                    // Move blocking libvips calls to a blocking thread to avoid stalling the async runtime.
                    #[cfg(not(target_env = "msvc"))]
                    {
                        let path = job.job.path.clone();
                        if let Ok(Ok((w, h))) = tokio::task::spawn_blocking(move || {
                            libvips::VipsImage::new_from_file(path.to_string_lossy().as_ref())
                                .map(|img| (img.get_width() as i64, img.get_height() as i64))
                        })
                        .await
                        {
                            width = Some(w);
                            height = Some(h);
                        }
                    }
                    #[cfg(target_env = "msvc")]
                    {
                        // libvips not available on Windows MSVC - skip image dimension extraction
                    }
                } else if job.job.mime.starts_with("video/") {
                    let (w, h, d, codec) = probe_video(&job.job.path.to_string_lossy()).await;
                    width = w;
                    height = h;
                    duration_ms = d;
                    video_codec = codec;
                }

                let item = DbWriteItem {
                    path: job.job.path.to_string_lossy().to_string(),
                    dirname: job.job.dirname,
                    filename: job.job.filename,
                    ext: job.job.ext,
                    size_bytes: job.job.size_bytes,
                    mtime_ns: job.job.mtime_ns,
                    ctime_ns: job.job.ctime_ns,
                    sha256: job.sha256,
                    xxh64: job.xxh64,
                    taken_at: Some(job.job.mtime_ns / 1_000_000_000),
                    width,
                    height,
                    duration_ms,
                    camera_make: None,
                    camera_model: None,
                    lens_model: None,
                    iso: None,
                    fnumber: None,
                    exposure: None,
                    video_codec,
                    mime: job.job.mime,
                    flags: 0,
                };
                let _ = txc.send(item).await;
                gaugesc.db_write.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
    
    // Keep distributor alive
    tokio::spawn(async move {
        let _ = distributor.await;
    });
}

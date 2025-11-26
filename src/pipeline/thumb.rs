use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::Receiver;
use crate::pipeline::QueueGauges;
use crate::utils::ffmpeg;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, warn};

#[derive(Clone, Debug)]
pub struct ThumbJob {
    pub id: i64,
    pub path: String,
    pub sha256_hex: String,
    pub mime: String,
}

fn ensure_dir(p: &Path) -> std::io::Result<()> { std::fs::create_dir_all(p) }

fn thumb_path(derived: &Path, sha_hex: &str, size: i32) -> PathBuf {
    let sub = &sha_hex[0..2];
    derived.join(sub).join(format!("{}-{}.webp", sha_hex, size))
}

#[cfg(not(target_env = "msvc"))]
fn image_make_thumb(src: &str, dst: &Path, size: i32) -> Result<()> {
    let img = libvips::VipsImage::new_from_file(src)
        .map_err(|e| anyhow::anyhow!("Failed to load image {}: {}", src, e))?;
    let out = libvips::ops::thumbnail_image(&img, size)
        .map_err(|e| anyhow::anyhow!("Failed to create thumbnail for {}: {}", src, e))?;
    let write_result = out.image_write_to_file(dst.to_string_lossy().as_ref())
        .map_err(|e| anyhow::anyhow!("Failed to write thumbnail file for {}: {}", src, e));
    
    // Clean up partial file on failure
    if let Err(e) = write_result {
        if dst.exists() {
            if let Err(rm_err) = std::fs::remove_file(dst) {
                warn!("Failed to clean up partial thumbnail file {:?} after write error: {}", dst, rm_err);
            }
        }
        return Err(e);
    }
    
    Ok(())
}

#[cfg(target_env = "msvc")]
fn image_make_thumb(src: &str, dst: &Path, size: i32) -> Result<()> {
    use image::DynamicImage;
    
    // Load image using image crate
    let img = image::open(src)
        .map_err(|e| anyhow::anyhow!("Failed to decode image {}: {}", src, e))?;
    
    // Resize maintaining aspect ratio
    let resized = img.thumbnail(size as u32, size as u32);
    
    // Convert to RGB8 if needed
    let rgb8 = match resized {
        DynamicImage::ImageRgb8(img) => img,
        img => img.to_rgb8(),
    };
    
    // Encode as WebP
    let encoder = webp::Encoder::from_rgb(&rgb8, rgb8.width(), rgb8.height());
    let webp_data = encoder.encode(85.0); // Quality 85 (0-100)
    
    // Write to file - WebPMemory implements AsRef<[u8]>
    let write_result = std::fs::write(dst, webp_data.as_ref())
        .map_err(|e| anyhow::anyhow!("Failed to write WebP file for {}: {}", src, e));
    
    // Clean up partial file on failure
    if let Err(e) = write_result {
        if dst.exists() {
            if let Err(rm_err) = std::fs::remove_file(dst) {
                warn!("Failed to clean up partial thumbnail file {:?} after write error: {}", dst, rm_err);
            }
        }
        return Err(e);
    }
    
    Ok(())
}

fn video_make_thumb(src: &str, dst: &Path, size: i32) -> Result<()> {
    // Extract a frame from video at 1 second (or start if video is shorter)
    // Try GPU-accelerated path first, fallback to CPU
    let config = ffmpeg::get_gpu_config();
    
    // Use shorter timeout for GPU attempts (2.5 seconds) to fail fast
    let gpu_timeout = Duration::from_millis(2500);
    // CPU fallback gets longer timeout (15 seconds) for reliability with large/slow videos
    let cpu_timeout = Duration::from_secs(15);
    
    let mut frame_data: Option<Vec<u8>> = None;

    // Try GPU path if enabled
    if config.enabled {
        let args = ffmpeg::build_ffmpeg_args(src, dst, size, &config.accel);
        let gpu_start = std::time::Instant::now();
        let result = ffmpeg::run_ffmpeg_with_timeout(args.clone(), gpu_timeout);
        
        match result {
            Ok(output) if output.status.success() => {
                ffmpeg::increment_gpu_job();
                debug!("Video frame extracted using {:?} in {:?}", config.accel, gpu_start.elapsed());
                frame_data = Some(output.stdout);
            }
            Ok(output) => {
                // GPU path failed (non-zero exit), record failure and fallback
                let stderr = String::from_utf8_lossy(&output.stderr);
                let error_lines: Vec<&str> = stderr
                    .lines()
                    .filter(|l| {
                        l.contains("error")
                            || l.contains("Error")
                            || l.contains("ERROR")
                            || l.contains("Failed")
                            || l.contains("failed")
                            || l.contains("Cannot")
                            || l.contains("Impossible")
                            || l.contains("libnvcuvid")
                    })
                    .take(5)
                    .collect();
                let error_preview = if !error_lines.is_empty() {
                    error_lines.join("; ")
                } else {
                    let stderr_preview = stderr.lines().take(3).collect::<Vec<_>>().join("; ");
                    if stderr_preview.is_empty() {
                        format!("No error output (exit code: {})", output.status.code().unwrap_or(-1))
                    } else {
                        stderr_preview
                    }
                };
                warn!(
                    "GPU path failed (exit code: {}) for {}: {}, falling back to CPU",
                    output.status.code().unwrap_or(-1),
                    src,
                    error_preview
                );
                ffmpeg::record_gpu_failure();
            }
            Err(e) => {
                // GPU path error or timeout, record failure and fallback
                let elapsed = gpu_start.elapsed();
                debug!("GPU path error after {:?} for {}: {}, falling back to CPU", elapsed, src, e);
                ffmpeg::record_gpu_failure();
            }
        }
    }
    
    // Fallback to CPU-only command if GPU failed or was not enabled
    if frame_data.is_none() {
        debug!("Attempting CPU fallback for video thumbnail extraction: {}", src);
        let cpu_args = ffmpeg::build_ffmpeg_args(src, dst, size, &ffmpeg::GpuAccel::Cpu);
        let cpu_result = ffmpeg::run_ffmpeg_with_timeout(cpu_args.clone(), cpu_timeout);
        
        match cpu_result {
            Ok(output) if output.status.success() => {
                ffmpeg::increment_cpu_job();
                frame_data = Some(output.stdout);
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let error_lines: Vec<&str> = stderr
                    .lines()
                    .filter(|l| {
                        l.contains("error")
                            || l.contains("Error")
                            || l.contains("ERROR")
                            || l.contains("Failed")
                            || l.contains("failed")
                            || l.contains("Cannot")
                            || l.contains("Impossible")
                            || l.contains("Invalid")
                            || l.contains("No such")
                    })
                    .take(5)
                    .collect();
                let error_preview = if !error_lines.is_empty() {
                    error_lines.join("; ")
                } else {
                    let stderr_preview = stderr.lines().take(3).collect::<Vec<_>>().join("; ");
                    if stderr_preview.is_empty() {
                        format!("No error output (exit code: {})", output.status.code().unwrap_or(-1))
                    } else {
                        stderr_preview
                    }
                };
                warn!(
                    "CPU path failed (exit code: {}) for {}, trying from start. Error: {}",
                    output.status.code().unwrap_or(-1),
                    src,
                    error_preview
                );
                // Try at the start of the video if seeking failed
                let mut new_args = Vec::new();
                let mut skip_next = false;
                for arg in cpu_args.iter() {
                    if skip_next {
                        skip_next = false;
                        continue;
                    }
                    if arg == "-ss" {
                        skip_next = true;
                        continue;
                    }
                    new_args.push(arg.clone());
                }
                let output2_result = ffmpeg::run_ffmpeg_with_timeout(new_args.clone(), cpu_timeout);
                let output2 = match output2_result {
                    Ok(o) if o.status.success() => {
                        ffmpeg::increment_cpu_job();
                        let stdout = o.stdout;
                        let stderr = o.stderr;
                        let status = o.status;
                        frame_data = Some(stdout);
                        std::process::Output { status, stdout: Vec::new(), stderr }
                    }
                    Ok(o) => o,
                    Err(_e) => {
                        let minimal_args = vec![
                            "-i".to_string(),
                            src.to_string(),
                            "-vframes".to_string(),
                            "1".to_string(),
                            "-vf".to_string(),
                            format!("scale={}:-1", size),
                            "-f".to_string(),
                            "image2pipe".to_string(), // Output to pipe
                            "-vcodec".to_string(),
                            "mjpeg".to_string(), // Output as MJPEG
                            "pipe:1".to_string(), // Output to stdout
                        ];
                        match ffmpeg::run_ffmpeg_with_timeout(minimal_args, cpu_timeout) {
                            Ok(o) if o.status.success() => {
                                ffmpeg::increment_cpu_job();
                                let stdout = o.stdout;
                                let stderr = o.stderr;
                                let status = o.status;
                                frame_data = Some(stdout);
                                std::process::Output { status, stdout: Vec::new(), stderr }
                            }
                            Ok(o) => o,
                            Err(e2) => {
                                warn!("ffmpeg failed with minimal args for {}: {}", src, e2);
                                return Err(anyhow::anyhow!("ffmpeg failed: {}", e2));
                            }
                        }
                    }
                };
                if frame_data.is_none() {
                    let stderr = String::from_utf8_lossy(&output2.stderr);
                    let error_lines: Vec<&str> = stderr
                        .lines()
                        .filter(|l| {
                            l.contains("error")
                                || l.contains("Error")
                                || l.contains("ERROR")
                                || l.contains("Failed")
                                || l.contains("failed")
                                || l.contains("Cannot")
                                || l.contains("Impossible")
                                || l.contains("Invalid")
                                || l.contains("No such")
                                || l.contains("not found")
                                || l.contains("codec")
                        })
                        .take(10)
                        .collect();
                    let error_msg = if !error_lines.is_empty() {
                        error_lines.join("; ")
                    } else {
                        let stderr_preview = stderr.lines().take(5).collect::<Vec<_>>().join("; ");
                        if stderr_preview.is_empty() {
                            format!("No error output available (exit code: {})", output2.status.code().unwrap_or(-1))
                        } else {
                            stderr_preview
                        }
                    };
                    warn!(
                        "ffmpeg failed to extract video frame from {} (exit code: {}). Error: {}",
                        src,
                        output2.status.code().unwrap_or(-1),
                        error_msg
                    );
                    anyhow::bail!("ffmpeg failed to extract video frame from {}: {}", src, error_msg);
                }
            }
            Err(e) => {
                warn!("ffmpeg error for {}: {}", src, e);
                anyhow::bail!("ffmpeg failed for {}: {}", src, e);
            }
        }
    }

    if let Some(data) = frame_data {
        if data.is_empty() {
            warn!("ffmpeg extracted empty frame for {} (all extraction paths exhausted)", src);
            debug!("Frame extraction summary for {}: GPU attempted={}, CPU attempted={}, minimal attempted={}", 
                   src, config.enabled, true, true);
            anyhow::bail!("ffmpeg extracted empty frame for {}: all extraction paths (GPU, CPU, minimal) failed", src);
        }
        
        // Write file with cleanup on failure
        let write_result = {
            #[cfg(not(target_env = "msvc"))]
            {
                let img = libvips::VipsImage::new_from_buffer(&data, "")
                    .map_err(|e| anyhow::anyhow!("Failed to decode frame buffer for {}: {}", src, e))?;
                img.image_write_to_file(dst.to_string_lossy().as_ref())
                    .map_err(|e| anyhow::anyhow!("Failed to write thumbnail file for {}: {}", src, e))
            }
            #[cfg(target_env = "msvc")]
            {
                // Use image crate to convert ffmpeg output to WebP
                use image::DynamicImage;
                
                // Decode the JPEG/MJPEG frame from ffmpeg using image crate
                let img = image::load_from_memory(&data)
                    .map_err(|e| anyhow::anyhow!("Failed to decode frame for {}: {}", src, e))?;
                
                // Resize maintaining aspect ratio
                let resized = img.thumbnail(size as u32, size as u32);
                
                // Convert to RGB8 if needed
                let rgb8 = match resized {
                    DynamicImage::ImageRgb8(img) => img,
                    img => img.to_rgb8(),
                };
                
                // Encode as WebP
                let encoder = webp::Encoder::from_rgb(&rgb8, rgb8.width(), rgb8.height());
                let webp_data = encoder.encode(85.0);
                
                // Write to file - WebPMemory implements AsRef<[u8]>
                std::fs::write(dst, webp_data.as_ref())
                    .map_err(|e| anyhow::anyhow!("Failed to write WebP file for {}: {}", src, e))
            }
        };
        
        // Clean up partial file on failure
        if let Err(e) = write_result {
            // Attempt to remove partial file if it exists
            if dst.exists() {
                if let Err(rm_err) = std::fs::remove_file(dst) {
                    warn!("Failed to clean up partial thumbnail file {:?} after write error: {}", dst, rm_err);
                }
            }
            return Err(e);
        }
        
        Ok(())
    } else {
        warn!("All video frame extraction paths failed for {}", src);
        anyhow::bail!("Failed to extract video frame for {}: all extraction paths (GPU, CPU, minimal) exhausted", src);
    }
}

pub fn start_workers(n: usize, mut rx: Receiver<ThumbJob>, derived: PathBuf, thumb_size: i32, preview_size: i32, gauges: Arc<QueueGauges>) {
    // Distribute jobs to workers using round-robin
    let mut worker_txs = Vec::new();
    let mut worker_rxs = Vec::new();
    for _ in 0..n {
        let (wt, wr) = tokio::sync::mpsc::channel::<ThumbJob>(1000);
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
        let derivedc = derived.clone();
        let gaugesc = gauges.clone();
        tokio::spawn(async move {
            while let Some(job) = worker_rx.recv().await {
                gaugesc.thumb.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                if job.sha256_hex.len() < 2 {
                    continue;
                }
                let is_image = job.mime.starts_with("image/");
                let is_video = job.mime.starts_with("video/");
                if !is_image && !is_video {
                    continue;
                }

                let src = job.path.clone();
                let sha_hex = job.sha256_hex.clone();

                let p1 = thumb_path(&derivedc, &sha_hex, thumb_size);
                let p2 = thumb_path(&derivedc, &sha_hex, preview_size);
                let _ = ensure_dir(p1.parent().unwrap());
                let p1_exists = p1.exists();
                let p2_exists = p2.exists();
                if !p1_exists || !p2_exists {
                    let src_clone = src.clone();
                    let p1_clone = p1.clone();
                    let p2_clone = p2.clone();
                    if is_image {
                        let _ = tokio::task::spawn_blocking(move || {
                            if !p1_exists {
                                match image_make_thumb(&src_clone, &p1_clone, thumb_size) {
                                    Ok(()) => {
                                        debug!("Successfully created thumbnail for {}: {:?}", src_clone, p1_clone);
                                    }
                                    Err(e) => {
                                        warn!("Failed to create thumbnail for {}: {}", src_clone, e);
                                    }
                                }
                            }
                            if !p2_exists {
                                match image_make_thumb(&src_clone, &p2_clone, preview_size) {
                                    Ok(()) => {
                                        debug!("Successfully created preview for {}: {:?}", src_clone, p2_clone);
                                    }
                                    Err(e) => {
                                        warn!("Failed to create preview for {}: {}", src_clone, e);
                                    }
                                }
                            }
                        })
                        .await;
                    } else if is_video {
                        // For videos, extract frame using ffmpeg, then convert to WebP using libvips
                        let src_clone_for_thumb = src_clone.clone();
                        let src_clone_for_preview = src_clone.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            if !p1_exists {
                                match video_make_thumb(&src_clone_for_thumb, &p1_clone, thumb_size) {
                                    Ok(()) => {
                                        debug!(
                                            "Successfully created thumbnail for {}: {:?}",
                                            src_clone_for_thumb, p1_clone
                                        );
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Failed to extract video frame for {}: {}",
                                            src_clone_for_thumb, e
                                        );
                                    }
                                }
                            }
                            if !p2_exists {
                                match video_make_thumb(&src_clone_for_preview, &p2_clone, preview_size) {
                                    Ok(()) => {
                                        debug!(
                                            "Successfully created preview for {}: {:?}",
                                            src_clone_for_preview, p2_clone
                                        );
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Failed to extract video frame for {}: {}",
                                            src_clone_for_preview, e
                                        );
                                    }
                                }
                            }
                        })
                        .await;
                    }
                }
            }
        });
    }
    
    // Keep distributor alive
    tokio::spawn(async move {
        let _ = distributor.await;
    });
}

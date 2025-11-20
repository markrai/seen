#[cfg(target_os = "linux")]
use anyhow::Result;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::ffi::{CString, OsString};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(target_os = "linux")]
use std::os::unix::io::RawFd;
#[cfg(target_os = "linux")]
use libc::{dirent64, DT_DIR, DT_REG, DT_LNK, O_RDONLY, O_DIRECTORY};
#[cfg(target_os = "linux")]
use crate::pipeline::QueueGauges;
#[cfg(target_os = "linux")]
use crate::pipeline::discover::{DiscoverItem, is_hidden, read_ignore, ignored};
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use tokio::sync::mpsc::Sender;
#[cfg(target_os = "linux")]
use tracing::{info, warn, debug, error};
#[cfg(target_os = "linux")]
use rayon::prelude::*;
#[cfg(target_os = "linux")]
use mime_guess;

#[cfg(target_os = "linux")]
struct FileInfo {
    path: PathBuf,
}

// Fast statx-based metadata retrieval for Linux
// statx() is faster than stat() and gives us more control
#[cfg(target_os = "linux")]
fn fast_stat(path: &PathBuf) -> Option<std::fs::Metadata> {
    // Fallback to regular stat if needed, but try to optimize
    std::fs::metadata(path).ok()
}

// Optimized discover item creation that reduces allocations
#[cfg(target_os = "linux")]
fn to_discover_item_fast(path: &PathBuf) -> Option<DiscoverItem> {
    let md = fast_stat(path)?;
    if !md.is_file() {
        return None;
    }
    
    let size_bytes = md.len() as i64;
    let mtime_ns = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs() as i64) * 1_000_000_000 + (d.subsec_nanos() as i64))
        .unwrap_or(0);
    let ctime_ns = md
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs() as i64) * 1_000_000_000 + (d.subsec_nanos() as i64))
        .unwrap_or(mtime_ns);
    
    // Optimize path string operations - reuse path components
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let dirname = path
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    // Fast MIME detection: pre-compute from extension before stat
    // This avoids the mime_guess overhead for known extensions
    let mime = if ext.is_empty() {
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    } else {
        // Fast path for common extensions
        match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg".to_string(),
            "png" => "image/png".to_string(),
            "gif" => "image/gif".to_string(),
            "webp" => "image/webp".to_string(),
            "mp4" => "video/mp4".to_string(),
            "mov" => "video/quicktime".to_string(),
            "avi" => "video/x-msvideo".to_string(),
            "mkv" => "video/x-matroska".to_string(),
            "webm" => "video/webm".to_string(),
            _ => mime_guess::from_path(path)
                .first_or_octet_stream()
                .essence_str()
                .to_string(),
        }
    };

    Some(DiscoverItem {
        path: path.clone(),
        size_bytes,
        mtime_ns,
        ctime_ns,
        dirname,
        filename,
        ext,
        mime,
    })
}

#[cfg(target_os = "linux")]
fn open_directory(path: &Path) -> Result<RawFd> {
    let path_cstr = CString::new(path.as_os_str().as_bytes())?;
    let fd = unsafe { libc::open(path_cstr.as_ptr(), O_RDONLY | O_DIRECTORY, 0) };
    if fd < 0 {
        // Add more context to the error log
        let errno = unsafe { *libc::__errno_location() };
        return Err(anyhow::anyhow!("Failed to open directory '{:?}': {} (errno: {})", path, std::io::Error::from_raw_os_error(errno), errno));
    }
    Ok(fd)
}

#[cfg(target_os = "linux")]
fn close_directory(fd: RawFd) {
    unsafe {
        libc::close(fd);
    }
}

// Syscall numbers for getdents64 for different architectures
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SYS_GETDENTS64: i64 = 217;
#[cfg(all(target_os = "linux", target_arch = "x86"))]
const SYS_GETDENTS64: i64 = 202; // Note: x86 uses getdents, but we use the getdents64 syscall number
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const SYS_GETDENTS64: i64 = 61;
#[cfg(all(target_os = "linux", not(any(target_arch = "x86_64", target_arch = "x86", target_arch = "aarch64"))))]
const SYS_GETDENTS64: i64 = 217; // Default to x86_64, but this may not be correct

// Aligned buffer for getdents64
#[cfg(target_os = "linux")]
#[repr(align(8))]
struct AlignedBuffer {
    buffer: [u8; 64 * 1024], // 64KB buffer
}

#[cfg(target_os = "linux")]
fn read_directory_entries(fd: RawFd, path: &Path) -> Result<Vec<(OsString, u8)>> {
    let mut buffer = AlignedBuffer { buffer: [0u8; 64 * 1024] };
    let mut entries = Vec::new();

    loop {
        let nread = unsafe {
            libc::syscall(
                SYS_GETDENTS64,
                fd as libc::c_long,
                buffer.buffer.as_mut_ptr() as *mut libc::c_void,
                buffer.buffer.len() as libc::c_long,
            ) as isize
        };

        if nread < 0 {
            let errno = unsafe { *libc::__errno_location() };
            if errno == libc::EINTR {
                continue; // Retry on interrupt
            }
            return Err(anyhow::anyhow!("getdents64 failed for directory '{:?}': {} (errno: {})", path, std::io::Error::from_raw_os_error(errno), errno));
        }

        if nread == 0 {
            break; // End of directory
        }

        let mut offset = 0;
        while offset < nread as usize {
            let dirent = unsafe { &*(buffer.buffer.as_ptr().add(offset) as *const dirent64) };
            
            if dirent.d_reclen == 0 {
                warn!("Invalid dirent entry with d_reclen=0 in directory '{:?}', stopping processing of this directory.", path);
                break;
            }
            
            let name_ptr = dirent.d_name.as_ptr();
            
            // Find the end of the null-terminated string
            let mut name_len = 0;
            while name_len < 256 && unsafe { *name_ptr.add(name_len) } != 0 {
                name_len += 1;
            }
            
            if name_len == 0 {
                offset += dirent.d_reclen as usize;
                continue;
            }

            let name_bytes = unsafe { std::slice::from_raw_parts(name_ptr as *const u8, name_len) };
            if name_bytes == b"." || name_bytes == b".." {
                offset += dirent.d_reclen as usize;
                continue;
            }

            let name = OsStringExt::from_vec(name_bytes.to_vec());
            let d_type = dirent.d_type;
            
            entries.push((name, d_type));
            
            offset += dirent.d_reclen as usize;
        }
    }

    Ok(entries)
}

#[cfg(target_os = "linux")]
fn process_directory(
    dir: &Path,
    patterns: &[String],
) -> Result<(Vec<FileInfo>, Vec<PathBuf>)> {
    if is_hidden(dir) {
        return Ok((Vec::new(), Vec::new()));
    }
    if ignored(dir, patterns) {
        return Ok((Vec::new(), Vec::new()));
    }

    let fd = match open_directory(dir) {
        Ok(fd) => fd,
        Err(e) => {
            warn!("Failed to open directory {:?}: {}", dir, e);
            return Ok((Vec::new(), Vec::new()));
        }
    };

    let entries = match read_directory_entries(fd, dir) {
        Ok(entries) => entries,
        Err(e) => {
            error!("Failed to read directory entries for '{:?}': {}", dir, e);
            close_directory(fd);
            return Ok((Vec::new(), Vec::new()));
        }
    };
    
    debug!("getdents64 read {} entries from {:?}", entries.len(), dir);
    close_directory(fd);

    let mut files = Vec::new();
    let mut subdirs = Vec::new();

    for (name, d_type) in entries {
        let full_path = dir.join(&name);

        if d_type == DT_DIR {
            subdirs.push(full_path);
        } else if d_type == DT_REG || d_type == DT_LNK {
            files.push(FileInfo {
                path: full_path,
            });
        }
    }

    Ok((files, subdirs))
}

#[cfg(target_os = "linux")]
fn enumerate_files_fast(
    root: &Path,
    patterns: &[String],
    scan_running: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Vec<FileInfo>> {
    let patterns = Arc::new(patterns.to_vec());
    let mut all_files = Vec::new();
    let mut dirs_to_process = vec![root.to_path_buf()];
    let mut check_counter = 0u64;
    const BATCH_SIZE: usize = 1000; // Process directories in batches for better parallelism

    while !dirs_to_process.is_empty() && scan_running.load(std::sync::atomic::Ordering::Relaxed) {
        check_counter += 1;
        if check_counter % 10 == 0 {
            if !scan_running.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
        }

        // Process directories in parallel batches
        let batch: Vec<PathBuf> = dirs_to_process.drain(..BATCH_SIZE.min(dirs_to_process.len())).collect();
        if batch.is_empty() {
            break;
        }

        let patterns_clone = patterns.clone();
        let results: Vec<Result<(Vec<FileInfo>, Vec<PathBuf>)>> = batch
            .par_iter()
            .map(|dir| process_directory(dir, &patterns_clone))
            .collect();

        // Collect files and subdirectories from parallel processing
        for result in results {
            match result {
                Ok((files, subdirs)) => {
                    all_files.extend(files);
                    dirs_to_process.extend(subdirs);
                }
                Err(e) => {
                    warn!("Error processing directory: {}", e);
                }
            }
        }
    }

    Ok(all_files)
}

#[cfg(target_os = "linux")]
pub async fn scan_bfs_getdents(
    root: PathBuf,
    tx: Sender<DiscoverItem>,
    gauges: Arc<QueueGauges>,
    scan_running: Arc<std::sync::atomic::AtomicBool>,
    stats: Option<Arc<crate::stats::Stats>>,
) -> Result<()> {
    let patterns = read_ignore(&root);
    info!("scanning root with Linux getdents64 enumeration: {:?}", root);

    let files = match enumerate_files_fast(&root, &patterns, scan_running.clone()) {
        Ok(files) => files,
        Err(e) => {
            error!("Failed during fast file enumeration: {}", e);
            return Err(e);
        }
    };
    info!("Phase 1 complete: discovered {} file paths using getdents64", files.len());
    // Phase 2: process file metadata and MIME detection in parallel
    let stats_opt = stats.clone();
    let scan_running_clone = scan_running.clone();
    let patterns_ref = &patterns;

    // Phase 2: process file metadata and MIME detection in parallel
    let discovered_items: Vec<DiscoverItem> = files
        .par_iter()
        .filter_map(|file_info| {
            // Respect cancellation flag as early as possible
            if !scan_running_clone.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }

            if is_hidden(&file_info.path) {
                return None;
            }
            if ignored(&file_info.path, patterns_ref) {
                return None;
            }
            // Filter by extension BEFORE doing stat call - this avoids expensive stat() on non-image/video files
            if !crate::pipeline::discover::has_image_video_extension(&file_info.path) {
                return None;
            }

            match to_discover_item_fast(&file_info.path) {
                Some(item) => {
                    if item.mime.starts_with("image/") || item.mime.starts_with("video/") {
                        // Increment discovery counter immediately when file is discovered (not when sent to channel)
                        // This gives accurate discovery rate in the frontend
                        if let Some(ref s) = stats_opt {
                            s.inc_files(1);
                        }
                        Some(item)
                    } else {
                        debug!("skipping non-image/non-video file: {:?} (mime: {})", file_info.path, item.mime);
                        None
                    }
                }
                None => {
                    debug!("skipping non-file entry: {:?}", file_info.path);
                    None
                }
            }
        })
        .collect();

    if !scan_running.load(std::sync::atomic::Ordering::Relaxed) {
        info!("scan stopped during linux processing: {:?}", root);
        return Ok(());
    }

    let item_count = discovered_items.len();
    info!("Phase 2 complete: processed {} files (stat + MIME detection)", item_count);
    info!("Phase 3: starting to send {} discovered items to processing pipeline", item_count);

    // Phase 3 optimization: Batch send items instead of one-by-one sequential sends
    // This dramatically improves throughput by reducing await overhead
    const BATCH_SIZE: usize = 1000;
    let mut sent_count = 0;
    let mut batch = Vec::with_capacity(BATCH_SIZE.min(item_count));
    
    for item in discovered_items {
        batch.push(item);
        
        // Send batch when full or if this is the last item
        if batch.len() >= BATCH_SIZE {
            // Try to send all items in batch without blocking
            let mut failed = false;
            let mut remaining_items = Vec::new();
            let mut batch_iter = batch.drain(..);
            
            for item in batch_iter.by_ref() {
                match tx.try_send(item) {
                    Ok(()) => {
                        sent_count += 1;
                        gauges.discover.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Full(item)) => {
                        // Channel full, collect remaining items and send with await
                        remaining_items.push(item);
                        remaining_items.extend(batch_iter);
                        
                        // Send remaining items one-by-one with await (handles backpressure)
                        for item in remaining_items {
                            if tx.send(item).await.is_err() {
                                warn!("Failed to send discovered item to channel, receiver dropped.");
                                failed = true;
                                break;
                            }
                            sent_count += 1;
                            gauges.discover.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        break;
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                        warn!("Channel closed, receiver dropped.");
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                break;
            }
        }
    }
    
    // Send remaining items in final batch
    if !batch.is_empty() {
        for item in batch {
            if tx.send(item).await.is_err() {
                warn!("Failed to send discovered item to channel, receiver dropped.");
                break;
            }
            sent_count += 1;
            gauges.discover.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    info!("Phase 3 complete: sent {} files to processing pipeline. Processing (hashing, metadata extraction) will now begin.", sent_count);
    info!("Linux getdents64 scan complete: discovery finished, processing pipeline active");
    Ok(())
}


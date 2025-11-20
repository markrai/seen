use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, EventKind};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::{Sender, Receiver};
#[cfg(not(target_os = "linux"))]
use jwalk::WalkDir;
use std::fs;
use crate::pipeline::hash::HashJob;
use crate::pipeline::metadata::MetaJob;
use crate::pipeline::QueueGauges;
use std::sync::Arc;
use tracing::debug;

#[derive(Clone, Debug)]
pub struct DiscoverItem {
    pub path: PathBuf,
    pub size_bytes: i64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub dirname: String,
    pub filename: String,
    pub ext: String,
    pub mime: String,
}

pub(crate) fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

pub(crate) fn read_ignore(root: &Path) -> Vec<String> {
    let ig = root.join(".flashignore");
    if let Ok(txt) = fs::read_to_string(ig) { txt.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() } else { Vec::new() }
}

pub(crate) fn ignored(path: &Path, patterns: &[String]) -> bool {
    let sp = path.to_string_lossy();
    patterns.iter().any(|p| sp.contains(p))
}

pub(crate) fn has_image_video_extension(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        let ext_lower = ext.to_lowercase();
        matches!(
            ext_lower.as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "heic" | "heif" | "raw" | "cr2" | "nef" | "orf" | "sr2" | "arw" | "dng" | "rw2" | "raf" | "pef" | "srw" | "3fr" | "x3f" | "mrw" | "mef" | "mos" | "erf" | "dcr" | "kdc" | "fff" | "iiq" | "rwl" | "r3d" | "ari" | "bay" | "cap" | "data" | "dcs" | "drf" | "eip" | "k25" | "mdc" | "nrw" | "obm" | "ptx" | "pxn" | "rwz" | "srf" | "crw" |
            "mp4" | "avi" | "mov" | "mkv" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" | "3gp" | "3g2" | "asf" | "rm" | "rmvb" | "vob" | "ts" | "mts" | "m2ts" | "ogv" | "divx" | "xvid"
        )
    } else {
        false
    }
}

pub(crate) fn discover_item_from_metadata(path: &Path, md: &fs::Metadata) -> Option<DiscoverItem> {
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
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    Some(DiscoverItem {
        path: path.to_path_buf(),
        size_bytes,
        mtime_ns,
        ctime_ns,
        dirname,
        filename,
        ext,
        mime,
    })
}

pub(crate) fn to_discover_item(path: &Path) -> Option<DiscoverItem> {
    let md = fs::metadata(path).ok()?;
    discover_item_from_metadata(path, &md)
}

pub fn start_forwarder(mut rx: Receiver<DiscoverItem>, hash_tx: Sender<HashJob>, meta_tx: Option<Sender<MetaJob>>, db_path: Option<PathBuf>, gauges: Arc<QueueGauges>, _stats: Option<Arc<crate::stats::Stats>>) {
    use tracing::debug;
    tokio::spawn(async move {
        // Open read-only database connection for skip checks if provided
        let db_conn = if let Some(ref dbp) = db_path {
            rusqlite::Connection::open_with_flags(dbp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
        } else {
            None
        };
        
        while let Some(it) = rx.recv().await {
            gauges.discover.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            
            // Skip files that are not images or videos
            if !it.mime.starts_with("image/") && !it.mime.starts_with("video/") {
                debug!("skipping non-image/non-video file: {:?} (mime: {})", it.path, it.mime);
                continue;
            }
            
            // Fast-path: Check if file is unchanged (skip hashing if so)
            // BUT: Always re-hash if SHA256 is missing (needed for thumbnails, especially for videos)
            let mut skip_hash = false;
            if let Some(ref conn) = db_conn {
                let path_str = it.path.to_string_lossy();
                if let Ok(Some((id, xxh64, sha256))) = crate::db::query::check_file_unchanged(conn, &path_str, it.mtime_ns, it.size_bytes) {
                    // File unchanged - skip hashing only if SHA256 is already present
                    // If SHA256 is None, we need to re-hash (especially for video files)
                    if sha256.is_some() {
                        // Check if metadata is complete - if so, skip everything
                        if let Ok(true) = crate::db::query::check_metadata_complete(conn, id, &it.mime) {
                            // File is completely unchanged and fully indexed - skip everything
                            debug!("skipping unchanged file entirely: {:?}", it.path);
                            // Don't increment files_committed - file is already in database and counted
                            continue; // Skip metadata extraction and DB write
                        } else {
                            // Metadata incomplete - still extract metadata
                            if let Some(ref meta_tx) = meta_tx {
                                let hash_job = HashJob {
                                    path: it.path.clone(),
                                    size_bytes: it.size_bytes,
                                    mtime_ns: it.mtime_ns,
                                    ctime_ns: it.ctime_ns,
                                    dirname: it.dirname.clone(),
                                    filename: it.filename.clone(),
                                    ext: it.ext.clone(),
                                    mime: it.mime.clone(),
                                };
                                let meta_job = MetaJob {
                                    job: hash_job,
                                    xxh64,
                                    sha256,
                                };
                                debug!("skipping hash for unchanged file (metadata incomplete): {:?}", it.path);
                                let _ = meta_tx.send(meta_job).await;
                                gauges.metadata.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                skip_hash = true;
                            }
                        }
                    } else {
                        // SHA256 is missing - force re-hash even though file appears unchanged
                        debug!("file unchanged but SHA256 missing, forcing re-hash: {:?}", it.path);
                    }
                }
            }
            
            if !skip_hash {
                let job = HashJob { path: it.path, size_bytes: it.size_bytes, mtime_ns: it.mtime_ns, ctime_ns: it.ctime_ns, dirname: it.dirname, filename: it.filename, ext: it.ext, mime: it.mime };
                debug!("forwarding to hash: {:?}", job.path);
                let _ = hash_tx.send(job).await;
                gauges.hash.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
    });
}

#[cfg(target_os = "linux")]
pub async fn scan_bfs(
    root: PathBuf,
    tx: Sender<DiscoverItem>,
    gauges: Arc<QueueGauges>,
    scan_running: Arc<std::sync::atomic::AtomicBool>,
    stats: Option<Arc<crate::stats::Stats>>,
) -> Result<()> {
    crate::pipeline::discover_linux::scan_bfs_getdents(root, tx, gauges, scan_running, stats).await
}

  #[cfg(not(target_os = "linux"))]
  pub async fn scan_bfs(
      root: PathBuf,
      tx: Sender<DiscoverItem>,
      gauges: Arc<QueueGauges>,
      scan_running: Arc<std::sync::atomic::AtomicBool>,
      _stats: Option<Arc<crate::stats::Stats>>,
  ) -> Result<()> {
      use tracing::{info, warn, debug};
      let patterns = read_ignore(&root);
    info!("scanning root: {:?}", root);
    let mut file_count = 0;
    let mut dir_count = 0;
    let mut check_counter = 0;
    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        // Check scan_running flag periodically (every 100 entries)
        check_counter += 1;
        if check_counter % 100 == 0 {
            if !scan_running.load(std::sync::atomic::Ordering::Relaxed) {
                info!("scan_stopped_during_walk: {:?}", root);
                return Ok(());
            }
        }
        match entry {
              Ok(e) => {
                  let p = e.path();
                  if e.file_type().is_dir() {
                      dir_count += 1;
                      if is_hidden(&p) { continue; }
                      if ignored(&p, &patterns) { continue; }
                      continue;
                  }
                  if is_hidden(&p) { continue; }
                  if ignored(&p, &patterns) { continue; }
                  // Fast-path: skip non-image/non-video extensions before metadata/stat calls
                  if !has_image_video_extension(&p) { continue; }
                  if let Some(item) = to_discover_item(&p) {
                      // Only process image and video files
                      if item.mime.starts_with("image/") || item.mime.starts_with("video/") {
                          file_count += 1;
                          info!("discovered file: {:?} (mime: {})", item.path, item.mime);
                        let _ = tx.send(item).await;
                        gauges.discover.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    } else {
                        debug!("skipping non-image/non-video file: {:?} (mime: {})", item.path, item.mime);
                    }
                } else {
                    warn!("failed to create discover item for: {:?}", p);
                }
            }
            Err(e) => {
                warn!("walkdir error: {:?}", e);
            }
        }
    }
    info!("scan complete, found {} files in {} directories", file_count, dir_count);
    Ok(())
}

pub async fn watch(root: PathBuf, tx: Sender<DiscoverItem>, db_path: Option<PathBuf>, gauges: Arc<QueueGauges>, stats: Option<Arc<crate::stats::Stats>>, watcher_paused: Option<Arc<std::sync::atomic::AtomicBool>>) -> Result<()> {
    let (evt_tx, mut evt_rx) = tokio::sync::mpsc::channel::<notify::Result<notify::Event>>(1024);
    tokio::task::spawn_blocking(move || {
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| { let _ = evt_tx.blocking_send(res); }).unwrap();
        let _ = watcher.watch(&root, RecursiveMode::Recursive);
        std::thread::park();
    });
    
    while let Some(res) = evt_rx.recv().await {
        // Check if watcher is paused before processing events
        if let Some(ref paused) = watcher_paused {
            if paused.load(std::sync::atomic::Ordering::Relaxed) {
                continue; // Skip processing when paused
            }
        }
        
        if let Ok(ev) = res {
            match ev.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for p in ev.paths {
                        if let Some(item) = to_discover_item(&p) {
                            // Only process image and video files
                            if item.mime.starts_with("image/") || item.mime.starts_with("video/") {
                                // Increment discovery counter when file is detected by watcher
                                // This ensures files added after Phase 1 are counted in stats
                                if let Some(ref s) = stats {
                                    s.inc_files(1);
                                }
                                let _ = tx.send(item).await;
                                gauges.discover.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            } else {
                                debug!("skipping non-image/non-video file from watch: {:?} (mime: {})", item.path, item.mime);
                            }
                        }
                    }
                }
                EventKind::Remove(_) => {
                    // Handle file deletions - remove from database
                    if let Some(ref dbp) = db_path {
                        for p in ev.paths {
                            // Check if it's a file (or was a file) and delete from database
                            let path_str = p.to_string_lossy().to_string();
                            let path_str_for_log = path_str.clone();
                            let dbp_clone = dbp.clone();
                            let stats_clone = stats.clone();  // Clone stats for async task
                            use tracing::debug;
                            tokio::spawn(async move {
                                if let Ok(deleted) = tokio::task::spawn_blocking(move || {
                                    if let Ok(conn) = rusqlite::Connection::open(&dbp_clone) {
                                        crate::db::query::delete_asset_by_path(&conn, &path_str)
                                    } else {
                                        Ok(false)
                                    }
                                }).await {
                                    if let Ok(true) = deleted {
                                        debug!("deleted asset from database: {:?}", path_str_for_log);
                                        // Decrement files_committed for deleted asset
                                        if let Some(ref s) = stats_clone {
                                            s.dec_files_committed(1);
                                        }
                                    }
                                }
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

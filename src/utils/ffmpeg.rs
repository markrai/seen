use std::sync::{Arc, Mutex};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use once_cell::sync::Lazy;
use tracing::{debug, warn};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GpuAccel {
    Cuda,
    Qsv,
    D3d11va,
    VideoToolbox,
    Cpu,
}

#[derive(Clone, Debug)]
pub struct FfmpegConfig {
    pub accel: GpuAccel,
    pub enabled: bool,
}

static FFMPEG_CONFIG: Lazy<Arc<Mutex<Option<FfmpegConfig>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

static GPU_STATS: Lazy<Arc<Mutex<GpuStats>>> = Lazy::new(|| Arc::new(Mutex::new(GpuStats::default())));

#[derive(Default, Clone, Debug)]
pub struct GpuStats {
    pub jobs_gpu: u64,
    pub jobs_cpu: u64,
    pub consecutive_failures: u32,
    pub auto_disabled: bool,
}

static GPU_FAILURE_TRACKER: Lazy<Arc<Mutex<GpuFailureTracker>>> = Lazy::new(|| Arc::new(Mutex::new(GpuFailureTracker::default())));

#[derive(Default)]
struct GpuFailureTracker {
    consecutive_failures: u32,
    auto_disabled: bool,
    cpu_jobs_since_last_retry: u32,
}

pub fn init_gpu_config() -> FfmpegConfig {
    let mut config = FFMPEG_CONFIG.lock().unwrap();
    if let Some(ref cfg) = *config {
        return cfg.clone();
    }

    let accel = detect_gpu_accel();
    let enabled = accel != GpuAccel::Cpu;
    
    let cfg = FfmpegConfig { accel, enabled };
    *config = Some(cfg.clone());
    
    if std::env::var("GPU_LOG").is_ok() {
        tracing::info!("GPU acceleration: {:?} (enabled: {})", cfg.accel, cfg.enabled);
    }
    
    cfg
}

pub fn get_gpu_config() -> FfmpegConfig {
    let config = FFMPEG_CONFIG.lock().unwrap();
    let mut cfg = config.clone().unwrap_or_else(|| {
        drop(config);
        init_gpu_config()
    });
    
    // Check if GPU was auto-disabled due to failures
    let mut tracker = GPU_FAILURE_TRACKER.lock().unwrap();
    if tracker.auto_disabled && cfg.enabled {
        // Periodically retry GPU (every 10 CPU jobs) to test if it's working again
        const RETRY_INTERVAL: u32 = 10;
        if tracker.cpu_jobs_since_last_retry >= RETRY_INTERVAL {
            tracker.cpu_jobs_since_last_retry = 0;
            // Allow GPU attempt for this job
            debug!("GPU auto-disabled, but attempting periodic retry");
        } else {
            // Temporarily disable GPU for this request
            cfg.enabled = false;
        }
    }
    drop(tracker);
    
    cfg
}

pub fn get_gpu_stats() -> GpuStats {
    let stats = GPU_STATS.lock().unwrap();
    let tracker = GPU_FAILURE_TRACKER.lock().unwrap();
    GpuStats {
        jobs_gpu: stats.jobs_gpu,
        jobs_cpu: stats.jobs_cpu,
        consecutive_failures: tracker.consecutive_failures,
        auto_disabled: tracker.auto_disabled,
    }
}

pub fn increment_gpu_job() {
    let mut stats = GPU_STATS.lock().unwrap();
    stats.jobs_gpu += 1;
    // Reset failure count and re-enable GPU on successful GPU job
    let mut tracker = GPU_FAILURE_TRACKER.lock().unwrap();
    tracker.consecutive_failures = 0;
    tracker.cpu_jobs_since_last_retry = 0;
    if tracker.auto_disabled {
        tracker.auto_disabled = false;
        debug!("GPU acceleration re-enabled after successful job");
    }
}

pub fn increment_cpu_job() {
    let mut stats = GPU_STATS.lock().unwrap();
    stats.jobs_cpu += 1;
    // Track CPU jobs for periodic GPU retry when auto-disabled
    let mut tracker = GPU_FAILURE_TRACKER.lock().unwrap();
    if tracker.auto_disabled {
        tracker.cpu_jobs_since_last_retry += 1;
    }
}

pub fn record_gpu_failure() {
    let mut tracker = GPU_FAILURE_TRACKER.lock().unwrap();
    tracker.consecutive_failures += 1;
    
    // Auto-disable after 3 consecutive failures
    if tracker.consecutive_failures >= 3 && !tracker.auto_disabled {
        tracker.auto_disabled = true;
        warn!("GPU acceleration auto-disabled after {} consecutive failures", tracker.consecutive_failures);
    }
}

fn detect_gpu_accel() -> GpuAccel {
    // Check environment override
    if let Ok(env_accel) = std::env::var("GPU_ACCEL") {
        match env_accel.to_lowercase().as_str() {
            "off" => return GpuAccel::Cpu,
            "cuda" => return GpuAccel::Cuda,
            "qsv" => return GpuAccel::Qsv,
            "d3d11va" => return GpuAccel::D3d11va,
            "videotoolbox" => return GpuAccel::VideoToolbox,
            "auto" => {} // Continue with auto-detection
            _ => {} // Unknown value, continue with auto-detection
        }
    }

    // Probe ffmpeg for available hardware accelerators
    let output = Command::new("ffmpeg")
        .args(&["-hide_banner", "-hwaccels"])
        .output();
    
    let hwaccels = match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).to_string()
        }
        _ => return GpuAccel::Cpu,
    };

    // Check for available accelerators in priority order
    // Only enable if physical devices are present, not just libraries
    
    if hwaccels.contains("cuda") {
        // Verify scale_cuda filter is available
        if check_filter("scale_cuda") {
            // Check for actual CUDA GPU devices
            if check_cuda_devices() > 0 {
                debug!("GPU: CUDA detected with physical devices available");
                return GpuAccel::Cuda;
            } else {
                debug!("GPU: CUDA libraries found but no physical devices detected");
            }
        }
    }
    
    if hwaccels.contains("qsv") {
        if check_filter("scale_qsv") {
            // Check for Intel GPU devices via VAAPI
            if check_intel_gpu_devices() {
                debug!("GPU: QSV detected with Intel GPU devices available");
                return GpuAccel::Qsv;
            } else {
                debug!("GPU: QSV libraries found but no Intel GPU devices detected");
            }
        }
    }
    
    // Check for OpenCL devices (can be used for general GPU compute)
    if check_opencl_devices() > 0 {
        debug!("GPU: OpenCL devices detected (not used for video processing, but available)");
    }
    
    if hwaccels.contains("d3d11va") {
        // D3D11VA is Windows-specific and usually works if available
        debug!("GPU: D3D11VA detected (decode only, CPU scaling)");
        return GpuAccel::D3d11va;
    }
    
    if hwaccels.contains("videotoolbox") {
        // VideoToolbox is macOS-specific and usually works if available
        debug!("GPU: VideoToolbox detected (decode only, CPU scaling)");
        return GpuAccel::VideoToolbox;
    }
    
    debug!("GPU: No hardware acceleration available, using CPU");
    GpuAccel::Cpu
}

/// Check for physical CUDA GPU devices using nvidia-smi
/// Returns the number of CUDA devices found
pub fn check_cuda_devices() -> u32 {
    // Try nvidia-smi command first (most reliable)
    if let Ok(output) = Command::new("nvidia-smi")
        .args(&["--list-gpus", "--format=csv,noheader"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let count = stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32;
            if count > 0 {
                debug!("CUDA: Found {} GPU device(s) via nvidia-smi", count);
                return count;
            }
        }
    }
    
    // Fallback: try nvidia-smi without format (older versions)
    if let Ok(output) = Command::new("nvidia-smi")
        .args(&["-L"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let count = stdout.lines()
                .filter(|l| l.contains("GPU") || l.contains("NVIDIA"))
                .count() as u32;
            if count > 0 {
                debug!("CUDA: Found {} GPU device(s) via nvidia-smi -L", count);
                return count;
            }
        }
    }
    
    // Check for CUDA device files (Linux)
    if std::path::Path::new("/dev/nvidia0").exists() {
        // Count available nvidia devices
        let mut count = 0;
        for i in 0..16 {
            if std::path::Path::new(&format!("/dev/nvidia{}", i)).exists() {
                count += 1;
            }
        }
        if count > 0 {
            debug!("CUDA: Found {} GPU device(s) via /dev/nvidia*", count);
            return count;
        }
    }
    
    0
}

/// Check for Intel GPU devices via VAAPI
/// Returns true if Intel GPU devices are found
pub fn check_intel_gpu_devices() -> bool {
    // Check for Intel GPU via /dev/dri (Linux)
    if let Ok(entries) = std::fs::read_dir("/dev/dri") {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("renderD") {
                    // Check if it's an Intel device using vainfo
                    if let Ok(output) = Command::new("vainfo")
                        .args(&["--display", &format!("drm:{}", path.display())])
                        .output()
                    {
                        if output.status.success() {
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            if stdout.contains("Intel") || stdout.contains("i965") || stdout.contains("iHD") {
                                debug!("Intel GPU: Found device at {}", path.display());
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Fallback: check for Intel GPU via lspci (if available)
    if let Ok(output) = Command::new("lspci")
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("Intel") && (stdout.contains("Graphics") || stdout.contains("VGA")) {
                debug!("Intel GPU: Found via lspci");
                return true;
            }
        }
    }
    
    false
}

/// Check for OpenCL devices
/// Returns the number of OpenCL devices found
pub fn check_opencl_devices() -> u32 {
    // Try clinfo command (most reliable)
    if let Ok(output) = Command::new("clinfo")
        .args(&["-l"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let count = stdout.lines()
                .filter(|l| l.contains("Device") && (l.contains("GPU") || l.contains("Accelerator")))
                .count() as u32;
            if count > 0 {
                debug!("OpenCL: Found {} device(s) via clinfo", count);
                return count;
            }
        }
    }
    
    // Fallback: try clinfo without -l
    if let Ok(output) = Command::new("clinfo")
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Count unique platforms
            let mut platforms = std::collections::HashSet::new();
            for line in stdout.lines() {
                if line.contains("Platform Name") {
                    platforms.insert(line);
                }
            }
            let count = platforms.len() as u32;
            if count > 0 {
                debug!("OpenCL: Found {} platform(s) via clinfo", count);
                return count;
            }
        }
    }
    
    0
}

fn check_filter(filter_name: &str) -> bool {
    let output = Command::new("ffmpeg")
        .args(&["-hide_banner", "-filters"])
        .output();
    
    match output {
        Ok(o) if o.status.success() => {
            let filters = String::from_utf8_lossy(&o.stdout);
            filters.contains(filter_name)
        }
        _ => false,
    }
}

pub fn build_ffmpeg_args(src: &str, _dst: &Path, size: i32, accel: &GpuAccel) -> Vec<String> {
    match accel {
        GpuAccel::Cuda => {
            vec![
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-hwaccel_output_format".to_string(),
                "cuda".to_string(),
                "-i".to_string(),
                src.to_string(),
                "-ss".to_string(),
                "1".to_string(),
                "-vframes".to_string(),
                "1".to_string(),
                "-vf".to_string(),
                format!("scale_cuda={}:-1", size),
                "-f".to_string(),
                "image2pipe".to_string(), // Output to pipe
                "-vcodec".to_string(),
                "mjpeg".to_string(), // Output as MJPEG
                "pipe:1".to_string(), // Output to stdout
            ]
        }
        GpuAccel::Qsv => {
            vec![
                "-hwaccel".to_string(),
                "qsv".to_string(),
                "-i".to_string(),
                src.to_string(),
                "-ss".to_string(),
                "1".to_string(),
                "-vframes".to_string(),
                "1".to_string(),
                "-vf".to_string(),
                format!("scale_qsv=w={}:h=-1:force_original_aspect_ratio=decrease", size),
                "-f".to_string(),
                "image2pipe".to_string(), // Output to pipe
                "-vcodec".to_string(),
                "mjpeg".to_string(), // Output as MJPEG
                "pipe:1".to_string(), // Output to stdout
            ]
        }
        GpuAccel::D3d11va => {
            // D3D11VA for decode, CPU for scaling
            vec![
                "-hwaccel".to_string(),
                "d3d11va".to_string(),
                "-i".to_string(),
                src.to_string(),
                "-ss".to_string(),
                "1".to_string(),
                "-vframes".to_string(),
                "1".to_string(),
                "-vf".to_string(),
                format!("scale={}:-1", size),
                "-f".to_string(),
                "image2pipe".to_string(), // Output to pipe
                "-vcodec".to_string(),
                "mjpeg".to_string(), // Output as MJPEG
                "pipe:1".to_string(), // Output to stdout
            ]
        }
        GpuAccel::VideoToolbox => {
            // VideoToolbox for decode, CPU for scaling
            vec![
                "-hwaccel".to_string(),
                "videotoolbox".to_string(),
                "-i".to_string(),
                src.to_string(),
                "-ss".to_string(),
                "1".to_string(),
                "-vframes".to_string(),
                "1".to_string(),
                "-vf".to_string(),
                format!("scale={}:-1", size),
                "-f".to_string(),
                "image2pipe".to_string(), // Output to pipe
                "-vcodec".to_string(),
                "mjpeg".to_string(), // Output as MJPEG
                "pipe:1".to_string(), // Output to stdout
            ]
        }
        GpuAccel::Cpu => {
            vec![
                "-i".to_string(),
                src.to_string(),
                "-ss".to_string(),
                "1".to_string(),
                "-vframes".to_string(),
                "1".to_string(),
                "-vf".to_string(),
                format!("scale={}:-1", size),
                "-f".to_string(),
                "image2pipe".to_string(), // Output to pipe
                "-vcodec".to_string(),
                "mjpeg".to_string(), // Output as MJPEG
                "pipe:1".to_string(), // Output to stdout
            ]
        }
    }
}

pub fn run_ffmpeg_with_timeout(args: Vec<String>, timeout: Duration) -> Result<std::process::Output, anyhow::Error> {
    use std::time::Instant;
    use std::io::Read;
    use std::sync::{Arc, Mutex};
    use std::thread;
    
    let mut cmd = Command::new("ffmpeg");
    cmd.args(&args);
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    
    // Log the command for debugging (but truncate long file paths)
    let cmd_str = args.join(" ");
    let cmd_display = if cmd_str.len() > 200 {
        format!("{}...", &cmd_str[..200])
    } else {
        cmd_str.clone()
    };
    tracing::debug!("Running ffmpeg with timeout {:?}: {}", timeout, cmd_display);
    
    // Spawn the process
    let mut child = cmd.spawn()?;
    
    // Take ownership of stdout and stderr handles to read them incrementally
    // This prevents the process from blocking when the stdout buffer fills up
    let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("Failed to get stdout handle"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("Failed to get stderr handle"))?;
    
    // Read stdout and stderr in separate threads to prevent blocking
    let stdout_data = Arc::new(Mutex::new(Vec::new()));
    let stderr_data = Arc::new(Mutex::new(Vec::new()));
    
    let stdout_data_clone = stdout_data.clone();
    let stderr_data_clone = stderr_data.clone();
    
    let stdout_handle = thread::spawn(move || {
        let mut reader = stdout;
        let mut buf = vec![0u8; 64 * 1024]; // 64KB buffer
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let mut data = stdout_data_clone.lock().unwrap();
                    data.extend_from_slice(&buf[..n]);
                }
                Err(e) => {
                    tracing::warn!("Error reading ffmpeg stdout: {}", e);
                    break;
                }
            }
        }
    });
    
    let stderr_handle = thread::spawn(move || {
        let mut reader = stderr;
        let mut buf = vec![0u8; 64 * 1024]; // 64KB buffer
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let mut data = stderr_data_clone.lock().unwrap();
                    data.extend_from_slice(&buf[..n]);
                }
                Err(e) => {
                    tracing::warn!("Error reading ffmpeg stderr: {}", e);
                    break;
                }
            }
        }
    });
    
    let start = Instant::now();
    let mut last_log_time = start;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let elapsed = start.elapsed();
                tracing::info!("ffmpeg process finished in {:?}", elapsed);
                
                // Wait for readers to finish
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                
                let stdout_bytes = stdout_data.lock().unwrap().clone();
                let stderr_bytes = stderr_data.lock().unwrap().clone();
                
                tracing::info!("ffmpeg output: stdout {} bytes, stderr {} bytes", 
                    stdout_bytes.len(), stderr_bytes.len());
                
                // Log stderr content if it's not empty (for debugging)
                if !stderr_bytes.is_empty() {
                    let stderr_str = String::from_utf8_lossy(&stderr_bytes);
                    // Only log if it contains useful information (not just empty lines)
                    if stderr_str.trim().len() > 0 {
                        tracing::debug!("ffmpeg stderr: {}", stderr_str);
                    }
                }
                
                return Ok(std::process::Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                });
            }
            Ok(None) => {
                let elapsed = start.elapsed();
                if elapsed > timeout {
                    // Capture stderr for context before bailing
                    let stderr_bytes = stderr_data.lock().unwrap().clone();
                    let stderr_preview = if !stderr_bytes.is_empty() {
                        String::from_utf8_lossy(&stderr_bytes)
                            .lines()
                            .filter(|l| l.contains("error") || l.contains("Error") || l.contains("ERROR") || l.contains("Failed"))
                            .take(3)
                            .collect::<Vec<_>>()
                            .join("; ")
                    } else {
                        String::new()
                    };
                    tracing::error!("ffmpeg timeout after {:?} (limit: {:?}, command: {}). Stderr preview: {}", 
                        elapsed, timeout, cmd_display, if stderr_preview.is_empty() { "none" } else { &stderr_preview });
                    let _ = child.kill();
                    let _ = child.wait();
                    // Wait for readers to finish
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    let error_msg = if stderr_preview.is_empty() {
                        format!("ffmpeg timeout after {:?} (command: {})", timeout, cmd_display)
                    } else {
                        format!("ffmpeg timeout after {:?} (command: {}). Error details: {}", 
                            timeout, cmd_display, stderr_preview)
                    };
                    anyhow::bail!("{}", error_msg);
                }
                // Log progress every 5 seconds with more detail
                let now = Instant::now();
                if now.duration_since(last_log_time) >= Duration::from_secs(5) {
                    let stdout_size = stdout_data.lock().unwrap().len();
                    let stderr_size = stderr_data.lock().unwrap().len();
                    tracing::warn!("ffmpeg still running, elapsed: {:?}, stdout: {} bytes, stderr: {} bytes", 
                        elapsed, stdout_size, stderr_size);
                    last_log_time = now;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let elapsed = start.elapsed();
                // Capture stderr for context before bailing
                let stderr_bytes = stderr_data.lock().unwrap().clone();
                let stderr_preview = if !stderr_bytes.is_empty() {
                    String::from_utf8_lossy(&stderr_bytes)
                        .lines()
                        .filter(|l| l.contains("error") || l.contains("Error") || l.contains("ERROR") || l.contains("Failed"))
                        .take(3)
                        .collect::<Vec<_>>()
                        .join("; ")
                } else {
                    String::new()
                };
                tracing::error!("ffmpeg process error after {:?} (command: {}): {}. Stderr preview: {}", 
                    elapsed, cmd_display, e, if stderr_preview.is_empty() { "none" } else { &stderr_preview });
                // Wait for readers to finish
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                let error_msg = if stderr_preview.is_empty() {
                    format!("ffmpeg process error after {:?} (command: {}): {}", elapsed, cmd_display, e)
                } else {
                    format!("ffmpeg process error after {:?} (command: {}): {}. Error details: {}", 
                        elapsed, cmd_display, e, stderr_preview)
                };
                anyhow::bail!("{}", error_msg);
            }
        }
    }
}


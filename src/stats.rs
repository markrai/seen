use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub struct Stats {
    files_total: AtomicU64,
    bytes_total: AtomicU64,
    files_committed: AtomicU64,
    started: Instant,
    last_scan_start: parking_lot::Mutex<Option<Instant>>,
    last_processing_start: parking_lot::Mutex<Option<Instant>>,
    last_scan_files: AtomicU64,
    last_scan_committed_files: AtomicU64,
    last_completed_scan_files: AtomicU64,
    last_completed_scan_elapsed: parking_lot::Mutex<Option<f64>>,
    last_completed_scan_rate: parking_lot::Mutex<Option<f64>>,
    last_completed_scan_mb_per_sec: parking_lot::Mutex<Option<f64>>,
    last_completed_processing_rate: parking_lot::Mutex<Option<f64>>,
    last_completed_processing_mb_per_sec: parking_lot::Mutex<Option<f64>>,
    last_completed_processing_elapsed: parking_lot::Mutex<Option<f64>>,
}

impl Default for Stats {
    fn default() -> Self {
        Self::new()
    }
}

impl Stats {
    pub fn new() -> Self {
        Self {
            files_total: AtomicU64::new(0),
            bytes_total: AtomicU64::new(0),
            files_committed: AtomicU64::new(0),
            started: Instant::now(),
            last_scan_start: parking_lot::Mutex::new(None),
            last_processing_start: parking_lot::Mutex::new(None),
            last_scan_files: AtomicU64::new(0),
            last_scan_committed_files: AtomicU64::new(0),
            last_completed_scan_files: AtomicU64::new(0),
            last_completed_scan_elapsed: parking_lot::Mutex::new(None),
            last_completed_scan_rate: parking_lot::Mutex::new(None),
            last_completed_scan_mb_per_sec: parking_lot::Mutex::new(None),
            last_completed_processing_rate: parking_lot::Mutex::new(None),
            last_completed_processing_mb_per_sec: parking_lot::Mutex::new(None),
            last_completed_processing_elapsed: parking_lot::Mutex::new(None),
        }
    }
    pub fn inc_files(&self, n: u64) { self.files_total.fetch_add(n, Ordering::Relaxed); }
    pub fn inc_bytes(&self, n: u64) { self.bytes_total.fetch_add(n, Ordering::Relaxed); }
    pub fn inc_files_committed(&self, n: u64) {
        // Start processing timer on first commit if not already started
        let mut processing_start = self.last_processing_start.lock();
        if processing_start.is_none() {
            *processing_start = Some(Instant::now());
        }
        self.files_committed.fetch_add(n, Ordering::Relaxed);
    }
    pub fn init_files_committed(&self, count: u64) {
        self.files_committed.store(count, Ordering::Relaxed);
        // Also initialize last_scan_committed_files to same value
        // This ensures processing_stats() calculates correctly on first scan
        self.last_scan_committed_files.store(count, Ordering::Relaxed);
    }
    pub fn dec_files_committed(&self, n: u64) {
        // Use saturating_sub to prevent underflow (can't go below 0)
        let current = self.files_committed.load(Ordering::Relaxed);
        let new_value = current.saturating_sub(n);
        self.files_committed.store(new_value, Ordering::Relaxed);
        
        // Also update last_scan_committed_files if it would go below current value
        // This ensures processing_stats() doesn't show negative values
        let scan_committed = self.last_scan_committed_files.load(Ordering::Relaxed);
        if new_value < scan_committed {
            self.last_scan_committed_files.store(new_value, Ordering::Relaxed);
        }
    }
    pub fn files_committed(&self) -> u64 { self.files_committed.load(Ordering::Relaxed) }
    pub fn files_total(&self) -> u64 { self.files_total.load(Ordering::Relaxed) }
    pub fn bytes_total(&self) -> u64 { self.bytes_total.load(Ordering::Relaxed) }
    pub fn uptime_secs(&self) -> u64 { self.started.elapsed().as_secs() }
    pub fn files_per_sec(&self) -> f64 {
        let secs = self.started.elapsed().as_secs_f64();
        if secs <= 0.0 { 0.0 } else { self.files_total() as f64 / secs }
    }
    pub fn bytes_per_sec(&self) -> f64 {
        let secs = self.started.elapsed().as_secs_f64();
        if secs <= 0.0 { 0.0 } else { self.bytes_total() as f64 / secs }
    }
    pub fn start_scan(&self) {
        *self.last_scan_start.lock() = Some(Instant::now());
        // Reset processing start when a new scan starts
        *self.last_processing_start.lock() = None;
        self.last_scan_files.store(self.files_total.load(Ordering::Relaxed), Ordering::Relaxed);
        self.last_scan_committed_files.store(self.files_committed.load(Ordering::Relaxed), Ordering::Relaxed);
    }
    pub fn scan_stats(&self) -> Option<(u64, f64, f64)> {
        let guard = self.last_scan_start.lock();
        let start = *guard.as_ref()?;
        let elapsed = start.elapsed().as_secs_f64();
        let files_processed = self.files_total.load(Ordering::Relaxed).saturating_sub(self.last_scan_files.load(Ordering::Relaxed));
        
        // If no files processed and more than 5 seconds have passed, consider it idle
        // This prevents the rate from continuously decreasing toward zero
        let rate = if files_processed == 0 && elapsed > 5.0 {
            0.0  // Explicitly idle
        } else if elapsed > 0.0 {
            // Calculate current rate
            let current_rate = files_processed as f64 / elapsed;
            
            // If we have a stored completed rate, use it to prevent decay
            // This ensures the rate stays stable after discovery completes
            if let Some(completed_rate) = *self.last_completed_scan_rate.lock() {
                if completed_rate > 0.0 {
                    // Use the stored completed rate (it's the peak rate from when discovery completed)
                    // Only use current rate if it's higher (scan still actively discovering)
                    let rate = if current_rate > completed_rate {
                        current_rate  // Scan is still active and faster than stored rate
                    } else {
                        completed_rate  // Use stored rate to prevent decay
                    };
                    return Some((files_processed, rate, elapsed));
                }
            }
            // No completed rate stored yet - use current calculated rate
            current_rate
        } else {
            0.0
        };
        Some((files_processed, rate, elapsed))
    }
    
    // Store the final rate when a scan completes (called when scan finishes)
    // Note: This should be called immediately when discovery completes, before elapsed time increases
    pub fn finish_scan(&self) {
        let guard = self.last_scan_start.lock();
        let start = match *guard {
            Some(s) => s,
            None => return, // No scan was started
        };
        let elapsed = start.elapsed().as_secs_f64();
        let files_processed = self.files_total.load(Ordering::Relaxed).saturating_sub(self.last_scan_files.load(Ordering::Relaxed));

        // Store last completed scan totals for UI display when idle
        self.last_completed_scan_files.store(files_processed, Ordering::Relaxed);
        *self.last_completed_scan_elapsed.lock() = Some(elapsed);
        
        // Calculate rate at the moment of completion (before it decays)
        if files_processed > 0 && elapsed > 0.0 {
            let rate = files_processed as f64 / elapsed;
            if rate > 0.0 {
                // Store the final scan rate immediately
                *self.last_completed_scan_rate.lock() = Some(rate);
                // For MB/s, calculate based on the scan's bytes_per_sec at completion time
                let mb_per_sec = self.bytes_per_sec() / 1_000_000.0;
                *self.last_completed_scan_mb_per_sec.lock() = Some(mb_per_sec);
            }
        }
        // Clear scan timer so future stats know we're idle
        drop(guard);
        *self.last_scan_start.lock() = None;
    }

    pub fn last_completed_scan_files(&self) -> u64 {
        self.last_completed_scan_files.load(Ordering::Relaxed)
    }

    pub fn last_completed_scan_elapsed(&self) -> Option<f64> {
        *self.last_completed_scan_elapsed.lock()
    }
    
    // Get the last completed scan rate (for display when idle)
    pub fn last_completed_scan_rate(&self) -> Option<f64> {
        *self.last_completed_scan_rate.lock()
    }
    
    pub fn last_completed_scan_mb_per_sec(&self) -> Option<f64> {
        *self.last_completed_scan_mb_per_sec.lock()
    }
    
    // Processing stats: tracks files committed (not discovered)
    pub fn processing_stats(&self) -> Option<(u64, f64, f64)> {
        let guard = self.last_processing_start.lock();
        let start = *guard.as_ref()?;
        let elapsed = start.elapsed().as_secs_f64();
        let files_committed = self.files_committed.load(Ordering::Relaxed).saturating_sub(self.last_scan_committed_files.load(Ordering::Relaxed));
        
        // If no files committed and more than 5 seconds have passed, consider it idle
        let rate = if files_committed == 0 && elapsed > 5.0 {
            0.0  // Explicitly idle
        } else if elapsed > 0.0 {
            files_committed as f64 / elapsed
        } else {
            0.0
        };
        Some((files_committed, rate, elapsed))
    }
    
    // Processing throughput in MB/s (based on committed bytes)
    pub fn processing_throughput_mb_per_sec(&self) -> Option<f64> {
        let guard = self.last_processing_start.lock();
        let start = *guard.as_ref()?;
        let elapsed = start.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            let bytes_committed = self.bytes_total.load(Ordering::Relaxed);
            Some((bytes_committed as f64 / elapsed) / 1_000_000.0)
        } else {
            None
        }
    }
    
    // Store the final processing rate when scan completes
    // Note: This stores values but does NOT clear the timer - call stop_processing() when truly idle
    pub fn finish_processing(&self) {
        if let Some((files, rate, elapsed)) = self.processing_stats() {
            if files > 0 && rate > 0.0 {
                *self.last_completed_processing_rate.lock() = Some(rate);
                if let Some(mb_per_sec) = self.processing_throughput_mb_per_sec() {
                    *self.last_completed_processing_mb_per_sec.lock() = Some(mb_per_sec);
                }
                *self.last_completed_processing_elapsed.lock() = Some(elapsed);
            }
        }
    }

    // Clear processing timer when all queues are empty and processing is truly done
    // This prevents elapsed time from continuing to increase after processing stops
    pub fn stop_processing(&self) {
        // Store final values before clearing timer
        self.finish_processing();
        // Now clear the timer
        *self.last_processing_start.lock() = None;
    }
    
    pub fn last_completed_processing_rate(&self) -> Option<f64> {
        *self.last_completed_processing_rate.lock()
    }
    
    pub fn last_completed_processing_mb_per_sec(&self) -> Option<f64> {
        *self.last_completed_processing_mb_per_sec.lock()
    }
    
    pub fn last_completed_processing_elapsed(&self) -> Option<f64> {
        *self.last_completed_processing_elapsed.lock()
    }
    pub fn metrics_text(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("seen_uptime_seconds {}\n", self.uptime_secs()));
        s.push_str(&format!("seen_processed_files_total {}\n", self.files_total()));
        s.push_str(&format!("seen_processed_bytes_total {}\n", self.bytes_total()));
        s.push_str(&format!("seen_processed_files_per_second {}\n", self.files_per_sec()));
        s.push_str(&format!("seen_processed_bytes_per_second {}\n", self.bytes_per_sec()));
        s
    }
    
    // Reset performance statistics (files, bytes, and start time)
    pub fn reset_stats(&self) {
        self.files_total.store(0, Ordering::Relaxed);
        self.bytes_total.store(0, Ordering::Relaxed);
        self.files_committed.store(0, Ordering::Relaxed);
        // Note: started is not reset as it's used for uptime calculation
        // Instead, we reset last_scan_files to 0 so new scans start from 0
        self.last_scan_files.store(0, Ordering::Relaxed);
        self.last_scan_committed_files.store(0, Ordering::Relaxed);
        *self.last_scan_start.lock() = None;
        *self.last_processing_start.lock() = None;
        *self.last_completed_scan_rate.lock() = None;
        *self.last_completed_scan_mb_per_sec.lock() = None;
        *self.last_completed_processing_rate.lock() = None;
        *self.last_completed_processing_mb_per_sec.lock() = None;
        *self.last_completed_processing_elapsed.lock() = None;
    }
}

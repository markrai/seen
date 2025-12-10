use once_cell::sync::OnceCell;
use std::sync::Mutex;

// Global profiler guard, initialized only when explicitly enabled
// (e.g., via SEEN_PROFILE_FLAMEGRAPH in docker-compose.custom.yml).
static PROFILER_GUARD: OnceCell<Mutex<Option<pprof::ProfilerGuard<'static>>>> = OnceCell::new();

pub fn init_if_enabled() {
    if std::env::var("SEEN_PROFILE_FLAMEGRAPH").is_ok() {
        let guard = pprof::ProfilerGuardBuilder::default()
            .frequency(99)
            .build()
            .ok();
        let _ = PROFILER_GUARD.set(Mutex::new(guard));
    }
}

pub fn generate_flamegraph_svg() -> Option<Vec<u8>> {
    let guard_mutex = PROFILER_GUARD.get()?;
    let guard_opt = guard_mutex.lock().ok()?;
    let guard = guard_opt.as_ref()?;

    let report = guard.report().build().ok()?;
    let mut buf = Vec::new();
    if report.flamegraph(&mut buf).is_ok() {
        Some(buf)
    } else {
        None
    }
}


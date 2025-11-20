use tracing_subscriber::EnvFilter;

pub fn init() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    let fmt = tracing_subscriber::fmt().with_env_filter(EnvFilter::new(filter)).with_ansi(false);
    fmt.init();
}

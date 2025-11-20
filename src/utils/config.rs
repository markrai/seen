use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub root: PathBuf,
    pub root_host: Option<String>,
    pub data: PathBuf,
    pub port: u16,
    pub hash_threads: usize,
    pub meta_threads: usize,
    pub thumb_threads: usize,
    pub thumb_size: i32,
    pub preview_size: i32,
}

impl Config {
    pub fn from_env() -> Self {
        let root = env::var("FLASH_ROOT").unwrap_or_else(|_| "/photos".to_string());
        let root_host = env::var("FLASH_ROOT_HOST").ok();
        let data = env::var("FLASH_DATA").unwrap_or_else(|_| "/flash-data".to_string());
        let port = env::var("FLASH_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(9161);
        let hash_threads = env::var("FLASH_HASH_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
        let meta_threads = env::var("FLASH_META_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
        let thumb_threads = env::var("FLASH_THUMB_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let thumb_size = env::var("FLASH_THUMB_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
        let preview_size = env::var("FLASH_PREVIEW_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(1600);
        Self {
            root: PathBuf::from(root),
            root_host,
            data: PathBuf::from(data),
            port,
            hash_threads,
            meta_threads,
            thumb_threads,
            thumb_size,
            preview_size,
        }
    }
}

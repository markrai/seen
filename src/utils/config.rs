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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        // Clear environment variables
        env::remove_var("FLASH_ROOT");
        env::remove_var("FLASH_DATA");
        env::remove_var("FLASH_PORT");
        env::remove_var("FLASH_HASH_THREADS");
        env::remove_var("FLASH_META_THREADS");
        env::remove_var("FLASH_THUMB_THREADS");
        env::remove_var("FLASH_THUMB_SIZE");
        env::remove_var("FLASH_PREVIEW_SIZE");
        
        let config = Config::from_env();
        assert_eq!(config.root, PathBuf::from("/photos"));
        assert_eq!(config.data, PathBuf::from("/flash-data"));
        assert_eq!(config.port, 9161);
        assert_eq!(config.hash_threads, 2);
        assert_eq!(config.meta_threads, 2);
        assert_eq!(config.thumb_threads, 1);
        assert_eq!(config.thumb_size, 256);
        assert_eq!(config.preview_size, 1600);
    }

    #[test]
    fn test_config_from_env() {
        env::set_var("FLASH_ROOT", "/custom/photos");
        env::set_var("FLASH_DATA", "/custom/data");
        env::set_var("FLASH_PORT", "8080");
        env::set_var("FLASH_HASH_THREADS", "4");
        env::set_var("FLASH_META_THREADS", "3");
        env::set_var("FLASH_THUMB_THREADS", "2");
        env::set_var("FLASH_THUMB_SIZE", "512");
        env::set_var("FLASH_PREVIEW_SIZE", "2048");
        
        let config = Config::from_env();
        assert_eq!(config.root, PathBuf::from("/custom/photos"));
        assert_eq!(config.data, PathBuf::from("/custom/data"));
        assert_eq!(config.port, 8080);
        assert_eq!(config.hash_threads, 4);
        assert_eq!(config.meta_threads, 3);
        assert_eq!(config.thumb_threads, 2);
        assert_eq!(config.thumb_size, 512);
        assert_eq!(config.preview_size, 2048);
        
        // Cleanup
        env::remove_var("FLASH_ROOT");
        env::remove_var("FLASH_DATA");
        env::remove_var("FLASH_PORT");
        env::remove_var("FLASH_HASH_THREADS");
        env::remove_var("FLASH_META_THREADS");
        env::remove_var("FLASH_THUMB_THREADS");
        env::remove_var("FLASH_THUMB_SIZE");
        env::remove_var("FLASH_PREVIEW_SIZE");
    }

    #[test]
    fn test_config_root_host() {
        env::set_var("FLASH_ROOT_HOST", "/host/path");
        let config = Config::from_env();
        assert_eq!(config.root_host, Some("/host/path".to_string()));
        env::remove_var("FLASH_ROOT_HOST");
    }
}
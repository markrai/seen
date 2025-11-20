use std::path::{Path, PathBuf};

use crate::AppPaths;

/// Resolve an asset path stored in the database to a path that exists inside
/// the environment where the backend is running.
///
/// When the backend runs directly on the host, the stored path already points
/// to a real file. When it runs inside Docker/WSL, the database still contains
/// the host path (e.g. `C:\Users\me\Pictures`), while the container only sees
/// the bind-mounted directory (e.g. `/photos`). If `AppPaths::root_host` is
/// configured, we strip that prefix and substitute `AppPaths::root` instead.
pub fn resolve_asset_path(raw: &str, paths: &AppPaths) -> PathBuf {
    let raw_path = PathBuf::from(raw);
    if raw_path.exists() {
        return raw_path;
    }

    if let Some(host_root) = &paths.root_host {
        if let Some(mapped) = map_host_to_container(raw, host_root, &paths.root) {
            if mapped.exists() {
                return mapped;
            }
            // Even if it does not exist yet, return the mapped path so the
            // caller can provide a meaningful error that references the
            // container path.
            return mapped;
        }
    }

    raw_path
}

fn map_host_to_container(raw: &str, host_root: &str, container_root: &Path) -> Option<PathBuf> {
    let raw_path = Path::new(raw);
    let host_root_path = Path::new(host_root);
    if let Ok(relative) = raw_path.strip_prefix(host_root_path) {
        let mut mapped = container_root.to_path_buf();
        mapped.push(relative);
        Some(mapped)
    } else {
        None
    }
}


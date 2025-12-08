use anyhow::Result;
use rusqlite::Connection;

pub fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "mmap_size", 268435456i64)?;
    conn.pragma_update(None, "page_size", 4096i64)?;
    Ok(())
}

pub fn apply_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  dirname TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  ctime_ns INTEGER NOT NULL,
  sha256 BLOB,
  xxh64 INTEGER,
  taken_at INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  camera_make TEXT,
  camera_model TEXT,
  lens_model TEXT,
  iso INTEGER,
  fnumber REAL,
  exposure REAL,
  video_codec TEXT,
  mime TEXT NOT NULL,
  flags INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_assets USING fts5(filename, dirname, path, content='');
CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
CREATE INDEX IF NOT EXISTS idx_assets_taken ON assets(taken_at);
CREATE INDEX IF NOT EXISTS idx_assets_cam ON assets(camera_make, camera_model);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(sha256);
CREATE INDEX IF NOT EXISTS idx_assets_mime ON assets(mime);
CREATE INDEX IF NOT EXISTS idx_assets_ext ON assets(ext);
CREATE INDEX IF NOT EXISTS idx_assets_dirname ON assets(dirname);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_embeddings (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  person_id INTEGER,
  embedding_blob BLOB NOT NULL,
  bbox_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id),
  FOREIGN KEY(person_id) REFERENCES persons(id)
);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_asset ON face_embeddings(asset_id);
CREATE INDEX IF NOT EXISTS idx_face_embeddings_person ON face_embeddings(person_id);

CREATE TABLE IF NOT EXISTS person_profiles (
  person_id INTEGER PRIMARY KEY,
  centroid_blob BLOB NOT NULL,
  face_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(person_id) REFERENCES persons(id)
);

CREATE TABLE IF NOT EXISTS scan_paths (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS album_assets (
  album_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY(album_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_album_assets_album ON album_assets(album_id);
CREATE INDEX IF NOT EXISTS idx_album_assets_asset ON album_assets(asset_id);
    "#,
    )?;

    // Backwards-compatible migration: ensure video_codec column exists
    let mut stmt = conn.prepare("PRAGMA table_info(assets)")?;
    let mut has_video_codec = false;
    {
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for name in rows {
            if name.unwrap_or_default() == "video_codec" {
                has_video_codec = true;
                break;
            }
        }
    }
    if !has_video_codec {
        let _ = conn.execute("ALTER TABLE assets ADD COLUMN video_codec TEXT", []);
    }

    Ok(())
}

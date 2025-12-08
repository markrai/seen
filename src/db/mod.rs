pub mod schema;
pub mod writer;
pub mod query;

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

pub fn open_or_create<P: AsRef<Path>>(db_path: P) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    schema::apply_pragmas(&conn)?;
    schema::apply_schema(&conn)?;
    Ok(conn)
}

/// Create a connection pool for SQLite with WAL mode enabled
///
/// The pool size is set to 10 by default, which works well with SQLite's WAL mode
/// allowing concurrent readers while still having a single writer.
pub fn create_pool<P: AsRef<Path>>(db_path: P, pool_size: u32) -> Result<Pool<SqliteConnectionManager>> {
    let manager = SqliteConnectionManager::file(db_path.as_ref())
        .with_init(|conn| {
            // Apply pragmas to each connection in the pool
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "temp_store", "MEMORY")?;
            conn.pragma_update(None, "mmap_size", 268435456i64)?;
            conn.pragma_update(None, "page_size", 4096i64)?;
            Ok(())
        });

    let pool = Pool::builder()
        .max_size(pool_size)
        .build(manager)?;

    // Apply schema using a connection from the pool
    {
        let conn = pool.get()?;
        schema::apply_schema(&conn)?;
    }

    Ok(pool)
}

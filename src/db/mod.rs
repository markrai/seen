pub mod schema;
pub mod writer;
pub mod query;

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn open_or_create<P: AsRef<Path>>(db_path: P) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    schema::apply_pragmas(&conn)?;
    schema::apply_schema(&conn)?;
    Ok(conn)
}

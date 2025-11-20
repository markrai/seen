use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Asset {
    pub id: i64,
    pub path: String,
    pub dirname: String,
    pub filename: String,
    pub ext: String,
    pub size_bytes: i64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub sha256: Option<String>,
    pub xxh64: Option<i64>,
    pub taken_at: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<i64>,
    pub fnumber: Option<f64>,
    pub exposure: Option<f64>,
    pub video_codec: Option<String>,
    pub mime: String,
    pub flags: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Paged<T> {
    pub total: i64,
    pub items: Vec<T>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatchCounts {
    pub filename: i64,
    pub dirname: i64,
    pub path: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub total: i64,
    pub items: Vec<Asset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_counts: Option<SearchMatchCounts>,
}

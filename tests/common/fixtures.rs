use std::path::PathBuf;
use std::io::Write;

/// Create a minimal valid JPEG image file
pub fn create_jpeg(path: &PathBuf) -> std::io::Result<()> {
    use base64::{Engine as _, engine::general_purpose};
    let img_bytes = general_purpose::STANDARD.decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCABkAGQDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB3AAAAAP/Z").unwrap();
    std::fs::write(path, &img_bytes)
}

/// Create a minimal valid PNG image file
pub fn create_png(path: &PathBuf) -> std::io::Result<()> {
    let png_bytes = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
        0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
        0x08, 0x99, 0x01, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x02,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::write(path, &png_bytes)
}

/// Create a corrupted image file (invalid data)
pub fn create_corrupted_image(path: &PathBuf) -> std::io::Result<()> {
    std::fs::write(path, b"NOT AN IMAGE FILE")
}

/// Create a large file for performance testing
pub fn create_large_file(path: &PathBuf, size_mb: usize) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    let chunk = vec![0u8; 1024 * 1024]; // 1MB chunk
    for _ in 0..size_mb {
        file.write_all(&chunk)?;
    }
    file.sync_all()?;
    Ok(())
}

/// Create a file with special characters in the name
pub fn create_file_with_special_chars(dir: &PathBuf, name: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    std::fs::write(&path, b"test content")?;
    Ok(path)
}

/// Create a file with Unicode characters in the name
pub fn create_file_with_unicode(dir: &PathBuf, name: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    std::fs::write(&path, b"test content")?;
    Ok(path)
}


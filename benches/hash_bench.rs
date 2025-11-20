use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

fn create_test_file(size_mb: usize) -> std::path::PathBuf {
    let dir = tempdir().unwrap();
    let path = dir.path().join("test_file.bin");
    let mut file = File::create(&path).unwrap();
    let data = vec![0u8; 1024 * 1024]; // 1MB chunk
    for _ in 0..size_mb {
        file.write_all(&data).unwrap();
    }
    file.sync_all().unwrap();
    path
}

fn bench_hash_small(c: &mut Criterion) {
    let path = create_test_file(1); // 1MB file
    c.bench_function("hash_1mb", |b| {
        b.iter(|| {
            // This would need to be adapted to your actual hash_file function
            // For now, just a placeholder
            black_box(&path);
        });
    });
}

fn bench_hash_large(c: &mut Criterion) {
    let path = create_test_file(100); // 100MB file
    c.bench_function("hash_100mb", |b| {
        b.iter(|| {
            black_box(&path);
        });
    });
}

criterion_group!(benches, bench_hash_small, bench_hash_large);
criterion_main!(benches);


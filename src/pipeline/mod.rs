pub mod discover;
#[cfg(target_os = "linux")]
pub mod discover_linux;
pub mod hash;
pub mod metadata;
pub mod thumb;
#[cfg(feature = "facial-recognition")]
pub mod face;

use tokio::sync::mpsc::Sender;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
pub struct Queues {
    pub discover_tx: Sender<discover::DiscoverItem>,
    pub hash_tx: Sender<hash::HashJob>,
    pub meta_tx: Sender<metadata::MetaJob>,
    pub db_tx: Sender<crate::db::writer::DbWriteItem>,
    pub thumb_tx: Sender<thumb::ThumbJob>,
    #[cfg(feature = "facial-recognition")]
    pub face_tx: Sender<face::FaceJob>,
}

pub struct QueueDepths {
    pub discover: usize,
    pub hash: usize,
    pub metadata: usize,
    pub db_write: usize,
    pub thumb: usize,
    #[cfg(feature = "facial-recognition")]
    pub face: usize,
}

#[derive(Default)]
pub struct QueueGauges {
    pub discover: AtomicUsize,
    pub hash: AtomicUsize,
    pub metadata: AtomicUsize,
    pub db_write: AtomicUsize,
    pub thumb: AtomicUsize,
    #[cfg(feature = "facial-recognition")]
    pub face: AtomicUsize,
}

impl QueueGauges {
    pub fn depths(&self) -> QueueDepths {
        QueueDepths {
            discover: self.discover.load(Ordering::Relaxed),
            hash: self.hash.load(Ordering::Relaxed),
            metadata: self.metadata.load(Ordering::Relaxed),
            db_write: self.db_write.load(Ordering::Relaxed),
            thumb: self.thumb.load(Ordering::Relaxed),
            #[cfg(feature = "facial-recognition")]
            face: self.face.load(Ordering::Relaxed),
        }
    }
}

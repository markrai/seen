use axum::{Router, routing::{get, post, delete, put}};
use std::sync::Arc;
use tower_http::cors::{CorsLayer, AllowOrigin};
use axum::http::Method;
use crate::AppState;
use crate::api::handlers;
#[cfg(feature = "facial-recognition")]
use crate::api::handlers_face;

pub fn router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::any()) // Allow all origins for development (includes file:// and localhost:5173)
        .allow_methods(vec![Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(vec![axum::http::header::CONTENT_TYPE, axum::http::header::ACCEPT]);

    let router = {
        let r = Router::new()
            .route("/health", get(handlers::health))
            .route("/stats", get(handlers::stats))
            .route("/stats/reset", post(handlers::reset_stats))
            .route("/clear", delete(handlers::clear_all_data))
            .route("/assets", get(handlers::assets))
            .route("/assets/search", get(handlers::assets_search))
            .route("/thumb/:id", get(handlers::thumb_256))
            .route("/preview/:id", get(handlers::preview_1600))
            .route("/asset/:id", get(handlers::get_asset))
            .route("/asset/:id/video", get(handlers::stream_video))
            .route("/asset/:id/audio.mp3", get(handlers::extract_audio_mp3))
            .route("/asset/:id/download", get(handlers::download_asset))
            .route("/asset/:id", delete(handlers::delete_asset))
            .route("/asset/:id/permanent", delete(handlers::delete_asset_permanent))
            .route("/assets/permanent", post(handlers::delete_assets_permanent))
            .route("/asset/:id/orientation", post(handlers::save_orientation))
            .route("/file-types", get(handlers::file_types))
            .route("/metrics", get(handlers::metrics))
            .route("/performance", get(handlers::performance))
            .route("/diag/ffmpeg", get(handlers::diag_ffmpeg))
            // More specific routes must come before less specific ones
            .route("/paths/scan", post(handlers::scan_path))
            .route("/paths/pause", post(handlers::pause_path))
            .route("/paths/resume", post(handlers::resume_path))
            .route("/paths/status", get(handlers::get_path_status))
            .route("/paths", get(handlers::get_scan_paths))
            .route("/paths", post(handlers::add_scan_path))
            .route("/paths", delete(handlers::remove_scan_path))
            .route("/browse", get(handlers::browse_directory))
            .route("/albums", get(handlers::list_albums))
            .route("/albums", post(handlers::create_album))
            .route("/albums/:id", get(handlers::get_album))
            .route("/albums/:id", put(handlers::update_album))
            .route("/albums/:id", delete(handlers::delete_album))
            .route("/albums/:id/assets", post(handlers::add_assets_to_album))
            .route("/albums/:id/assets", delete(handlers::remove_assets_from_album))
            .route("/albums/for-asset/:asset_id", get(handlers::get_albums_for_asset));

        #[cfg(feature = "facial-recognition")]
        let r = {
            r.route("/faces/detect", post(handlers_face::detect_faces))
                .route("/faces/stop", post(handlers_face::stop_face_detection))
                .route("/faces/settings", get(handlers_face::get_face_settings).post(handlers_face::update_face_settings))
                .route("/faces/status", get(handlers_face::face_detection_status))
                .route("/faces/progress", get(handlers_face::face_progress))
                .route("/faces/unassigned", get(handlers_face::list_unassigned_faces))
                .route("/faces/:id/thumb", get(handlers_face::face_thumb))
                .route("/faces/recluster/person/:id", post(handlers_face::refresh_person_profile))
                .route("/faces/:id/assign", post(handlers_face::assign_face_to_person))
                .route("/faces/cluster", post(handlers_face::trigger_clustering))
                .route("/faces/recluster", post(handlers_face::recluster_faces))
                .route("/faces/smart-merge", post(handlers_face::smart_merge_persons))
                .route("/faces/clear", delete(handlers_face::clear_facial_data))
                .route("/persons", get(handlers_face::list_persons))
                .route("/persons/:id", get(handlers_face::get_person))
                .route("/persons/:id/assets", get(handlers_face::get_person_assets))
                .route("/persons/:id/face", get(handlers_face::get_person_face))
                .route("/persons/:id", post(handlers_face::update_person))
                .route("/persons/:id", delete(handlers_face::delete_person))
                .route("/persons/merge", post(handlers_face::merge_persons))
                .route("/assets/:id/faces", get(handlers_face::get_asset_faces))
        };
        #[cfg(not(feature = "facial-recognition"))]
        let r = r;
        r
    };

    router
        .layer(cors)
        .with_state(state)
}

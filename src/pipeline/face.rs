#[cfg(feature = "facial-recognition")]
use anyhow::{Context, Result};
#[cfg(feature = "facial-recognition")]
use image::DynamicImage;
#[cfg(feature = "facial-recognition")]
use ort::session::Session;
#[cfg(feature = "facial-recognition")]
use ort::value::Value;
// Note: ExecutionProvider API may vary by ort version
// If CUDA is not available, we'll skip GPU acceleration
use parking_lot::Mutex;
#[cfg(feature = "facial-recognition")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "facial-recognition")]
use std::collections::HashMap;
#[cfg(feature = "facial-recognition")]
use std::path::{Path, PathBuf};
#[cfg(feature = "facial-recognition")]
use std::sync::Arc;
#[cfg(feature = "facial-recognition")]
use tokio::sync::mpsc;
#[cfg(feature = "facial-recognition")]
use tracing::{error, info, warn};

// Public cluster batch size used by UI status
#[cfg(feature = "facial-recognition")]
pub const FACE_CLUSTER_BATCH_SIZE: usize = 100;

#[cfg(feature = "facial-recognition")]
fn get_cluster_batch_size() -> usize {
    std::env::var("NAZR_FACE_CLUSTER_BATCH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(FACE_CLUSTER_BATCH_SIZE)
}

// Model URLs
#[cfg(feature = "facial-recognition")]
const SCRFD_MODEL_URL_HF: &str = "https://huggingface.co/ykk648/face_lib/resolve/main/face_detect/scrfd_onnx/scrfd_500m_bnkps.onnx";
#[cfg(feature = "facial-recognition")]
const SCRFD_MODEL_URL_GH: &str = "https://github.com/deepinsight/insightface/releases/download/v0.7/scrfd_500m_bnkps.onnx";
#[cfg(feature = "facial-recognition")]
const ARCFACE_MODEL_URL_PRIMARY: &str = "https://huggingface.co/maze/faceX/resolve/e010b5098c3685fd00b22dd2aec6f37320e3d850/w600k_r50.onnx";

#[cfg(feature = "facial-recognition")]
pub struct FaceJob {
    pub asset_id: i64,
    pub image_path: PathBuf,
}

#[cfg(feature = "facial-recognition")]
pub struct FaceProcessor {
    pub models_dir: PathBuf,
    use_gpu: bool,
    scrfd_session: Option<Mutex<Session>>,
    arcface_session: Option<Mutex<Session>>,
}

#[cfg(feature = "facial-recognition")]
pub type ScrfdPreprocessResult = ([i64; 4], Vec<f32>, f32, f32, f32);

#[cfg(feature = "facial-recognition")]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceBbox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub confidence: f32,
}

#[cfg(feature = "facial-recognition")]
#[derive(Debug, Clone)]
pub struct FaceEmbedding {
    pub embedding: Vec<f32>,
    pub bbox: FaceBbox,
    pub asset_id: i64,
}

#[cfg(feature = "facial-recognition")]
impl FaceProcessor {
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            use_gpu: std::env::var("NAZR_FACE_USE_GPU")
                .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE"))
                .unwrap_or(false),
            scrfd_session: None,
            arcface_session: None,
        }
    }

    // Lightweight accessors for model load state
    pub fn scrfd_loaded(&self) -> bool { self.scrfd_session.is_some() }
    pub fn arcface_loaded(&self) -> bool { self.arcface_session.is_some() }

    pub async fn initialize(&mut self) -> Result<()> {
        std::fs::create_dir_all(&self.models_dir)
            .context("Failed to create models directory")?;

        let auto_dl = std::env::var("NAZR_FACE_AUTO_DOWNLOAD")
            .map(|v| !matches!(v.as_str(), "0" | "false" | "FALSE"))
            .unwrap_or(true);
        if auto_dl {
            if let Err(e) = self.download_models().await {
                warn!("Face model auto-download failed: {}", e);
            }
        } else {
            info!("Face model auto-download disabled by user.");
        }

        if let Err(e) = self.load_models().await {
            warn!("Face models not loaded: {}", e);
        }
        Ok(())
    }

    async fn download_models(&self) -> Result<()> {
        let scrfd_path = self.models_dir.join("scrfd_500m_bnkps.onnx");
        let arcface_path = self.models_dir.join("w600k_r50.onnx");
        let client = self.create_http_client()?;

        if !scrfd_path.exists() {
            info!("Downloading SCRFD face detection model...");
            if let Err(e) = self.download_file(&client, SCRFD_MODEL_URL_HF, &scrfd_path).await {
                warn!("Failed to download from Hugging Face: {}. Trying GitHub...", e);
                self.download_file(&client, SCRFD_MODEL_URL_GH, &scrfd_path).await?;
            }
        }

        if !arcface_path.exists() {
            info!("Downloading ArcFace recognition model (w600k_r50.onnx)...");
            self.download_file(&client, ARCFACE_MODEL_URL_PRIMARY, &arcface_path).await?;
        }

        Ok(())
    }

    fn create_http_client(&self) -> Result<reqwest::Client> {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(token) = std::env::var("HF_TOKEN") {
            if !token.is_empty() {
                info!("Using Hugging Face token for model download.");
                headers.insert(
                    reqwest::header::AUTHORIZATION,
                    reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token))?
                );
            }
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .context("Failed to create HTTP client")
    }

    async fn download_file(&self, client: &reqwest::Client, url: &str, path: &Path) -> Result<()> {
        let response = client
            .get(url)
            .send()
            .await
            .context(format!("Failed to download model from {}", url))?;
        if !response.status().is_success() {
            anyhow::bail!("Failed to download model: HTTP {}", response.status());
        }
        let bytes = response.bytes().await.context("Failed to read response body")?;
        
        // Write file
        std::fs::write(path, &bytes).context(format!("Failed to write file: {:?}", path))?;
        
        // Verify file integrity: check that file exists and has correct size
        let metadata = std::fs::metadata(path)
            .context(format!("Failed to read metadata for downloaded file: {:?}", path))?;
        if metadata.len() != bytes.len() as u64 {
            anyhow::bail!(
                "File integrity check failed: expected {} bytes, got {} bytes",
                bytes.len(),
                metadata.len()
            );
        }
        
        // Basic sanity check: ONNX files should be at least a few KB
        if bytes.len() < 1024 {
            anyhow::bail!("Downloaded file is suspiciously small ({} bytes), may be corrupted", bytes.len());
        }
        
        info!("Downloaded model to {:?} ({} bytes, verified)", path, bytes.len());
        Ok(())
    }

    async fn load_models(&mut self) -> Result<()> {
        let scrfd_path = self.models_dir.join("scrfd_500m_bnkps.onnx");
        let arcface_path = self.models_dir.join("w600k_r50.onnx");

        if !scrfd_path.exists() || !arcface_path.exists() {
            anyhow::bail!(
                "Face models missing; expected SCRFD at {:?} and ArcFace at {:?}",
                scrfd_path, arcface_path
            );
        }

        let scrfd_builder = Session::builder()?;
        let arc_builder = Session::builder()?;

        if self.use_gpu {
            info!("Attempting to use GPU for face models.");
            // TODO: Fix GPU execution provider configuration
            // The ExecutionProvider API in ort 2.0.0-rc.10 may require a different approach
            // For now, GPU configuration is disabled to allow compilation
            // See ort crate documentation for the correct way to configure CUDA execution providers
            warn!("GPU support temporarily disabled - using CPU. ExecutionProvider API needs to be updated for ort 2.0.0-rc.10");
        } else {
            info!("Using CPU for face models (GPU disabled by config).");
        }

        let scrfd = scrfd_builder
            .commit_from_file(&scrfd_path)
            .context("Failed to create SCRFD session")?;
        let arc = arc_builder
            .commit_from_file(&arcface_path)
            .context("Failed to create ArcFace session")?;

        self.scrfd_session = Some(Mutex::new(scrfd));
        self.arcface_session = Some(Mutex::new(arc));
        info!("Face models loaded: SCRFD={:?} ArcFace={:?}", scrfd_path, arcface_path);
        Ok(())
    }

    fn preprocess_scrfd(&self, image: &DynamicImage) -> Result<ScrfdPreprocessResult> {
        // Resize with padding to 640x640 (NCHW), normalize to [-1, 1]
        let (ow, oh) = (image.width() as f32, image.height() as f32);
        let scale = 640.0 / ow.max(oh);
        let nw = (ow * scale) as u32;
        let nh = (oh * scale) as u32;
        let resized = image.resize_exact(nw, nh, image::imageops::FilterType::Triangle);
        let mut padded = image::DynamicImage::new_rgb8(640, 640);
        image::imageops::overlay(&mut padded, &resized, 0, 0);
        let rgb = padded.to_rgb8();
        let mut data = Vec::with_capacity(1 * 3 * 640 * 640);
        for c in 0..3 {
            for y in 0..640u32 {
                for x in 0..640u32 {
                    let p = rgb.get_pixel(x, y);
                    // InsightFace models typically expect BGR, not RGB
                    let v = match c { 
                        0 => p[2], // B
                        1 => p[1], // G
                        _ => p[0]  // R
                    } as f32;
                    data.push((v - 127.5) / 128.0);
                }
            }
        }
        // Return scale, original width, original height for coordinate conversion
        let sum: f32 = data.iter().sum();
        let mean = sum / data.len() as f32;
        let min = data.iter().fold(f32::INFINITY, |a, &b| a.min(b));
        let max = data.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
        info!("SCRFD Preprocess: shape=[1, 3, 640, 640], mean={:.4}, min={:.4}, max={:.4}", mean, min, max);
        Ok(([1, 3, 640, 640], data, scale, ow, oh))
    }

    fn preprocess_arcface(&self, face_crop: &DynamicImage) -> Result<([i64; 4], Vec<f32>)> {
        let resized = face_crop.resize_exact(112, 112, image::imageops::FilterType::Triangle);
        let rgb = resized.to_rgb8();
        let mut data = Vec::with_capacity(1 * 3 * 112 * 112);
        for c in 0..3 {
            for y in 0..112u32 {
                for x in 0..112u32 {
                    let p = rgb.get_pixel(x, y);
                    let v = match c { 0 => p[0], 1 => p[1], _ => p[2] } as f32;
                    data.push((v - 127.5) / 128.0);
                }
            }
        }
        Ok(([1, 3, 112, 112], data))
    }

    pub fn detect_faces(&self, image: &DynamicImage) -> Result<Vec<FaceBbox>> {
        let mut session_guard = self
            .scrfd_session
            .as_ref()
            .context("Detection model not loaded")?
            .lock();
        let (shape, data, scale, _orig_w, _orig_h) = self.preprocess_scrfd(image)?;
        
        let img_w = image.width() as f32;
        let img_h = image.height() as f32;
        info!("Face detection: original image {}x{}, scale={:.4}", img_w, img_h, scale);

        // Get input name directly from session metadata
        let input_name = session_guard.inputs[0].name.clone();
        info!("SCRFD input key detected: {}", input_name);

        let input = Value::from_array((shape.to_vec(), data))
            .context("Failed to create SCRFD input tensor")?;
        let outputs = session_guard
            .run(ort::inputs![input_name => input])
            .context("SCRFD inference failed")?;
        for k in outputs.keys() {
            info!("SCRFD output key detected: {}", k);
        }

        // SCRFD outputs multiple scales (8, 16, 32) - we need to combine them all
        // Collect all scores and boxes from all scales
        let mut all_scores = Vec::new();
        let mut all_boxes = Vec::new();
        
        for scale in ["8", "16", "32"] {
            if let (Some(sv), Some(bv)) = (outputs.get(&format!("score_{}", scale)), outputs.get(&format!("bbox_{}", scale))) {
                if let (Ok((_, scores)), Ok((_, boxes))) = (sv.try_extract_tensor::<f32>(), bv.try_extract_tensor::<f32>()) {
                    info!("SCRFD scale_{}: {} scores, {} boxes", scale, scores.len(), boxes.len());
                    all_scores.extend_from_slice(&scores);
                    all_boxes.extend_from_slice(&boxes);
                }
            }
        }
        
        // Fallback to single scale if multi-scale not available
        if all_scores.is_empty() {
            // First try standard names
            let score_val = outputs.get("score_8").or_else(|| outputs.get("score"));
            let bbox_val = outputs.get("bbox_8").or_else(|| outputs.get("bbox"));
            
            if let (Some(sv), Some(bv)) = (score_val, bbox_val) {
                if let (Ok((_, scores)), Ok((_, boxes))) = (sv.try_extract_tensor::<f32>(), bv.try_extract_tensor::<f32>()) {
                    all_scores.extend_from_slice(&scores);
                    all_boxes.extend_from_slice(&boxes);
                    info!("SCRFD using single scale fallback (named): {} scores, {} boxes", scores.len(), boxes.len());
                }
            } else {
                // If named outputs fail, try to identify by shape
                // Scores: [N, 1] or [1, N, 1]
                // Boxes: [N, 4] or [1, N, 4]
                info!("SCRFD: Standard output names not found. Attempting to identify outputs by shape...");
                
                let mut score_key: Option<String> = None;
                let mut bbox_key: Option<String> = None;
                
                for (key, val) in outputs.iter() {
                    if let Ok((shape, _)) = val.try_extract_tensor::<f32>() {
                        let _dims = shape.len();
                        let last_dim = shape.last().copied().unwrap_or(0);
                        
                        info!("Output '{}': shape={:?}", key, shape);
                        
                        if last_dim == 1 {
                            score_key = Some(key.to_string());
                        } else if last_dim == 4 {
                            bbox_key = Some(key.to_string());
                        }
                    }
                }
                
                if let (Some(sk), Some(bk)) = (score_key, bbox_key) {
                    if let (Some(sv), Some(bv)) = (outputs.get(&sk), outputs.get(&bk)) {
                        if let (Ok((_, scores)), Ok((_, boxes))) = (sv.try_extract_tensor::<f32>(), bv.try_extract_tensor::<f32>()) {
                            all_scores.extend_from_slice(&scores);
                            all_boxes.extend_from_slice(&boxes);
                            info!("SCRFD using shape-based fallback: {} scores, {} boxes", scores.len(), boxes.len());
                        }
                    }
                }
            }
        }
        
        // Deep debug of raw scores
        if !all_scores.is_empty() {
            let max_score = all_scores.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
            let min_score = all_scores.iter().fold(f32::INFINITY, |a, &b| a.min(b));
            let avg_score = all_scores.iter().sum::<f32>() / all_scores.len() as f32;
            let count_over_01 = all_scores.iter().filter(|&&s| s > 0.1).count();
            let count_over_05 = all_scores.iter().filter(|&&s| s > 0.5).count();
            
            info!("SCRFD Raw Scores: count={}, min={:.4}, max={:.4}, avg={:.4}, >0.1={}, >0.5={}", 
                all_scores.len(), min_score, max_score, avg_score, count_over_01, count_over_05);
                
            // Print top 10 scores
            let mut sorted_scores = all_scores.clone();
            sorted_scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let top_10: Vec<f32> = sorted_scores.iter().take(10).copied().collect();
            info!("SCRFD Top 10 Scores: {:?}", top_10);
        } else {
            warn!("SCRFD: all_scores is empty after extraction attempts");
        }
        
        if !all_scores.is_empty() && !all_boxes.is_empty() {
            let n = all_scores.len().min(all_boxes.len() / 4);
            info!("SCRFD detected {} potential faces across all scales", n);
                
            // Get configurable confidence threshold (default 0.20)
            let base_confidence_threshold: f32 = std::env::var("NAZR_FACE_CONFIDENCE_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.20);
            
            let mut raw: Vec<FaceBbox> = Vec::with_capacity(n);
            
            // We need to decode the boxes based on the stride (scale) they came from
            // Since we flattened everything into all_scores/all_boxes, we need to reconstruct which stride each comes from
            // or better yet, process each stride separately before collecting.
            // But since I already flattened them, I'll assume the order is preserved: 8, then 16, then 32.
            // However, the previous loop `for scale in ["8", "16", "32"]` did exactly that.
            // But wait, the `all_boxes` contains just the raw values. I lost the grid context (x,y) needed for decoding!
            // I CANNOT use the flattened arrays as is because I need the (y,x) index to calculate cx, cy.
            
            // RE-IMPLEMENTATION: Process each scale separately and decode immediately
            raw.clear(); // Clear the vector we just allocated
            
            for stride_str in ["8", "16", "32"] {
                let stride: f32 = stride_str.parse().unwrap();
                // Try named outputs first, then shape-based fallback
                let score_tensor_opt = outputs.get(&format!("score_{}", stride_str))
                    .or_else(|| if stride == 8.0 { outputs.get("score") } else { None });
                let bbox_tensor_opt = outputs.get(&format!("bbox_{}", stride_str))
                    .or_else(|| if stride == 8.0 { outputs.get("bbox") } else { None });
                
                // If not found by name, we might need to use the shape-based ones found earlier
                // But for now let's assume the standard names or the shape-based fallback put them in all_scores
                // Actually, the previous code block for shape-based fallback put everything in all_scores/all_boxes
                // which makes it hard to separate.
                // Let's try to get the tensors again properly.
                
                let (scores, boxes, height, width) = if let (Some(sv), Some(bv)) = (score_tensor_opt, bbox_tensor_opt) {
                    if let (Ok((s_shape, s_data)), Ok((b_shape, b_data))) = (sv.try_extract_tensor::<f32>(), bv.try_extract_tensor::<f32>()) {
                        // Shape is typically [1, H*W, 1] or [H*W, 1] for scores
                        // and [1, H*W, 4] or [H*W, 4] for boxes
                        // We need H and W to generate the grid.
                        // Since we know the input is 640x640, H=W=640/stride
                        let h = (640.0 / stride) as usize;
                        let w = (640.0 / stride) as usize;
                        info!("SCRFD stride {}: score shape {:?} (len={}), bbox shape {:?} (len={}), expected grid {}x{}", 
                              stride, s_shape, s_data.len(), b_shape, b_data.len(), w, h);
                        (s_data, b_data, h, w)
                    } else {
                        continue;
                    }
                } else {
                    // If we are in the fallback case where we found tensors by shape but not name
                    // We need to rely on the fact that we probably only found one set of outputs (stride 8 usually)
                    // or we need to match them by size.
                    // For now, if we can't find specific stride outputs, we skip this stride.
                    // The fallback logic earlier populated all_scores, but that's useless for decoding.
                    continue; 
                };

                let num_grid_points = height * width;
                if scores.len() % num_grid_points != 0 {
                     warn!("SCRFD stride {}: score len {} not divisible by grid points {} ({}x{})", stride, scores.len(), num_grid_points, width, height);
                     continue;
                }
                let anchors_per_point = scores.len() / num_grid_points;
                info!("SCRFD stride {}: {} grid points, {} anchors per point", stride, num_grid_points, anchors_per_point);

                for i in 0..num_grid_points {
                    // Calculate grid position
                    let cy = (i / width) as f32 * stride;
                    let cx = (i % width) as f32 * stride;
                    
                    for a in 0..anchors_per_point {
                        // Assuming interleaved: (y,x,a0), (y,x,a1)...
                        let idx = i * anchors_per_point + a;
                        
                        let conf = scores[idx];
                        if conf < base_confidence_threshold { continue; }
                        
                        // Get bbox deltas (l, t, r, b) * stride
                        let b = idx * 4;
                        let l = boxes[b] * stride;
                        let t = boxes[b+1] * stride;
                        let r = boxes[b+2] * stride;
                        let bb = boxes[b+3] * stride;
                        
                        let x1_640 = cx - l;
                        let y1_640 = cy - t;
                        let x2_640 = cx + r;
                        let y2_640 = cy + bb;
                        
                        // Convert to original image space
                        let x1 = (x1_640 / scale).max(0.0).min(img_w);
                        let y1 = (y1_640 / scale).max(0.0).min(img_h);
                        let x2 = (x2_640 / scale).max(0.0).min(img_w);
                        let y2 = (y2_640 / scale).max(0.0).min(img_h);
                        
                        // Validate
                        if x2 <= x1 || y2 <= y1 { continue; }
                        let w_px = x2 - x1;
                        let h_px = y2 - y1;
                        if w_px < 8.0 || h_px < 8.0 { continue; }
                        
                        raw.push(FaceBbox { x1, y1, x2, y2, confidence: conf });
                    }
                }
            }
            
            // If raw is empty but all_scores was not, it means we failed to decode properly using strides
            // This could happen if the fallback logic was needed.
            // Let's try to handle the fallback case (single output found by shape)
            if raw.is_empty() && !all_scores.is_empty() {
                 // Assume stride 8 for fallback if we have ~6400 anchors (80x80)
                 // or calculate stride from number of anchors
                 let n_anchors = all_scores.len();
                 let side = (n_anchors as f32).sqrt() as usize;
                 let stride = 640.0 / side as f32;
                 
                 // Validate that all_boxes has enough elements (n_anchors * 4)
                 let expected_boxes_len = n_anchors * 4;
                 if all_boxes.len() < expected_boxes_len {
                     warn!(
                         "SCRFD fallback: all_boxes length {} < expected {} (n_anchors={}, side={}, stride={})",
                         all_boxes.len(), expected_boxes_len, n_anchors, side, stride
                     );
                     // Skip fallback if boxes array is too short
                 } else {
                     info!("SCRFD fallback decoding: {} anchors -> side {} -> stride {} (boxes_len={})", 
                           n_anchors, side, stride, all_boxes.len());
                     
                     for (i, conf) in all_scores.iter().enumerate().take(n_anchors) {
                         let conf = *conf;
                         if conf < base_confidence_threshold { continue; }
                         
                         let cy = (i / side) as f32 * stride;
                         let cx = (i % side) as f32 * stride;
                         
                         let b = i * 4;
                         // Bounds check already done above, but use get() for safety
                         if let (Some(&l), Some(&t), Some(&r), Some(&bb)) = (
                             all_boxes.get(b),
                             all_boxes.get(b + 1),
                             all_boxes.get(b + 2),
                             all_boxes.get(b + 3),
                         ) {
                             let l = l * stride;
                             let t = t * stride;
                             let r = r * stride;
                             let bb = bb * stride;
                             
                             let x1 = ((cx - l) / scale).max(0.0).min(img_w);
                             let y1 = ((cy - t) / scale).max(0.0).min(img_h);
                             let x2 = ((cx + r) / scale).max(0.0).min(img_w);
                             let y2 = ((cy + bb) / scale).max(0.0).min(img_h);
                             
                             if x2 > x1 && y2 > y1 && (x2-x1) >= 8.0 && (y2-y1) >= 8.0 {
                                 raw.push(FaceBbox { x1, y1, x2, y2, confidence: conf });
                             }
                         } else {
                             warn!("SCRFD fallback: bounds check failed for anchor {} (b={})", i, b);
                         }
                     }
                 }
            }

            info!("After confidence filter (threshold={:.3}): {} faces passed", base_confidence_threshold, raw.len());
            
            let nms_iou_threshold: f32 = std::env::var("NAZR_FACE_NMS_IOU_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.4);
            let keep = nms_wrapper(&raw, nms_iou_threshold);
            let mut out = Vec::with_capacity(keep.len());
            for idx in keep { out.push(raw[idx].clone()); }
            info!("After NMS: {} faces", out.len());
            return Ok(out);
        }
        warn!("SCRFD: No valid score/bbox outputs found");
        Ok(vec![])
    }

    pub fn recognize_face(&self, face_crop: &DynamicImage) -> Result<Vec<f32>> {
        let mut session_guard = self
            .arcface_session
            .as_ref()
            .context("Recognition model not loaded")?
            .lock();
        let (shape, data) = self.preprocess_arcface(face_crop)?;

        // Get input name directly from session metadata
        let input_name = session_guard.inputs[0].name.clone();
        info!("ArcFace input key detected: {}", input_name);

        let input = Value::from_array((shape.to_vec(), data))
            .context("Failed to create ArcFace input tensor")?;
        let outputs = session_guard
            .run(ort::inputs![input_name => input])
            .context("ArcFace inference failed")?;
        // Try to find the output tensor - check common names first, then try all keys
        let mut output_key: Option<&str> = None;
        for k in outputs.keys() {
            info!("ArcFace output key detected: {}", k);
            // Try common output names first
            if k == "output" || k == "embedding" || k == "fc1" || k == "features" {
                output_key = Some(k);
                break;
            }
        }
        
        // If no common name found, try the first key (often numeric like "683")
        if output_key.is_none() {
            if let Some(first_key) = outputs.keys().next() {
                warn!("Using first available output key '{}' for ArcFace (expected 'output' or 'embedding')", first_key);
                output_key = Some(first_key);
            }
        }
        
        if let Some(key) = output_key {
            if let Some(val) = outputs.get(key) {
                if let Ok((_, slice)) = val.try_extract_tensor::<f32>() {
                    let mut v = slice.to_vec();
                    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                    if norm > 0.0 {
                        for x in &mut v {
                            *x /= norm;
                        }
                        info!("ArcFace embedding extracted: dim={}, norm={:.6}", v.len(), norm);
                        return Ok(v);
                    } else {
                        warn!("ArcFace embedding has zero norm (all zeros)");
                    }
                } else {
                    warn!("Failed to extract tensor from ArcFace output key '{}'", key);
                }
            }
        } else {
            error!("No output keys found in ArcFace model output (available keys: {:?})", outputs.keys().collect::<Vec<_>>());
            // Return empty vector rather than erroring - this allows the pipeline to continue
            // even if face recognition fails for a single image
            warn!("ArcFace model produced no valid output, skipping face embedding extraction");
        }
        Ok(vec![])
    }

    pub fn process_image(&self, asset_id: i64, image_path: &Path) -> Result<Vec<FaceEmbedding>> {
        // Check if file extension is allowed for face detection
        let ext = image_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        
        // Default allowed extensions (if no exclusions set in database)
        let default_allowed = vec!["jpg", "jpeg", "png", "webp", "heic", "heif", "tiff", "tif"];
        
        // For now, use default allowed list. The SQL query in detect_faces handler
        // already filters by excluded extensions, so this is just a safety check.
        // TODO: Could cache excluded extensions from database for efficiency
        if !default_allowed.contains(&ext.as_str()) {
            info!("Skipping file with excluded extension for face detection: {:?} (ext: {})", image_path, ext);
            return Ok(vec![]);
        }
        
        let img = image::open(image_path).context(format!("Failed to open image: {:?}", image_path))?;
        let bboxes = self.detect_faces(&img)?;
        if bboxes.is_empty() {
            return Ok(vec![]);
        }
        let mut embeddings = Vec::new();
        for bbox in bboxes {
            let x1 = bbox.x1.max(0.0) as u32;
            let y1 = bbox.y1.max(0.0) as u32;
            let x2 = bbox.x2.min(img.width() as f32) as u32;
            let y2 = bbox.y2.min(img.height() as f32) as u32;
            if x2 > x1 && y2 > y1 {
                let face_crop = img.crop_imm(x1, y1, x2 - x1, y2 - y1);
                match self.recognize_face(&face_crop) {
                    Ok(embedding) => {
                        embeddings.push(FaceEmbedding {
                            embedding,
                            bbox: bbox.clone(),
                            asset_id,
                        });
                    }
                    Err(e) => warn!("Failed to generate embedding for face: {}", e),
                }
            }
        }
        Ok(embeddings)
    }
}

// HDBSCAN-style clustering wrapper
// --------------------------------
//
// We expose a single entrypoint, `cluster_faces_hdbscan`, that can later be
// backed by a real HDBSCAN implementation. For now, we keep a conservative
// DBSCAN-like fallback using the existing cosine_distance logic so behavior is
// predictable and easy to tune.

#[cfg(feature = "facial-recognition")]
pub fn cluster_faces_hdbscan(
    embeddings: &[FaceEmbedding],
    min_cluster_size: usize,
    min_samples: usize,
) -> Vec<Vec<usize>> {
    // Fallback: simple DBSCAN-style clustering using cosine distance.
    // This preserves current behavior while giving us a place to plug a
    // true HDBSCAN implementation without touching callers.

    if embeddings.is_empty() {
        return vec![];
    }

    // Interpret `min_cluster_size` as the minimum cluster size, and
    // `min_samples` as neighborhood density; for the fallback we just use
    // `min_samples` for both.
    // Epsilon (distance threshold): Lower = stricter (more fragmentation), Higher = looser (more merging)
    // Default 0.55 allows for some variation in lighting/pose while keeping different people separate.
    let epsilon: f32 = std::env::var("NAZR_FACE_CLUSTER_EPSILON")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.55);

    let mut visited = vec![false; embeddings.len()];
    let mut clusters = Vec::new();

    for i in 0..embeddings.len() {
        if visited[i] {
            continue;
        }
        visited[i] = true;
        let mut neighbors = find_neighbors_dbscan(embeddings, i, epsilon);
        if neighbors.len() < min_samples {
            continue;
        }

        let mut cluster = vec![i];
        let mut j = 0;
        while j < neighbors.len() {
            let neighbor_idx = neighbors[j];
            if !visited[neighbor_idx] {
                visited[neighbor_idx] = true;
                let neighbor_neighbors = find_neighbors_dbscan(embeddings, neighbor_idx, epsilon);
                if neighbor_neighbors.len() >= min_samples {
                    neighbors.extend(neighbor_neighbors);
                }
            }
            if !cluster.contains(&neighbor_idx) {
                cluster.push(neighbor_idx);
            }
            j += 1;
        }

        if cluster.len() >= min_cluster_size {
            clusters.push(cluster);
        }
    }

    clusters
}

#[cfg(feature = "facial-recognition")]
fn find_neighbors_dbscan(embeddings: &[FaceEmbedding], idx: usize, epsilon: f32) -> Vec<usize> {
    let embedding = &embeddings[idx].embedding;
    let mut neighbors = Vec::new();
    for (i, other) in embeddings.iter().enumerate() {
        if i == idx {
            continue;
        }
        let distance = cosine_distance(embedding, &other.embedding);
        if distance <= epsilon {
            neighbors.push(i);
        }
    }
    neighbors
}

#[cfg(feature = "facial-recognition")]
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 1.0;
    }
    let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 1.0;
    }
    1.0 - (dot_product / (norm_a * norm_b))
}

// NMS helpers
#[cfg(feature = "facial-recognition")]
fn nms_wrapper(boxes: &[FaceBbox], iou_threshold: f32) -> Vec<usize> {
    if boxes.is_empty() {
        return vec![];
    }
    let mut indices: Vec<usize> = (0..boxes.len()).collect();
    indices.sort_by(|&a, &b| {
        boxes[b]
            .confidence
            .partial_cmp(&boxes[a].confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep = Vec::new();
    let mut suppressed = vec![false; boxes.len()];
    for i in 0..indices.len() {
        let ia = indices[i];
        if suppressed[ia] {
            continue;
        }
        keep.push(ia);
        for &ib in indices.iter().skip(i + 1) {
            if suppressed[ib] {
                continue;
            }
            if calculate_iou(&boxes[ia], &boxes[ib]) > iou_threshold {
                suppressed[ib] = true;
            }
        }
    }
    keep
}

#[cfg(feature = "facial-recognition")]
fn calculate_iou(a: &FaceBbox, b: &FaceBbox) -> f32 {
    let x1 = a.x1.max(b.x1);
    let y1 = a.y1.max(b.y1);
    let x2 = a.x2.min(b.x2);
    let y2 = a.y2.min(b.y2);
    if x2 <= x1 || y2 <= y1 {
        return 0.0;
    }
    let intersection = (x2 - x1) * (y2 - y1);
    let area_a = (a.x2 - a.x1) * (a.y2 - a.y1);
    let area_b = (b.x2 - b.x1) * (b.y2 - b.y1);
    let union = area_a + area_b - intersection;
    if union <= 0.0 {
        return 0.0;
    }
    intersection / union
}

// Face embedding index
// --------------------
//
// We keep the public API surface small so we can swap the underlying
// implementation (brute-force vs FAISS) without touching the rest of the code.
//
// For now, we provide a brute-force implementation that can be replaced with a
// FAISS-backed index in a follow-up step. The API is intentionally similar to
// what a FAISS wrapper would expose (add + k‑NN search).

#[cfg(feature = "facial-recognition")]
pub struct FaceIndex {
    id_to_index: HashMap<i64, usize>,
    index_to_id: Vec<i64>,
    embeddings: Vec<Vec<f32>>,
}

#[cfg(feature = "facial-recognition")]
impl FaceIndex {
    pub fn new() -> Self {
        Self {
            id_to_index: HashMap::new(),
            index_to_id: Vec::new(),
            embeddings: Vec::new(),
        }
    }

    /// Add a new face embedding to the index.
    ///
    /// In a FAISS-backed implementation this would also insert into the FAISS
    /// index. Here we just append to an in-memory Vec for brute-force search.
    pub fn add_embedding(&mut self, face_id: i64, embedding: &[f32]) {
        let index_pos = self.index_to_id.len();
        self.id_to_index.insert(face_id, index_pos);
        self.index_to_id.push(face_id);
        self.embeddings.push(embedding.to_vec());
    }

    /// k‑NN search using cosine distance.
    ///
    /// This mirrors what a FAISS `IndexFlatIP` or `IndexFlatL2` would do for
    /// small datasets, but implemented in pure Rust for now. Once FAISS is
    /// wired in, this method can delegate to a FAISS index instead.
    pub fn find_similar(&self, embedding: &[f32], k: usize, threshold: f32) -> Vec<(i64, f32)> {
        let mut results: Vec<(i64, f32)> = self
            .embeddings
            .iter()
            .enumerate()
            .map(|(idx, emb)| {
                let dist = cosine_distance(embedding, emb);
                let face_id = self.index_to_id.get(idx).copied().unwrap_or(-1);
                (face_id, dist)
            })
            .filter(|(_, dist)| *dist <= threshold)
            .collect();

        results.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(k);
        results
    }

    pub fn clear(&mut self) {
        self.id_to_index.clear();
        self.index_to_id.clear();
        self.embeddings.clear();
    }
}

#[cfg(feature = "facial-recognition")]
pub async fn start_face_workers(
    n: usize,
    mut rx: mpsc::Receiver<FaceJob>,
    processor: Arc<parking_lot::Mutex<FaceProcessor>>,
    db_path: PathBuf,
    gauges: Arc<crate::pipeline::QueueGauges>,
    face_index: Arc<parking_lot::Mutex<FaceIndex>>,
) {
    // Distribute jobs to workers using round-robin
    let mut worker_txs = Vec::new();
    let mut worker_rxs = Vec::new();
    for _ in 0..n {
        let (wt, wr) = mpsc::channel::<FaceJob>(1000);
        worker_txs.push(wt);
        worker_rxs.push(wr);
    }
    
    // Distributor task
    let distributor = tokio::spawn(async move {
        let mut idx = 0;
        while let Some(job) = rx.recv().await {
            let target_idx = idx % worker_txs.len();
            if worker_txs[target_idx].send(job).await.is_err() {
                break;
            }
            idx += 1;
        }
        for wt in worker_txs {
            drop(wt);
        }
    });
    
    // Spawn worker tasks
    for mut worker_rx in worker_rxs.into_iter() {
        let processor_c = processor.clone();
        let db_path_c = db_path.clone();
        let gauges_c = gauges.clone();
        let face_index_c = face_index.clone();
        // Accumulate (face_id, embedding) pairs so we can map clusters back to DB rows
        let mut accumulated_with_ids: Vec<(i64, FaceEmbedding)> = Vec::new();

        tokio::spawn(async move {
            while let Some(job) = worker_rx.recv().await {
                gauges_c
                    .face
                    .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                let embeddings = {
                    let processor_clone = processor_c.clone();
                    let asset_id_clone = job.asset_id;
                    let image_path_clone = job.image_path.clone();
                    match tokio::task::spawn_blocking(move || {
                        let processor_guard = processor_clone.lock();
                        processor_guard.process_image(asset_id_clone, &image_path_clone)
                    })
                    .await
                    {
                        Ok(result) => result,
                        Err(e) => {
                            error!("Face processing task panicked for asset {}: {}", job.asset_id, e);
                            continue; // Skip this job and continue processing others
                        }
                    }
                };
                match embeddings {
                    Ok(embeddings) => {
                        if embeddings.is_empty() {
                            continue;
                        }
                        let dbp = db_path_c.clone();
                        let embeds = embeddings.clone();
                        let stored_ids = match tokio::task::spawn_blocking(move || {
                            let conn = rusqlite::Connection::open(dbp).ok()?;
                            let mut stored = Vec::new();
                            for embed in embeds {
                                let bbox_json = serde_json::to_string(&embed.bbox).ok()?;
                                match crate::db::writer::insert_face_embedding(
                                    &conn,
                                    embed.asset_id,
                                    None,
                                    &embed.embedding,
                                    &bbox_json,
                                    embed.bbox.confidence as f64,
                                ) {
                                    Ok(face_id) => stored.push((face_id, embed)),
                                    Err(e) => {
                                        error!("Failed to store face embedding for asset {}: {}", embed.asset_id, e);
                                    },
                                }
                            }
                            Some(stored)
                        })
                        .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                error!("Face embedding storage task panicked for asset {}: {}", job.asset_id, e);
                                None
                            }
                        };
                        if let Some(stored) = stored_ids {
                            // Update in-memory search index
                            {
                                let mut index = face_index_c.lock();
                                for (face_id, embed) in &stored {
                                    index.add_embedding(*face_id, &embed.embedding);
                                }
                            }

                            // Accumulate for clustering with face IDs
                            for (fid, embed) in stored {
                                accumulated_with_ids.push((fid, embed));
                            }

                            info!("Processed {} faces in asset {}", embeddings.len(), job.asset_id);

                            // When enough accumulated, run clustering and persist persons
                            if accumulated_with_ids.len() >= get_cluster_batch_size() {
                                let items = accumulated_with_ids.drain(..).collect::<Vec<_>>();
                                let dbp = db_path_c.clone();
                                let item_count = items.len();
                                info!("Starting clustering for {} accumulated faces", item_count);
                                tokio::spawn(async move {
                                    // Prepare embeddings slice for clustering
                                    let embeds_only: Vec<FaceEmbedding> = items.iter().map(|(_, e)| e.clone()).collect();
                                    // Use configurable clustering parameters (HDBSCAN-style)
                                    let min_cluster_size: usize = std::env::var("NAZR_FACE_HDBSCAN_MIN_CLUSTER_SIZE")
                                        .ok()
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(3);
                                    let min_samples: usize = std::env::var("NAZR_FACE_HDBSCAN_MIN_SAMPLES")
                                        .ok()
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(2);
                                    // Diagnostic: sample some distances to understand the embedding space
                                    if !embeds_only.is_empty() && embeds_only.len() > 1 {
                                        let sample_size = embeds_only.len().min(10);
                                        let mut distances = Vec::new();
                                        for i in 0..sample_size {
                                            for j in (i+1)..sample_size.min(embeds_only.len()) {
                                                let dist = cosine_distance(
                                                    &embeds_only[i].embedding,
                                                    &embeds_only[j].embedding
                                                );
                                                distances.push(dist);
                                            }
                                        }
                                        if !distances.is_empty() {
                                            distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                                            let min_dist = distances[0];
                                            let max_dist = distances[distances.len() - 1];
                                            let median_dist = distances[distances.len() / 2];
                                            info!("Sample face distances: min={:.3}, median={:.3}, max={:.3} (min_cluster_size={}, min_samples={})", 
                                                min_dist, median_dist, max_dist, min_cluster_size, min_samples);
                                        }
                                    }
                                    
                                    let clusters = cluster_faces_hdbscan(&embeds_only, min_cluster_size, min_samples);
                                    info!("Clustering produced {} clusters from {} faces", clusters.len(), embeds_only.len());

                                    // Persist: create a person per cluster and assign faces
                                    let result = tokio::task::spawn_blocking(move || {
                                        let conn = rusqlite::Connection::open(dbp).ok()?;
                                        let mut persons_created = 0;
                                        let mut faces_assigned = 0;
                                        for cluster in clusters {
                                            if cluster.is_empty() { continue; }
                                            let person_id = match crate::db::writer::insert_person(&conn, None) {
                                                Ok(pid) => {
                                                    persons_created += 1;
                                                    pid
                                                },
                                                Err(e) => {
                                                    error!("Failed to create person for asset {}: {}", job.asset_id, e);
                                                    continue;
                                                },
                                            };
                                            for idx in cluster {
                                                if let Some((face_id, _)) = items.get(idx) {
                                                    match crate::db::writer::update_face_person(&conn, *face_id, Some(person_id)) {
                                                        Ok(true) => faces_assigned += 1,
                                                        Ok(false) => warn!("Failed to assign face {} to person {}", face_id, person_id),
                                                        Err(e) => error!("Error assigning face {} to person {}: {}", face_id, person_id, e),
                                                    }
                                                }
                                            }
                                        }
                                        info!("Clustering complete: {} persons created, {} faces assigned", persons_created, faces_assigned);
                                        Some((persons_created, faces_assigned))
                                    }).await;
                                    
                                    match result {
                                        Ok(Some((persons, faces))) => {
                                            info!("Clustering persisted: {} persons, {} faces", persons, faces);
                                        }
                                        Ok(None) => {
                                            error!("Clustering task returned no result for asset {} (database connection failed)", job.asset_id);
                                        }
                                        Err(e) => {
                                            error!("Clustering task panicked for asset {}: {}", job.asset_id, e);
                                        }
                                    }
                                });
                            }
                        }
                    }
                    Err(e) => {
                        error!("Failed to process faces for asset {}: {}", job.asset_id, e);
                        // Continue processing other jobs - don't crash the worker
                        // The error is logged for visibility in CI logs
                    },
                }
            }
        });
    }
    
    // Keep distributor alive
    tokio::spawn(async move {
        let _ = distributor.await;
    });
}

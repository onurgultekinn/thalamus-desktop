// Thalamus yerel HTTP backend (axum).
//
// Frontend, sıkıştırma ve sağlık kontrolü için bu sunucuya konuşur. Sunucu hem
// masaüstünde (Tauri sürecinde ayrı thread) hem de tarayıcı önizlemesinde
// (`cargo run -- --serve-only`) çalışır. Yalnızca 127.0.0.1'e bağlanır ve
// localhost CORS'una izin verir — dış ağa açık değildir.
//
// Sıkıştırma algoritması şimdilik mevcut tested motor (`engine`), ileride
// buraki `process_with_metrics` çağrısı yeni algoritmayla değiştirilebilir.

use crate::engine::{process_with_metrics, CompressionMetrics};
use axum::{
    extract::State,
    http::{HeaderValue, Method},
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tiktoken_rs::CoreBPE;
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

pub mod ai;
pub mod repo;
pub mod tools;

const DEFAULT_PORT: u16 = 8277;

#[derive(Clone)]
pub struct BackendState {
    pub bpe: Arc<CoreBPE>,
    /// Workspace kökü (repo map diskten buradan okur).
    pub workspace_root: Arc<RwLock<String>>,
    /// Dosya içerik cache'i (mtime'a göre) — değişmeyen dosyalar yeniden okunmaz.
    pub repo_cache: Arc<Mutex<HashMap<String, (SystemTime, String)>>>,
}

#[derive(serde::Deserialize)]
pub struct CompressRequest {
    pub prompt: String,
    #[serde(default)]
    pub veto_override: bool,
}

async fn health(State(_state): State<BackendState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "engine": "ready",
        "info": "Yerel Sıkıştırma Motoru Aktif"
    }))
}

async fn compress(
    State(state): State<BackendState>,
    Json(req): Json<CompressRequest>,
) -> Result<Json<CompressionMetrics>, (axum::http::StatusCode, String)> {
    if req.prompt.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "Prompt metni boş olamaz.".to_string(),
        ));
    }
    let metrics = process_with_metrics(&req.prompt, &state.bpe, req.veto_override);
    Ok(Json(metrics))
}

fn router(state: BackendState) -> Router {
    // Sunucu API anahtarlarını istek gövdesinde taşıdığı için CORS'u tamamen
    // açık bırakmak, kullanıcının tarayıcısındaki herhangi bir siteye bu
    // anahtarları çağırma imkanı verir. Yalnızca uygulamanın kendisine
    // (Vite dev sunucusu + Tauri webview origin'leri) izin veriyoruz.
    let allowed_origins = AllowOrigin::list(
        [
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "tauri://localhost",
            "http://tauri.localhost",
        ]
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok()),
    );
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(AllowHeaders::any());

    Router::new()
        .route("/api/health", get(health))
        .route("/api/compress", post(compress))
        .route("/api/ai/chat", post(ai::ai_chat))
        .route("/api/repo/map", post(repo::repo_map))
        .with_state(state)
        .layer(cors)
}

/// Backend başlatma sonucu: `None` = henüz bilinmiyor, `Some(Ok(()))` =
/// dinleyici ayakta, `Some(Err(...))` = bağlanma/serve hatası.
pub type BackendStatus = Arc<Mutex<Option<Result<(), String>>>>;

/// HTTP sunucusunu ayrı bir thread'de başlatır (engellemez). Başlatma
/// sonucunu döndürülen `BackendStatus` üzerinden bildirir; detached thread
/// içinde panic atmak yerine hatayı raporlar.
pub fn serve(bpe: Arc<CoreBPE>, workspace_root: Arc<RwLock<String>>) -> BackendStatus {
    let port = std::env::var("THALAMUS_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let app = router(BackendState {
        bpe: bpe.clone(),
        workspace_root: workspace_root.clone(),
        repo_cache: Arc::new(std::sync::Mutex::new(HashMap::new())),
    });

    let status: BackendStatus = Arc::new(Mutex::new(None));
    let status_clone = status.clone();

    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", port);
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("tokio runtime oluşturulamadı: {}", e))
            .and_then(|rt| {
                rt.block_on(async move {
                    let listener = tokio::net::TcpListener::bind(&addr)
                        .await
                        .map_err(|e| format!("backend {} bağlanamadı: {}", addr, e))?;
                    log::info!("Thalamus HTTP backend {} üzerinde", addr);
                    axum::serve(listener, app)
                        .await
                        .map_err(|e| format!("backend sunucu hatası: {}", e))
                })
            });

        match &result {
            Ok(()) => {}
            Err(e) => log::error!("{}", e),
        }
        *status_clone.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
    });

    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header::ACCESS_CONTROL_ALLOW_ORIGIN};
    use tower::ServiceExt;

    fn test_state() -> BackendState {
        BackendState {
            bpe: Arc::new(tiktoken_rs::cl100k_base().unwrap()),
            workspace_root: Arc::new(RwLock::new(
                std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            )),
            repo_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn preflight(app: Router, origin: &str) -> axum::http::Response<Body> {
        app.oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/compress")
                .header("Origin", origin)
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[test]
    fn cors_allows_app_origins_and_rejects_foreign() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // İzinli origin: preflight başarılı ve allow-origin başlığı var.
            let res = preflight(router(test_state()), "http://localhost:1420").await;
            assert_eq!(res.status(), 200);
            assert_eq!(
                res.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
                "http://localhost:1420"
            );

            // Tauri webview origin'i de izinli.
            let res = preflight(router(test_state()), "http://tauri.localhost").await;
            assert!(res.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).is_some());

            // Yabancı origin: allow-origin başlığı YOK — tarayıcı isteği engeller.
            let res = preflight(router(test_state()), "https://evil.example.com").await;
            assert!(res.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        });
    }

    #[test]
    fn compress_rejects_blank_prompt() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let app = router(test_state());
            let res = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/compress")
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"prompt":"   "}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), 400);
        });
    }
}

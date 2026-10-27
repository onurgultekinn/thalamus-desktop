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
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tiktoken_rs::CoreBPE;
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

pub mod agent;
pub mod arastir;
pub mod ai;
pub mod engines;
pub mod local_models;
pub mod model_caps;
pub mod repo;
pub mod serve;
pub mod tools;

const DEFAULT_PORT: u16 = 8277;

#[derive(Clone)]
pub struct BackendState {
    pub bpe: Arc<CoreBPE>,
    /// Workspace kökü (repo map diskten buradan okur).
    pub workspace_root: Arc<RwLock<String>>,
    /// Dosya içerik cache'i (mtime'a göre) — değişmeyen dosyalar yeniden okunmaz.
    pub repo_cache: Arc<Mutex<HashMap<String, (SystemTime, String)>>>,
    /// Şema cache'i: (dosya, mtime) → tanım adı → satır aralığı. get_code_body
    /// her çağrıda tüm repoyu yeniden taramasın.
    pub schema_cache: Arc<
        Mutex<HashMap<String, (SystemTime, HashMap<String, (usize, usize)>)>>,
    >,
    /// Ajan Ağı koşuları — sunucu-otoriteli durum (arayüz yoklar).
    pub agent_runs: crate::agent::SharedRuns,
}

#[derive(serde::Deserialize)]
pub struct CompressRequest {
    pub prompt: String,
    #[serde(default)]
    pub veto_override: bool,
}

/// G2: DNS-rebinding koruması. Kötü niyetli bir site kendi alan adını
/// 127.0.0.1'e çözümlersen, tarayıcıdan bu backend'e `Host: evil.com` ile
/// istek atabilir; CORS alone yanıtı okumayı engellese de POST'lar (araç
/// döngüsü üzerinden dosya yazma gibi) yanıt okumadan yan etki üretir.
/// Yalnızca gerçek loopback Host başlıklarını kabul ediyoruz; sunucu zaten
/// sadece 127.0.0.1'e bind olduğu için meşru istemciler bundan etkilenmez.
fn host_allowed(host_header: Option<&str>) -> bool {
    let Some(h) = host_header else { return false };
    let h = h.trim().to_ascii_lowercase();
    // Host başlığında userinfo bulunamaz; bulunrsa anormal istek — reddet.
    if h.contains('@') {
        return false;
    }
    let authority = &h[..];
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

async fn host_guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    if !host_allowed(host) {
        return (
            StatusCode::FORBIDDEN,
            "Reddedildi: beklenmeyen Host başlığı (DNS-rebinding koruması).",
        )
            .into_response();
    }
    next.run(req).await
}

async fn health(State(_state): State<BackendState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "engine": "ready",
        "info": "Local Compression Engine Active"
    }))
}

async fn compress(
    State(state): State<BackendState>,
    Json(req): Json<CompressRequest>,
) -> Result<Json<CompressionMetrics>, (axum::http::StatusCode, String)> {
    if req.prompt.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "Prompt text cannot be empty.".to_string(),
        ));
    }
    let metrics = process_with_metrics(&req.prompt, &state.bpe, req.veto_override);
    Ok(Json(metrics))
}


/// Yerel API oturum tokeni: uygulama basina rastgele uretilir. Yerel sunucu
/// 127.0.0.1'ye bagli olsa bile AYNI makinedeki herhangi bir surec port'u
/// bulup kullanicinin (kasadaki) anahtarlariyla istek atabilir — token
/// zorunlulugu bu yolu kapatir: token yalniz uygulamanin kendi webview'ina
/// Tauri komutuyla verilir.
///
/// Kaynak isletim sisteminin CSPRNG'sidir (`getrandom`): 32 bayt, 64 karakter
/// hex. Uretim basarisiz olursa `None` saklanir ve `session_token()` bos
/// string doner; `auth_mw` bos token'i hicbir istekle eslestirmez (fail-closed).
static SESSION_TOKEN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

fn generate_session_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write as _;
        // String'e yazmak paniklemez; `let _` yalnizca imzayi susturur.
        let _ = write!(out, "{:02x}", b);
    }
    Some(out)
}

pub fn session_token() -> &'static str {
    SESSION_TOKEN
        .get_or_init(generate_session_token)
        .as_deref()
        .unwrap_or("")
}

/// Middleware: x-thalamus-token dogru degilse 401. /api/health muaf.
async fn auth_mw(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::StatusCode;
    let path = req.uri().path();
    if path == "/api/health" {
        return next.run(req).await;
    }
    let expected = session_token();
    // Fail-closed: token uretilemediyse (bos) hicbir istek kimlik dogrulamis
    // sayilmaz — bos basligi eslestirip korumayi acmak yerine hepsi 401.
    let ok = !expected.is_empty()
        && req
            .headers()
            .get("x-thalamus-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == expected)
            .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "local api token missing or invalid").into_response();
    }
    next.run(req).await
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
        .route("/api/ai/chat/stream", post(ai::ai_chat_stream))
        .route("/api/ai/test", post(ai::ai_test))
        .route("/api/ai/models", post(local_models::local_models))
        .route(
            "/api/ai/serve",
            post(serve::serve_model).get(serve::list_serving),
        )
        .route("/api/ai/serve/stop", post(serve::stop_model))
        .route("/api/ai/serve/unload", post(serve::unload_model))
        .route("/api/repo/map", post(repo::repo_map))
        .route("/api/agent/run", post(agent::agent_run))
        .route("/api/agent/state", get(agent::agent_state))
        .route("/api/agent/cancel", post(agent::agent_cancel))
        .with_state(state)
        // Tum rotalar eklendikten SONRA sarmalanir (axum: layer yalniz o
        // ana kadar eklenen rotalari sarar — basta cagrilmissa hicbirini sarmaz).
        .layer(axum::middleware::from_fn(auth_mw))
        .layer(cors)
        // En dış katman: CORS preflight'ı bile Host denetiminden geçer.
        .layer(middleware::from_fn(host_guard))
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
        schema_cache: Arc::new(std::sync::Mutex::new(HashMap::new())),
        agent_runs: Arc::new(Mutex::new(HashMap::new())),
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
                    // Boşta kalan yerel modelleri arka planda kapat: model
                    // yalnızca çağrıldığında çalışsın, açık kalmasın.
                    drop(tokio::spawn(crate::backend::serve::idle_monitor()));
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
    use axum::http::{header::ACCESS_CONTROL_ALLOW_ORIGIN, Request};
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
            schema_cache: Arc::new(Mutex::new(HashMap::new())),
            agent_runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn preflight(app: Router, origin: &str) -> axum::http::Response<Body> {
        app.oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/compress")
                .header("host", "127.0.0.1:8277")
                        .header("x-thalamus-token", session_token())
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
    fn session_token_is_64_hex_chars_and_stable() {
        let t = session_token();
        assert!(!t.is_empty(), "token uretilmeli");
        assert_eq!(t.len(), 64, "32 bayt = 64 hex karakter: {}", t);
        assert!(
            t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "yalnizca kucuk harf hex olmali: {}",
            t
        );
        // OnceLock: ayni surecte her cagri ayni degeri dondurur.
        assert_eq!(t, session_token());
        // Iki bagimsiz uretim ayni olmamali (entropi duman testi).
        let other = generate_session_token().expect("csprng");
        assert_ne!(other, t);
        assert_eq!(other.len(), 64);
    }

    #[test]
    fn requests_without_or_with_wrong_token_are_unauthorized() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            for token in [None, Some("wrong-token")] {
                let mut req = Request::builder()
                    .method("POST")
                    .uri("/api/compress")
                    .header("host", "127.0.0.1:8277")
                    .header("Content-Type", "application/json");
                if let Some(t) = token {
                    req = req.header("x-thalamus-token", t);
                }
                let res = router(test_state())
                    .oneshot(req.body(Body::from(r#"{"prompt":"merhaba"}"#)).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    res.status(),
                    axum::http::StatusCode::UNAUTHORIZED,
                    "token={:?}",
                    token
                );
            }
        });
    }

    #[test]
    fn health_is_exempt_from_token() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let res = router(test_state())
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/api/health")
                        .header("host", "127.0.0.1:8277")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), axum::http::StatusCode::OK);
        });
    }

    #[test]
    fn requests_without_origin_header_are_served() {
        // CORS yalnizca tarayici baglaminda devreye girer; Origin basligi
        // olmayan (Tauri IPC / curl benzeri) istekler token ile gecebilmeli.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let res = router(test_state())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/compress")
                        .header("host", "127.0.0.1:8277")
                        .header("x-thalamus-token", session_token())
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"prompt":"merhaba"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), axum::http::StatusCode::OK);
        });
    }

    #[test]
    fn localhost_lookalike_host_is_rejected() {
        // "localhost.evil.com" bir alt alan adidir; loopback degildir.
        assert!(!host_allowed(Some("localhost.evil.com")));
        assert!(!host_allowed(Some("localhost.evil.com:8277")));
        assert!(!host_allowed(Some("127.0.0.1.nip.io:8277")));
        assert!(!host_allowed(Some("notlocalhost")));
    }

    #[test]
    fn host_allowed_matches_only_loopback() {
        assert!(host_allowed(Some("127.0.0.1:8277")));
        assert!(host_allowed(Some("localhost:8277")));
        assert!(host_allowed(Some("LOCALHOST")));
        assert!(host_allowed(Some("[::1]:8277")));
        // DNS-rebinding ve dış Host denemeleri reddedilmeli.
        assert!(!host_allowed(Some("evil.example.com")));
        assert!(!host_allowed(Some("evil.example.com:8277")));
        assert!(!host_allowed(Some("127.0.0.1.evil.com")));
        assert!(!host_allowed(Some("attacker@127.0.0.1:8277")));
        assert!(!host_allowed(None));
    }

    #[test]
    fn rebinding_host_is_rejected_before_routes() {
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
                        .header("host", "evil.example.com")
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"prompt":"merhaba"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), axum::http::StatusCode::FORBIDDEN);
        });
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
    fn ai_test_rejects_non_http_url() {
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
                        .uri("/api/ai/test")
                        .header("host", "127.0.0.1:8277")
                        .header("x-thalamus-token", session_token())
                        .header("Content-Type", "application/json")
                        .body(Body::from(
                            r#"{"base_url":"file:///etc/passwd","api_key":""}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), axum::http::StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn ai_test_requires_key_for_cloud_endpoint() {
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
                        .uri("/api/ai/test")
                        .header("host", "127.0.0.1:8277")
                        .header("x-thalamus-token", session_token())
                        .header("Content-Type", "application/json")
                        .body(Body::from(
                            r#"{"base_url":"https://api.openai.com/v1","api_key":""}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), axum::http::StatusCode::BAD_REQUEST);
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
                        .header("host", "127.0.0.1:8277")
                        .header("x-thalamus-token", session_token())
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

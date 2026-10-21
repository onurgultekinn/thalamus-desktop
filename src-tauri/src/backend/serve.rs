// Yerel modelleri "tek tıkla" çalıştırma.
//
// Keşif (`local_models.rs`) yalnızca NE olduğunu söyler; bu modül onu
// KULLANILABİLİR hale getirir: uygun motoru bulur, boş bir portta başlatır,
// OpenAI uyumlu uç yanıt verene kadar bekler ve süreci kaydeder. Böylece
// arayüz gelen taban URL'yi sağlayıcı olarak yazıp prompt atabilir.
//
//   * `ollama`  → `ollama serve` (gerekirse) + mevcut model adı
//   * `gguf`    → `llama-server.exe -m <dosya> …` (Ollama ile gelen ikili dahil)
//   * `hf`      → `python model_server.py --model <klasör>` (transformers şimi)
//
// Başlatılan süreçler uygulama kapanışında öldürülür (`shutdown_all`).

use crate::backend::engines;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Hazır olma yoklaması için üst sınırlar (model yükleme dahil).
const READY_TIMEOUT_GGUF: Duration = Duration::from_secs(240);
const READY_TIMEOUT_HF: Duration = Duration::from_secs(420);
const READY_TIMEOUT_OLLAMA: Duration = Duration::from_secs(40);

/// Çalışan (bu modülün başlattığı) sunucu.
struct Server {
    id: String,
    kind: &'static str,
    label: String,
    model: String,
    base_url: String,
    port: u16,
    pid: u32,
    /// Biz başlattıysak süreç; yalnızca Ollama servisi için `None` olabilir.
    child: Option<Child>,
    started_unix: u64,
    log: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<String, Server>> {
    static REG: OnceLock<Mutex<HashMap<String, Server>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn temp_log_path(id: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("thalamus_models");
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let safe = if safe.len() > 60 { safe[..60].to_string() } else { safe };
    dir.join(format!("{}.log", safe))
}

/// Log dosyasının son ~2 KB'ı (hata mesajında gösterilir).
fn tail_log(path: &PathBuf) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let t = text.trim();
    if t.len() <= 2000 {
        t.to_string()
    } else {
        t[t.len() - 2000..].to_string()
    }
}

#[derive(serde::Deserialize)]
pub struct ServeRequest {
    /// Keşifteki kimlik: `ollama:ad:etiket`, `gguf:<yol>`, `hf:org/ad`.
    pub id: String,
    /// Keşifte bulunan gerçek yol (varsa kimlikten çözmeye tercih edilir).
    #[serde(default)]
    pub path: Option<String>,
    /// İsteğe bağlı öznitelikler (Faz 3: verimlilik ayarları buradan gelecek).
    #[serde(default)]
    pub ctx: Option<u32>,
    #[serde(default)]
    pub ngl: Option<u32>,
    #[serde(default)]
    pub threads: Option<u32>,
}

/// `hf:org/ad` → HF önbelleğindeki en büyük snapshot klasörü.
fn resolve_hf_snapshot(repo: &str) -> Option<PathBuf> {
    let hub = dirs::home_dir()?
        .join(".cache")
        .join("huggingface")
        .join("hub");
    let dir_name = format!("models--{}", repo.replace('/', "--"));
    let snapshots = hub.join(dir_name).join("snapshots");
    let mut best: Option<(PathBuf, u64)> = None;
    for rev in std::fs::read_dir(&snapshots).ok()?.flatten() {
        let path = rev.path();
        let bytes: u64 = std::fs::read_dir(&path)
            .ok()
            .map(|files| {
                files
                    .flatten()
                    .filter(|f| {
                        f.path()
                            .extension()
                            .is_some_and(|e| e.eq_ignore_ascii_case("safetensors"))
                    })
                    .filter_map(|f| std::fs::metadata(f.path()).ok().map(|m| m.len()))
                    .sum()
            })
            .unwrap_or(0);
        if bytes > 0 && best.as_ref().map(|(_, b)| bytes > *b).unwrap_or(true) {
            best = Some((path, bytes));
        }
    }
    best.map(|(p, _)| p)
}

/// Bir HTTP ucu `/v1/models` yanıtı verene kadar bekler.
async fn wait_ready(
    client: &reqwest::Client,
    base: &str,
    timeout: Duration,
    mut child: Option<&mut Child>,
    log: &PathBuf,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let url = format!("{}/models", base);
    loop {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        if let Some(c) = child.as_deref_mut() {
            // Süreç ölmüşse boşuna beklemeyelim — gerçek hatayı logdan göster.
            if let Ok(Some(status)) = c.try_wait() {
                let tail = tail_log(log);
                return Err(format!(
                    "Motor erken kapandı ({}).{}\n{}",
                    status,
                    if tail.is_empty() { "" } else { " Son log:" },
                    tail
                ));
            }
        }
        if Instant::now() >= deadline {
            let tail = tail_log(log);
            return Err(format!(
                "Motor {} sn içinde hazır olmadı.{}",
                timeout.as_secs(),
                if tail.is_empty() { String::new() } else { format!(" Son log: {}", tail) }
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Boş bir TCP portu alır (OS atar, yarış yok).
fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("boş port bulunamadı: {}", e))?;
    let p = l.local_addr().map_err(|e| e.to_string())?.port();
    drop(l);
    Ok(p)
}

fn spawn_logged(exe: &PathBuf, args: &[String], env: &[(String, String)], log: &PathBuf) -> Result<Child, String> {
    let out = std::fs::File::create(log).map_err(|e| format!("log dosyası: {}", e))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(engines::CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("{} başlatılamadı: {}", exe.display(), e))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn server_json(s: &Server) -> Value {
    json!({
        "id": s.id,
        "kind": s.kind,
        "label": s.label,
        "model": s.model,
        "base_url": s.base_url,
        "port": s.port,
        "pid": s.pid,
        "started": s.started_unix,
        "log": s.log.to_string_lossy(),
    })
}

/// POST /api/ai/serve — keşfedilen bir modeli çalıştırır ve taban URL'sini döndürür.
pub async fn serve_model(
    Json(req): Json<ServeRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Model kimliği boş.".into()));
    }

    // Zaten çalışıyorsa tekrar başlatma.
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = reg.get(&id) {
            let alive = s
                .child
                .as_ref()
                .map(|c| c.id())
                .map(|_| true)
                .unwrap_or(true);
            if alive {
                return Ok(Json(server_json(s)));
            }
            reg.remove(&id);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let engine_list = engines::detect();
    let llama = engine_list
        .iter()
        .find(|e| e.id == "llamaserver")
        .and_then(|e| e.path.clone());
    let ollama_exe = engine_list
        .iter()
        .find(|e| e.id == "ollama")
        .and_then(|e| e.path.clone());
    let python = engine_list
        .iter()
        .find(|e| e.id == "python")
        .filter(|e| e.ready)
        .and_then(|e| e.path.clone());

    let err = |code: StatusCode, msg: String| (code, msg);

    // ── kimliği çöz ─────────────────────────────────────────────────────
    let (kind, target, model_name) = if let Some(rest) = id.strip_prefix("ollama:") {
        ("ollama", rest.to_string(), rest.to_string())
    } else if let Some(path) = id.strip_prefix("gguf:") {
        let path = req.path.clone().unwrap_or_else(|| path.to_string());
        let stem = std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "local-model".to_string());
        ("gguf", path, stem)
    } else if let Some(repo) = id.strip_prefix("hf:") {
        // Gerçek snapshot klasörü: istekteki yol → HF önbelleği → ham depo adı.
        let target: PathBuf = req
            .path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(|| resolve_hf_snapshot(repo))
            .unwrap_or_else(|| PathBuf::from(repo));
        ("hf", target.to_string_lossy().to_string(), repo.to_string())
    } else {
        return Err(err(StatusCode::BAD_REQUEST, format!("Anlaşılamayan kimlik: {}", id)));
    };

    let log = temp_log_path(&id);

    match kind {
        // ── Ollama: servis ayakta mı, model indirilmiş mi? ──────────────
        "ollama" => {
            let base = "http://127.0.0.1:11434/v1".to_string();
            let ok = client
                .get(format!("{}/models", base))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if !ok {
                let exe = ollama_exe.ok_or_else(|| {
                    err(StatusCode::BAD_REQUEST, "Ollama kurulu değil.".into())
                })?;
                let mut child = spawn_logged(&exe, &["serve".to_string()], &[], &log)
                    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
                wait_ready(&client, &base, READY_TIMEOUT_OLLAMA, Some(&mut child), &log)
                    .await
                    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
                let pid = child.id();
                let server = Server {
                    id: id.clone(),
                    kind: "ollama-service",
                    label: "Ollama (servis)".into(),
                    model: model_name.clone(),
                    base_url: base.clone(),
                    port: 11434,
                    pid,
                    child: Some(child),
                    started_unix: now_unix(),
                    log: log.clone(),
                };
                let v = server_json(&server);
                registry()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone(), server);
                return Ok(Json(json!({ "server": v, "base_url": base, "model": model_name })));
            }
            // Servis zaten çalışıyor: onu sahiplenmiyoruz (durdurmayalım).
            let server = Server {
                id: id.clone(),
                kind: "ollama",
                label: "Ollama".into(),
                model: model_name.clone(),
                base_url: base.clone(),
                port: 11434,
                pid: 0,
                child: None,
                started_unix: now_unix(),
                log: log.clone(),
            };
            let v = server_json(&server);
            registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), server);
            Ok(Json(json!({ "server": v, "base_url": base, "model": model_name })))
        }

        // ── GGUF: llama.cpp ────────────────────────────────────────────
        "gguf" => {
            let exe = llama.ok_or_else(|| {
                err(
                    StatusCode::BAD_REQUEST,
                    "llama.cpp (llama-server.exe) bulunamadı — .gguf dosyaları çalıştırılamaz.".into(),
                )
            })?;
            if !std::path::Path::new(&target).is_file() {
                return Err(err(StatusCode::BAD_REQUEST, format!("Dosya yok: {}", target)));
            }
            let port = free_port().map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let ctx = req.ctx.unwrap_or(8192);
            let ngl = req.ngl.unwrap_or(999);
            let threads = req
                .threads
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4));
            let args: Vec<String> = vec![
                "-m".into(), target.clone(),
                "--host".into(), "127.0.0.1".into(),
                "--port".into(), port.to_string(),
                "-c".into(), ctx.to_string(),
                "-ngl".into(), ngl.to_string(),
                "-t".into(), threads.to_string(),
                "--alias".into(), model_name.clone(),
                "--jinja".into(),
            ];
            // GPU arka ucunu (Ollama'nın getirdiği CUDA/Vulkan klasörleri) bul.
            let gpu_env = engines::gpu_backend_env(&exe);
            let mut child = spawn_logged(&exe, &args, &gpu_env, &log)
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let base = format!("http://127.0.0.1:{}/v1", port);
            wait_ready(&client, &base, READY_TIMEOUT_GGUF, Some(&mut child), &log)
                .await
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let pid = child.id();
            let server = Server {
                id: id.clone(),
                kind: "gguf",
                label: format!("llama.cpp · {}", model_name),
                model: model_name.clone(),
                base_url: base.clone(),
                port,
                pid,
                child: Some(child),
                started_unix: now_unix(),
                log: log.clone(),
            };
            let v = server_json(&server);
            registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), server);
            Ok(Json(json!({ "server": v, "base_url": base, "model": model_name })))
        }

        // ── safetensors klasörü: Python/transformers şimi ───────────────
        "hf" => {
            let exe = python.ok_or_else(|| {
                err(
                    StatusCode::BAD_REQUEST,
                    "Python ortamı eksik (transformers + torch + fastapi gerekli).".into(),
                )
            })?;
            if !std::path::Path::new(&target).is_dir() {
                return Err(err(StatusCode::BAD_REQUEST, format!("Klasör yok: {}", target)));
            }
            let script = write_hf_server_script()?;
            let port = free_port().map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let args: Vec<String> = vec![
                "-u".into(),
                script.to_string_lossy().to_string(),
                "--model".into(), target.clone(),
                "--name".into(), model_name.clone(),
                "--host".into(), "127.0.0.1".into(),
                "--port".into(), port.to_string(),
            ];
            let mut child = spawn_logged(
                &exe,
                &args,
                &[("PYTHONUNBUFFERED".to_string(), "1".to_string())],
                &log,
            )
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let base = format!("http://127.0.0.1:{}/v1", port);
            wait_ready(&client, &base, READY_TIMEOUT_HF, Some(&mut child), &log)
                .await
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let pid = child.id();
            let server = Server {
                id: id.clone(),
                kind: "hf",
                label: format!("Python · {}", model_name),
                model: model_name.clone(),
                base_url: base.clone(),
                port,
                pid,
                child: Some(child),
                started_unix: now_unix(),
                log: log.clone(),
            };
            let v = server_json(&server);
            registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), server);
            Ok(Json(json!({ "server": v, "base_url": base, "model": model_name })))
        }

        _ => Err(err(StatusCode::BAD_REQUEST, "Desteklenmeyen model türü.".into())),
    }
}

/// Şim betiğini diske yazar (gömülü kaynak) ve yolunu döndürür.
fn write_hf_server_script() -> Result<PathBuf, (StatusCode, String)> {
    let dir = std::env::temp_dir().join("thalamus_models");
    std::fs::create_dir_all(&dir).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let path = dir.join("hf_server.py");
    std::fs::write(&path, include_str!("hf_server.py"))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("şim betiği yazılamadı: {}", e)))?;
    Ok(path)
}

/// POST /api/ai/serve/stop — bu modülün başlattığı bir sunucuyu durdurur.
pub async fn stop_model(Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let id = req
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Model kimliği boş.".into()));
    }
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut server) = reg.remove(&id) else {
        return Ok(Json(json!({ "stopped": false, "reason": "çalışmıyor" })));
    };
    if let Some(child) = server.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(Json(json!({ "stopped": true, "id": id })))
}

/// GET /api/ai/serve — çalışan (yönetilen) sunucuların listesi.
pub async fn list_serving() -> Json<Value> {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    let mut dead = Vec::new();
    for (id, s) in reg.iter_mut() {
        if let Some(child) = s.child.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                dead.push(id.clone());
                continue;
            }
        }
        out.push(server_json(s));
    }
    for id in dead {
        reg.remove(&id);
    }
    Json(json!({ "servers": out }))
}

/// Uygulama kapanırken başlatılan motorları öldürür (yetim süreç kalmasın).
pub fn shutdown_all() {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    for s in reg.values_mut() {
        if let Some(child) = s.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    reg.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_path_is_sanitized() {
        let p = temp_log_path("gguf:C:\\Users\\x\\a b.gguf");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains(':'));
        assert!(!name.contains('\\'));
        assert!(name.ends_with(".log"));
    }

    #[test]
    fn free_port_is_usable() {
        let p = free_port().unwrap();
        assert!(p > 1024);
        // Aynı port hemen tekrar bağlanabilmeli (bıraktık).
        assert!(std::net::TcpListener::bind(("127.0.0.1", p)).is_ok());
    }
}

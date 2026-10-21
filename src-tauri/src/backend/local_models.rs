// Yerel model keşfi — bu bilgisayarda bulunan TÜM modelleri listeler:
//
//   1. Çalışan sunucular (`endpoints`): Ollama, LM Studio, llama.cpp, vLLM…
//      OpenAI uyumlu `/v1/models` uçları olan canlı süreçler.
//   2. Motorlar (`engines`): hangi çıkarım motoru kurulu (bkz. `engines.rs`).
//   3. Model dosyaları (`files`): Ollama manifestleri, HuggingFace önbelleği
//      (safetensors + gguf), LM Studio/Jan/GPT4All/llama.cpp klasörleri ve
//      kullanıcının eklediği dizinler.
//
// Neden backend'de: tarayıcı/webview yerel sunuculara CORS/karma içerik
// nedeniyle doğrudan istek atamaz; dosya sistemi de yalnızca yerel tarafta
// okunabilir. Tarama PARALEL (1.5 sn/aday) ve derinlik sınırlıdır; tüm disk
// asla gezilmez.

use crate::backend::engines;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Aday uç noktalar: (sağlayıcı kimliği, etiket, OpenAI uyumlu taban URL).
const CANDIDATES: &[(&str, &str, &str)] = &[
    ("ollama", "Ollama", "http://127.0.0.1:11434/v1"),
    ("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1"),
    ("custom", "llama.cpp (llama-server)", "http://127.0.0.1:8080/v1"),
    ("custom", "vLLM / TGI / SGLang", "http://127.0.0.1:8000/v1"),
    ("custom", "text-generation-webui", "http://127.0.0.1:5000/v1"),
    ("custom", "Jan", "http://127.0.0.1:1337/v1"),
    ("custom", "KoboldCpp", "http://127.0.0.1:5001/v1"),
    ("custom", "GPT4All", "http://127.0.0.1:4891/v1"),
];

/// Tek bir aday için üst sınır: açık olmayan portlar taramayı bekletmesin.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Dosya taramasında girilen en fazla klasör derinliği.
const MAX_SCAN_DEPTH: usize = 3;

/// Listeye girebilecek en fazla dosya (arayüz kilitlenmesin).
const MAX_FILES: usize = 200;

#[derive(serde::Deserialize)]
pub struct LocalScanRequest {
    /// Kullanıcının girdiği ek adresler (Custom sağlayıcının taban URL'si).
    #[serde(default)]
    pub base_urls: Vec<String>,
    /// Kullanıcının eklediği model klasörleri (Ayarlar → Yerel modeller).
    #[serde(default)]
    pub model_dirs: Vec<String>,
}

// ── Yardımcılar ─────────────────────────────────────────────────────────

fn parse_openai_models(v: &Value) -> Vec<String> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_ollama_tags(v: &Value) -> Vec<String> {
    v.get("models")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|i| i.as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_base(url: &str) -> String {
    let mut t = url.trim().trim_end_matches('/').to_string();
    // "localhost", "[::1]", "0.0.0.0" aynı yerel sunucudur: 127.0.0.1'e indirge
    // ki aynı uç nokta iki kez listelenmesin (ör. Ollama hem aday hem özel URL).
    for host in ["http://localhost", "http://[::1]", "http://::1", "http://0.0.0.0"] {
        if let Some(rest) = t.strip_prefix(host) {
            if rest.is_empty() || rest.starts_with(':') || rest.starts_with('/') {
                t = format!("http://127.0.0.1{}", rest);
                break;
            }
        }
    }
    if t.ends_with("/v1") {
        t
    } else {
        format!("{}/v1", t)
    }
}

/// Tek bir uç noktayı yoklar. Sunucu ayakta değilse `None` döner.
async fn probe(
    client: &reqwest::Client,
    provider: &str,
    label: &str,
    base: &str,
) -> Option<Value> {
    let base = normalize_base(base);
    let mut models: Vec<String> = Vec::new();
    let mut reachable = false;

    if let Ok(resp) = client.get(format!("{}/models", base)).send().await {
        if resp.status().is_success() {
            reachable = true;
            if let Ok(v) = resp.json::<Value>().await {
                models = parse_openai_models(&v);
            }
        }
    }

    // Ollama: eski sürümlerde OpenAI ucu yok; yerel /api/tags uç noktasına düş.
    if reachable && models.is_empty() && provider == "ollama" {
        let tags_url = format!("{}/api/tags", base.trim_end_matches("/v1"));
        if let Ok(resp) = client.get(tags_url).send().await {
            if let Ok(v) = resp.json::<Value>().await {
                models = parse_ollama_tags(&v);
            }
        }
    }

    if !reachable {
        return None;
    }
    models.sort();
    models.dedup();
    Some(json!({
        "provider": provider,
        "label": label,
        "base_url": base,
        "models": models,
    }))
}

// ── Ollama manifestleri ─────────────────────────────────────────────────

/// `~/.ollama/models/manifests/**` → indirilmiş Ollama modelleri.
/// Manifest JSON'u katman boyutlarını taşır; ayrıca blob okumaya gerek yok.
fn scan_ollama(home: &Path) -> Vec<Value> {
    let root = home.join(".ollama").join("models").join("manifests");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            // Manifest yolu: .../manifests/registry.ollama.ai/library/<ad>/<etiket>
            let rel = path.strip_prefix(&root).unwrap_or(&path);
            let parts: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            if parts.len() < 2 {
                continue;
            }
            let tag = parts[parts.len() - 1].clone();
            let name = parts[parts.len() - 2].clone();
            let model_id = format!("{}:{}", name, tag);
            let size: u64 = v
                .get("layers")
                .and_then(|l| l.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.get("size").and_then(|s| s.as_u64()))
                        .sum()
                })
                .unwrap_or(0);
            out.push(json!({
                "id": format!("ollama:{}", model_id),
                "kind": "ollama",
                "label": model_id,
                "path": path.to_string_lossy(),
                "size_bytes": size,
                "engine": "ollama",
                "servable": true,
                "model": model_id,
                "note": Value::Null,
            }));
        }
    }
    out
}

// ── HuggingFace önbelleği ───────────────────────────────────────────────

/// `~/.cache/huggingface/hub/models--org--ad` → safetensors klasörleri ve
/// indirilmiş `.gguf` dosyaları. `datasets--*` atlanır (model değiller).
fn scan_hf_hub(home: &Path, llama_ready: bool, python_ready: bool) -> Vec<Value> {
    let hub = home.join(".cache").join("huggingface").join("hub");
    let Ok(entries) = std::fs::read_dir(&hub) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("models--") {
            continue;
        }
        // models--Qwen--Qwen2.5-7B → Qwen/Qwen2.5-7B
        let repo = name.trim_start_matches("models--").replace("--", "/");
        let snapshots = e.path().join("snapshots");
        let Ok(revs) = std::fs::read_dir(&snapshots) else { continue };

        let mut ggufs: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut best_rev: Option<(PathBuf, u64, bool)> = None;

        for rev in revs.flatten() {
            let rev_path = rev.path();
            let Ok(files) = std::fs::read_dir(&rev_path) else { continue };
            let mut rev_bytes: u64 = 0;
            let mut rev_has_config = false;
            for f in files.flatten() {
                let p = f.path();
                let fname = f.file_name().to_string_lossy().to_string();
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if ext == "gguf" {
                    ggufs.push((fname, p, size));
                } else if ext == "safetensors" {
                    rev_bytes += size;
                } else if fname == "config.json" {
                    rev_has_config = true;
                }
            }
            // Aynı modelin birden çok revizyonu olabilir: en büyük revizyonu al
            // (toplamak boyutu şişirir).
            if rev_bytes > 0 && best_rev.as_ref().map(|(_, b, _)| rev_bytes > *b).unwrap_or(true) {
                best_rev = Some((rev_path, rev_bytes, rev_has_config));
            }
        }

        for (fname, p, size) in ggufs {
            let stem = fname.trim_end_matches(".gguf").to_string();
            out.push(json!({
                "id": format!("gguf:{}", p.to_string_lossy()),
                "kind": "gguf",
                "label": stem,
                "path": p.to_string_lossy(),
                "size_bytes": size,
                "engine": "llamaserver",
                "servable": llama_ready,
                "model": stem,
                "note": if llama_ready { Value::Null } else { json!("llama.cpp gerekli") },
            }));
        }

        if let Some((dir, bytes, has_config)) = best_rev {
            // config.json architectures → yalnızca üretici (chat) modelleri
            // "çalıştırılabilir" sayılır; sınıflandırma/embedding modelleri
            // listelenir ama "sohbet modeli değil" notuyla işaretlenir.
            let chat = config_is_causal(&dir, has_config);
            out.push(json!({
                "id": format!("hf:{}", repo),
                "kind": "safetensors",
                "label": repo,
                "path": dir.to_string_lossy(),
                "size_bytes": bytes,
                "engine": "python",
                "servable": python_ready && chat,
                "model": repo,
                "note": if !chat {
                    json!("Sohbet modeli değil (metin üretmez)")
                } else if !python_ready {
                    json!("Python ortamı gerekli (transformers + torch)")
                } else {
                    Value::Null
                },
            }));
        }
    }
    out
}

/// `config.json` içindeki `architectures` üretici (causal LM) mi?
fn config_is_causal(dir: &Path, saw_config: bool) -> bool {
    if !saw_config {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(dir.join("config.json")) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    v.get("architectures")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| a.as_str()).any(|a| {
                let a = a.to_ascii_lowercase();
                a.contains("causallm") || a.contains("conditionalgeneration")
            })
        })
        .unwrap_or(false)
}

// ── Klasörlerdeki .gguf dosyaları ───────────────────────────────────────

/// Verilen klasörlerde `MAX_SCAN_DEPTH` derinliğe kadar `.gguf` arar.
fn scan_gguf_dirs(dirs: &[PathBuf], llama_ready: bool, seen: &mut Vec<PathBuf>) -> Vec<Value> {
    let mut out = Vec::new();
    for root in dirs {
        if !root.is_dir() {
            continue;
        }
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > MAX_SCAN_DEPTH || out.len() + seen.len() >= MAX_FILES {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    // Atılması gereken gürültü klasörleri.
                    let n = e.file_name().to_string_lossy().to_ascii_lowercase();
                    if matches!(n.as_str(), ".git" | "node_modules" | "__pycache__" | ".cache") {
                        continue;
                    }
                    stack.push((p, depth + 1));
                    continue;
                }
                let is_gguf = p
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("gguf"));
                if !is_gguf {
                    continue;
                }
                let canon = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                if seen.contains(&canon) {
                    continue;
                }
                seen.push(canon);
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let fname = e.file_name().to_string_lossy().to_string();
                let stem = fname.trim_end_matches(".gguf").to_string();
                out.push(json!({
                    "id": format!("gguf:{}", p.to_string_lossy()),
                    "kind": "gguf",
                    "label": stem,
                    "path": p.to_string_lossy(),
                    "size_bytes": size,
                    "engine": "llamaserver",
                    "servable": llama_ready,
                    "model": stem,
                    "note": if llama_ready { Value::Null } else { json!("llama.cpp gerekli") },
                }));
            }
        }
    }
    out
}

/// Varsayılan yerel model klasörleri (kuruluysa).
fn default_model_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".lmstudio").join("models"),
        home.join(".cache").join("lm-studio").join("models"),
        home.join(".jan").join("models"),
        home.join(".gpt4all"),
        home.join("text-generation-webui").join("models"),
        home.join("models"),
    ];
    if let Some(lad) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(lad.join("nomic.ai").join("GPT4All"));
    }
    if let Some(ad) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(ad.join("Jan").join("data").join("models"));
    }
    dirs
}

/// Bir dosya girdisini çalışan uç noktalarla eşleştirir (`served_by` ekler).
fn mark_served(files: &mut [Value], endpoints: &[Value]) {
    for f in files.iter_mut() {
        let path = f.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
        let model = f.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let base = f.get("label").and_then(|l| l.as_str()).unwrap_or("").to_string();
        let mut served: Vec<String> = Vec::new();
        for ep in endpoints {
            let Some(url) = ep.get("base_url").and_then(|u| u.as_str()) else { continue };
            let models = ep.get("models").and_then(|m| m.as_array()).cloned().unwrap_or_default();
            let hit = models.iter().any(|m| {
                let Some(m) = m.as_str() else { return false };
                m == model
                    || m == base
                    || m == path
                    || path.ends_with(m)
                    || m.ends_with(&format!("/{}", base))
            });
            if hit {
                served.push(url.to_string());
            }
        }
        if let Some(obj) = f.as_object_mut() {
            obj.insert("served_by".to_string(), json!(served));
        }
    }
}

// ── Uç nokta ────────────────────────────────────────────────────────────

/// POST /api/ai/models — çalışan sunucuları, motorları ve yerel model
/// dosyalarını tek yanıtta döndürür.
pub async fn local_models(
    Json(req): Json<LocalScanRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Yerel adreslere giden istekler sistem proxy'sinden geçmemeli.
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut targets: Vec<(String, String, String)> = CANDIDATES
        .iter()
        .map(|(p, l, u)| (p.to_string(), l.to_string(), u.to_string()))
        .collect();
    for raw in &req.base_urls {
        let base = normalize_base(raw);
        if raw.trim().is_empty() || targets.iter().any(|(_, _, b)| b == &base) {
            continue;
        }
        targets.push(("custom".to_string(), "Custom endpoint".to_string(), base));
    }

    // Motor tespiti + dosya taraması CPU/disk işi: ağ beklemesiyle paralel.
    let engines_found = engines::detect();
    let llama_ready = engines_found
        .iter()
        .any(|e| e.id == "llamaserver" && e.ready);
    let python_ready = engines_found.iter().any(|e| e.id == "python" && e.ready);
    let sys = engines::system_info();
    let mut dirs = default_model_dirs(&home_dir());
    for d in &req.model_dirs {
        let p = PathBuf::from(d.trim());
        if !d.trim().is_empty() {
            dirs.push(p);
        }
    }

    let scan = tokio::task::spawn_blocking(move || {
        let home = home_dir();
        let mut seen: Vec<PathBuf> = Vec::new();
        let mut files = scan_ollama(&home);
        files.extend(scan_hf_hub(&home, llama_ready, python_ready));
        files.extend(scan_gguf_dirs(&dirs, llama_ready, &mut seen));
        files.truncate(MAX_FILES);
        // Büyükten küçüğe: en kullanışlı modeller üstte.
        files.sort_by(|a, b| {
            let sa = a.get("size_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
            let sb = b.get("size_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
            sb.cmp(&sa)
        });
        files
    });

    let mut set = tokio::task::JoinSet::new();
    for (idx, (provider, label, base)) in targets.into_iter().enumerate() {
        let client = client.clone();
        set.spawn(async move { (idx, probe(&client, &provider, &label, &base).await) });
    }

    let mut found: Vec<(usize, Value)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((idx, Some(value))) = joined {
            found.push((idx, value));
        }
    }
    found.sort_by_key(|(idx, _)| *idx);
    let endpoints: Vec<Value> = found.into_iter().map(|(_, v)| v).collect();

    let mut files = scan.await.unwrap_or_default();
    mark_served(&mut files, &endpoints);

    let engines_json: Vec<Value> = engines_found.iter().map(|e| e.to_json()).collect();
    Ok(Json(json!({
        "endpoints": endpoints,
        "engines": engines_json,
        "files": files,
        "system": sys,
    })))
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_model_list() {
        let v = json!({"object":"list","data":[{"id":"qwen2.5-coder:7b"},{"id":" llama3.1 "},{"nope":1}]});
        assert_eq!(parse_openai_models(&v), vec!["qwen2.5-coder:7b", "llama3.1"]);
        assert!(parse_openai_models(&json!({"data":[]})).is_empty());
        assert!(parse_openai_models(&json!({})).is_empty());
    }

    #[test]
    fn parses_ollama_tags() {
        let v = json!({"models":[{"name":"qwen2.5-coder:7b","size":1},{"name":"llama3.1"}]});
        assert_eq!(parse_ollama_tags(&v), vec!["qwen2.5-coder:7b", "llama3.1"]);
        assert!(parse_ollama_tags(&json!({"models":null})).is_empty());
    }

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(normalize_base("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
        assert_eq!(normalize_base("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1");
        assert_eq!(normalize_base("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1");
        assert_eq!(normalize_base(" http://127.0.0.1:8080/ "), "http://127.0.0.1:8080/v1");
        // Aynı yerel sunucu farklı adlarla iki kez listelenmemeli.
        assert_eq!(normalize_base("http://localhost:11434/v1"), "http://127.0.0.1:11434/v1");
        assert_eq!(normalize_base("http://[::1]:1234"), "http://127.0.0.1:1234/v1");
        assert_eq!(normalize_base("http://0.0.0.0:8000/v1/"), "http://127.0.0.1:8000/v1");
        // Loopback olmayan adresler korunur.
        assert_eq!(normalize_base("http://192.168.1.5:8000"), "http://192.168.1.5:8000/v1");
    }

    #[test]
    fn classifies_causal_models_from_config() {
        let dir = std::env::temp_dir().join("thalamus_hf_config_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"architectures":["Qwen2ForCausalLM"]}"#,
        )
        .unwrap();
        assert!(config_is_causal(&dir, true));
        std::fs::write(
            dir.join("config.json"),
            r#"{"architectures":["DebertaV2ForSequenceClassification"]}"#,
        )
        .unwrap();
        assert!(!config_is_causal(&dir, true));
        // config.json yoksa üretici sayılmaz.
        assert!(!config_is_causal(&dir, false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn matches_served_models_to_endpoints() {
        let mut files = vec![json!({
            "id": "ollama:qwen2.5-coder:7b",
            "label": "qwen2.5-coder:7b",
            "model": "qwen2.5-coder:7b",
            "path": "/x/manifest",
        })];
        let endpoints = vec![json!({
            "base_url": "http://127.0.0.1:11434/v1",
            "models": ["qwen2.5-coder:7b"],
        })];
        mark_served(&mut files, &endpoints);
        assert_eq!(
            files[0].get("served_by").unwrap(),
            &json!(["http://127.0.0.1:11434/v1"])
        );
    }
}

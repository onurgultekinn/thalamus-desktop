//! Arastir — yerel anahtarsız/kotasız internet erişimi (search + read).
//!
//! Backend: Arastir'ın yerel HTTP API'si (`arastir serve`, port 19900).
//! Sunucu ayakta değilse sessizce detached başlatılır. Sıkıştırmaya değen
//! cevaplar /compress'ten geçirilir (kayıp doğrulanmış sıkıştırma).

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

const PORT: u16 = 19900;
const BASE: &str = "http://127.0.0.1:19900";
static SPAWN_TRIED: AtomicBool = AtomicBool::new(false);

fn health_alive() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{PORT}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn ensure_running() {
    if health_alive() || SPAWN_TRIED.swap(true, Ordering::Relaxed) {
        return;
    }
    let exe = if cfg!(windows) {
        home_bin("arastir.exe")
    } else {
        home_bin("arastir")
    };
    let mut cmd = Command::new(exe.unwrap_or_else(|| "arastir".into()));
    cmd.args(["serve", "--port", &PORT.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS
        cmd.creation_flags(0x0800_0000 | 0x0000_0008);
    }
    let _ = cmd.spawn();
    // Ayağa kalkmasını kısaca bekle; olmazsa istek zaten anlamlı hata döner.
    for _ in 0..20 {
        if health_alive() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn home_bin(name: &str) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let path = std::path::Path::new(&home)
        .join(".local")
        .join("bin")
        .join(name);
    path.exists().then(|| path.to_string_lossy().into_owned())
}

fn get_json(path: &str) -> Result<Value, String> {
    ensure_running();
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{BASE}{path}"))
        .send()
        .map_err(|e| format!("Arastir API'ye ulaşılamadı (arastir serve kapalı mı?): {e}"))?
        .error_for_status()
        .map_err(|e| format!("Arastir API hatası: {e}"))?;
    resp.json::<Value>().map_err(|e| e.to_string())
}

fn post_json(path: &str, body: Value) -> Result<Value, String> {
    ensure_running();
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{BASE}{path}"))
        .json(&body)
        .send()
        .map_err(|e| format!("Arastir API hatası: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Arastir API hatası: {e}"))?;
    resp.json::<Value>().map_err(|e| e.to_string())
}

/// `web_search` aracı: birleşik anahtarsız arama (SearXNG → ddg → exa → tarayıcı).
/// Cevap yüksekse /compress'ten geçirilir (kayıp doğrulanmış sıkıştırma).
pub fn web_search(args: &Value) -> String {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if query.is_empty() {
        return "web_search: query is required".into();
    }
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(5).min(20);
    let payload = get_json(&format!(
        "/search?q={}&limit={}",
        urlencode(&query),
        limit
    ));
    let payload = match payload {
        Ok(p) => p,
        Err(e) => return e,
    };
    if !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let err = payload.get("error").cloned().unwrap_or(Value::Null);
        return format!("search failed: {err}");
    }
    // Compact arastir envelope: items live at the top level.
    let items = payload.get("items").cloned().unwrap_or_else(|| json!([]));
    let mut out = json!({"engine": payload.get("engine").cloned().unwrap_or(Value::Null), "items": items});
    // Cevap ~2KB'yi aşıyorsa sıkıştırma kâr eder; motorun kararı zaten güvenli.
    if out.to_string().len() > 2048 {
        if let Ok(metrics) = post_json("/compress", out.clone()) {
            if metrics
                .pointer("/result/is_compressed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let saved = metrics.get("tokens_saved").cloned().unwrap_or(json!(0));
                out = json!({
                    "compressed": metrics.pointer("/result/processed_prompt").cloned().unwrap_or(Value::Null),
                    "decode": "SearXNG @T table: decode with the arastir compression grammar",
                    "saved_tokens": saved,
                });
            }
        }
    }
    out.to_string()
}

/// `read_page` aracı: sayfayı temiz metin olarak okur (jina → exa → tarayıcı).
pub fn read_page(args: &Value) -> String {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if url.is_empty() {
        return "read_page: url is required".into();
    }
    match get_json(&format!("/read?url={}", urlencode(&url))) {
        Ok(payload) => {
            if !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let err = payload.get("error").cloned().unwrap_or(Value::Null);
                return format!("read failed: {err}");
            }
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // Metin uzunsa kayıpsız sıkıştırma uygula (aynı gramerle decode edilir).
            if text.len() > 4096 {
                if let Ok(metrics) = post_json("/compress", json!(text)) {
                    if metrics
                        .pointer("/result/is_compressed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        return json!({
                            "url": url,
                            "compressed_text": metrics.pointer("/result/processed_prompt").cloned().unwrap_or(Value::Null),
                            "saved_tokens": metrics.pointer("/result/saved_tokens").cloned().unwrap_or(json!(0)),
                            "note": "lossless-verified compression; decode with the @T grammar",
                        })
                        .to_string();
                    }
                }
            }
            json!({"url": url, "text": text}).to_string()
        }
        Err(e) => e,
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Test/başlangıç amaçlı: yerel API ayakta mı?
#[allow(dead_code)]
pub fn ping() -> bool {
    health_alive()
}

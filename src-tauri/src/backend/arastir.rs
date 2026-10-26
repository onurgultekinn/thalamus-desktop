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
/// `read_page`/`web_search` bağlantı hedeflerini SSRF'ye karşı süzer.
///
/// Modelin verebileceği her URL buradan geçer: yalnız http/https kabul edilir;
/// loopback, özel ağlar ve bağlantısız aralıklar (127.0.0.1, ::1, 10/8,
/// 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10) reddedilir.
/// Gerekçe: yerel backend (127.0.0.1:8277) aynı makinede oturuyor — izinsiz
/// bir `read_page`, session token'lı API'ye kapalı kapıdan bakma yoludur.
/// IP'ler hostname çözümlemesinden SONRA da denetlenir (DNS-rebinding).
fn url_allowed(url: &str) -> Result<(), String> {
    use std::net::IpAddr;

    let parsed = reqwest::Url::parse(url).map_err(|e| format!("read_page: invalid url ({e})"))?;
    let scheme_ok = matches!(parsed.scheme(), "http" | "https");
    if !scheme_ok {
        return Err(format!(
            "read_page: unsupported scheme '{}' (only http/https)",
            parsed.scheme()
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "read_page: url has no host".to_string())?
        .trim_end_matches('.')
        .to_ascii_lowercase();

    // Ana bilgisayar adı doğrudan loopback/özel olarak adlandırılmışsa erken reddet.
    const BLOCKED_NAMES: [&str; 4] = ["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"];
    if BLOCKED_NAMES.contains(&host.as_str()) || host.ends_with(".local") || host.ends_with(".internal") {
        return Err("read_page: access to local/private hostnames is denied".into());
    }

    // Çözümlenen her adres için de denetle (DNS-rebinding kapanır).
    let addrs: Vec<std::net::SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![std::net::SocketAddr::new(ip, 0)]
    } else {
        use std::net::ToSocketAddrs;
        (host, parsed.port().unwrap_or(80))
            .to_socket_addrs()
            .map_err(|e| format!("read_page: could not resolve host ({e})"))?
            .collect()
    };
    if addrs.is_empty() {
        return Err("read_page: could not resolve host".into());
    }
    for addr in &addrs {
        let ip = addr.ip();
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    || v4.octets()[0] == 100 && v4.octets()[1] >= 64 && v4.octets()[1] <= 127 // CGNAT
                    || v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2 // TEST-NET doc
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            }
        };
        if blocked {
            return Err(format!(
                "read_page: access to private/loopback address {ip} is denied"
            ));
        }
    }
    Ok(())
}

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
    if let Err(e) = url_allowed(&url) {
        return e;
    }
    // balanced seviye: ~%72 token, sayılar %97-99 korunur (arastir textlab ölçümü).
    match get_json(&format!("/read?url={}&level=balanced", urlencode(&url))) {
        Ok(payload) => {
            if !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let err = payload.get("error").cloned().unwrap_or(Value::Null);
                return format!("read failed: {err}");
            }
            // Kompakt zarf: metin tepede, sıkıştırma istatistikleri yanında.
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let engine = payload.get("engine").cloned().unwrap_or(Value::Null);
            let compression = payload.get("compression").cloned().unwrap_or(Value::Null);
            json!({
                "url": url,
                "engine": engine,
                "text": text,
                "compression": compression,
            })
            .to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_and_public_hosts_are_allowed() {
        assert!(url_allowed("https://example.com/docs").is_ok());
        assert!(url_allowed("http://example.com").is_ok());
        assert!(url_allowed("https://rustlang.org/?q=1#x").is_ok());
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        assert!(url_allowed("file:///etc/passwd").is_err());
        assert!(url_allowed("ftp://example.com/x").is_err());
        assert!(url_allowed("javascript:alert(1)").is_err());
    }

    #[test]
    fn loopback_and_private_targets_are_rejected() {
        assert!(url_allowed("http://127.0.0.1:8277/api/health").is_err());
        assert!(url_allowed("http://localhost/x").is_err());
        assert!(url_allowed("http://10.0.0.5/x").is_err());
        assert!(url_allowed("http://172.16.1.1/x").is_err());
        assert!(url_allowed("http://192.168.1.10:8080/x").is_err());
        assert!(url_allowed("http://169.254.169.254/latest/meta-data").is_err());
        assert!(url_allowed("http://[::1]:8277/x").is_err());
        assert!(url_allowed("http://[fe80::1]/x").is_err());
    }

    #[test]
    fn malformed_urls_are_rejected() {
        assert!(url_allowed("not a url").is_err());
        assert!(url_allowed("http://").is_err());
    }
}

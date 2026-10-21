// Yerel çıkarım motorlarının tespiti.
//
// Tek tıkla "modelleri çalıştır" akışı, hangi motorun kurulu olduğuna bağlı:
//   * ollama       → Ollama (indirilmiş GGUF'ları zaten sunar; `ollama serve`)
//   * llamaserver  → llama.cpp `llama-server.exe` (GGUF dosyalarını doğrudan
//                    OpenAI uyumlu olarak sunar). Ollama bu ikiliyi kendi
//                    içinde getirdiği için ayrı kurulum şart değildir.
//   * python       → `transformers` + `torch` (HF `safetensors` klasörlerini
//                    küçük bir FastAPI şim'i ile sunar)
//   * vllm         → varsa safetensors için daha hızlı alternatif
//
// Tespit ucuz tutulur: PATH/dizin kontrolü ve `site-packages` `.dist-info`
// listesi (süreç başlatmaz). Ağır kontroller (python import, nvidia-smi) bir
// kez çalışıp önbelleğe alınır.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug)]
pub struct Engine {
    pub id: &'static str,
    pub label: &'static str,
    pub path: Option<PathBuf>,
    /// Motor şu an kullanılabilir mi (ikili + bağımlılıklar bulundu).
    pub ready: bool,
    /// Kısa durum/ek bilgi (arayüzde alt satır).
    pub detail: String,
    /// llama-server Ollama'nın içinden geldiyse true (ayrı kurulum yok).
    pub bundled: bool,
}

impl Engine {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "path": self.path.as_ref().map(|p| p.to_string_lossy().to_string()),
            "ready": self.ready,
            "detail": self.detail,
            "bundled": self.bundled,
        })
    }
}

/// Windows'ta `CREATE_NO_WINDOW`: arka planda başlatılan motor konsolu açmasın.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `where.exe <name>` ile PATH'teki ilk gerçek (App Execution Alias olmayan)
/// yolu bulur. Yalnızca ikili arama için; başarısızlık `None`.
pub fn which(name: &str) -> Option<PathBuf> {
    let out = std::process::Command::new("where.exe").arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        // WindowsApps "python.exe" gerçek bir ikili değil (Microsoft Store
        // takma adı) — çalıştırılamaz, atla.
        .filter(|l| !l.to_ascii_lowercase().contains("\\windowsapps\\"))
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn local_appdata() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

/// Ollama kurulum dizinindeki paketlenmiş `llama-server.exe`.
fn ollama_llama_server() -> Option<PathBuf> {
    let p = local_appdata()?
        .join("Programs")
        .join("Ollama")
        .join("lib")
        .join("ollama")
        .join("llama-server.exe");
    p.is_file().then_some(p)
}

fn ollama_exe() -> Option<PathBuf> {
    if let Some(p) = which("ollama.exe") {
        return Some(p);
    }
    let p = local_appdata()?.join("Programs").join("Ollama").join("ollama.exe");
    p.is_file().then_some(p)
}

/// LM Studio'nun indirdiği llama.cpp çalıştırıcıları (derinlik sınırlı).
fn lmstudio_llama_server() -> Option<PathBuf> {
    let mut roots = vec![home().join(".lmstudio").join("extensions").join("backends")];
    if let Some(lad) = local_appdata() {
        roots.push(lad.join("Programs").join("lm-studio").join("resources"));
    }
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        if let Some(found) = find_first(&root, "llama-server.exe", 4) {
            return Some(found);
        }
    }
    None
}

/// `dir` altında `name` dosyasını `max_depth` seviyeye kadar arar.
pub fn find_first(dir: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        let mut subdirs = Vec::new();
        for e in entries.flatten() {
            let path = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => subdirs.push(path),
                Ok(_) => {
                    if path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case(name))
                    {
                        return Some(path);
                    }
                }
                Err(_) => {}
            }
        }
        for s in subdirs {
            stack.push((s, depth + 1));
        }
    }
    None
}

/// `python.exe` arayışı: PATH → kullanıcı kurulumları (en yeni sürüm önce).
fn python_exe() -> Option<PathBuf> {
    if let Some(p) = which("python.exe") {
        return Some(p);
    }
    let programs = local_appdata()?.join("Programs").join("Python");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&programs)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.to_ascii_lowercase().starts_with("python3"))
        })
        .map(|e| e.path().join("python.exe"))
        .filter(|p| p.is_file())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// `python.exe` yanındaki `site-packages/*.dist-info` listesinden sürüm okur
/// (hızlı yol); bulunamazsa `python -c` ile gerçek dağıtım listesine düşer —
/// kullanıcı kurulumları (`%APPDATA%\Python\...\site-packages`) ancak böyle
/// görünür. Sonuç süreç başına önbelleğe alınır.
fn python_packages(python: &Path) -> Vec<(String, String)> {
    type PkgCache = Mutex<HashMap<String, Vec<(String, String)>>>;
    static CACHE: OnceLock<PkgCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = python.to_string_lossy().to_string();
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return hit.clone();
    }

    let mut pkgs = python_packages_from_dirs(python);
    let needed = ["torch", "transformers", "fastapi", "uvicorn"];
    if !needed.iter().all(|n| pkg_version(&pkgs, n).is_some()) {
        if let Some(found) = python_packages_from_process(python) {
            pkgs = found;
        }
    }
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, pkgs.clone());
    pkgs
}

/// `<python>\Lib\site-packages` (+ kullanıcı site-packages) `.dist-info` taraması.
fn python_packages_from_dirs(python: &Path) -> Vec<(String, String)> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = python.parent() {
        roots.push(root.join("Lib").join("site-packages"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let ver = python
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_ascii_lowercase().replace("python", "Python"))
            .unwrap_or_default();
        roots.push(appdata.join("Python").join(ver).join("site-packages"));
    }
    let mut out = Vec::new();
    for lib in roots {
        let Ok(rd) = std::fs::read_dir(&lib) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".dist-info") {
                continue;
            }
            // "torch-2.14.0.dist-info" → ("torch", "2.14.0")
            let stem = name.trim_end_matches(".dist-info");
            if let Some((pkg, ver)) = stem.rsplit_once('-') {
                out.push((pkg.to_ascii_lowercase(), ver.to_string()));
            }
        }
    }
    out
}

/// Gerçek dağıtım listesi: `importlib.metadata` (tek seferlik, önbellekli).
fn python_packages_from_process(python: &Path) -> Option<Vec<(String, String)>> {
    let script = "import importlib.metadata as m,json;\
                  print(json.dumps(sorted((d.metadata['Name'].lower(), d.version) for d in m.distributions() if d.metadata['Name'])))";
    let mut cmd = std::process::Command::new(python);
    cmd.arg("-c").arg(script).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // `python` uyarı basabilir: son satırı JSON kabul et.
    let line = text.lines().rev().find(|l| l.trim_start().starts_with('['))?;
    let arr = serde_json::from_str::<Vec<Vec<String>>>(line.trim()).ok()?;
    Some(
        arr.into_iter()
            .filter_map(|pair| {
                let mut it = pair.into_iter();
                Some((it.next()?, it.next()?))
            })
            .collect(),
    )
}

fn pkg_version(pkgs: &[(String, String)], name: &str) -> Option<String> {
    pkgs.iter()
        .find(|(p, _)| p == name)
        .map(|(_, v)| v.clone())
}

/// GPU adı/belleği (varsa). `nvidia-smi` yoksa boş.
fn gpu_info() -> String {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

/// Sistem bilgisi (motorlarla birlikte döner; arayüzde "8 GB VRAM" göstergesi).
pub fn system_info() -> Value {
    static CACHE: OnceLock<Value> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let gpu = gpu_info();
            json!({
                "gpu": if gpu.is_empty() { Value::Null } else { Value::String(gpu) },
                "cpu_threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            })
        })
        .clone()
}

/// Kurulu motorları döndürür (her çağrıda yeniden — dosya kontrolleri ucuz).
pub fn detect() -> Vec<Engine> {
    let mut engines = Vec::new();

    // ── Ollama ──────────────────────────────────────────────────────────
    let ollama = ollama_exe();
    engines.push(Engine {
        id: "ollama",
        label: "Ollama",
        ready: ollama.is_some(),
        detail: match &ollama {
            Some(_) => "İndirilmiş modelleri doğrudan sunar (ollama serve).".to_string(),
            None => "Kurulu değil.".to_string(),
        },
        bundled: false,
        path: ollama,
    });

    // ── llama.cpp (llama-server) ────────────────────────────────────────
    let (llama, bundled) = match which("llama-server.exe") {
        Some(p) => (Some(p), false),
        None => match lmstudio_llama_server() {
            Some(p) => (Some(p), false),
            None => (ollama_llama_server(), true),
        },
    };
    let llama_detail = match (&llama, bundled) {
        (Some(_), true) => {
            "Ollama ile birlikte gelir; herhangi bir .gguf dosyasını açar.".to_string()
        }
        (Some(_), false) => "Bağımsız kurulum; herhangi bir .gguf dosyasını açar.".to_string(),
        (None, _) => "Bulunamadı — .gguf dosyaları çalıştırılamaz.".to_string(),
    };
    engines.push(Engine {
        id: "llamaserver",
        label: "llama.cpp",
        ready: llama.is_some(),
        detail: llama_detail,
        bundled,
        path: llama,
    });

    // ── Python (transformers) ───────────────────────────────────────────
    let python = python_exe();
    let pkgs = python.as_ref().map(|p| python_packages(p)).unwrap_or_default();
    let has_torch = pkg_version(&pkgs, "torch").is_some();
    let has_transformers = pkg_version(&pkgs, "transformers").is_some();
    let has_server = pkg_version(&pkgs, "fastapi").is_some() && pkg_version(&pkgs, "uvicorn").is_some();
    let ready = python.is_some() && has_torch && has_transformers && has_server;
    let detail = if python.is_none() {
        "Python bulunamadı.".to_string()
    } else if ready {
        format!(
            "transformers {} · torch {} — safetensors klasörlerini sunar.",
            pkg_version(&pkgs, "transformers").unwrap_or_default(),
            pkg_version(&pkgs, "torch").unwrap_or_default()
        )
    } else {
        let mut missing = Vec::new();
        if !has_torch {
            missing.push("torch");
        }
        if !has_transformers {
            missing.push("transformers");
        }
        if !has_server {
            missing.push("fastapi+uvicorn");
        }
        format!("Eksik paket: {}", missing.join(", "))
    };
    engines.push(Engine {
        id: "python",
        label: "Python (transformers)",
        ready,
        detail,
        bundled: false,
        path: python,
    });

    engines
}

/// llama.cpp'nin GPU arka ucunu bulur ve ortam değişkenlerini döndürür.
///
/// Ollama, CUDA/Vulkan/ROCm arka uçlarını ikilinin yanındaki AYRI klasörlerde
/// getirir (`cuda_v13/ggml-cuda.dll`). `llama-server.exe` bunları kendiliğinden
/// bulamaz ve sessizce CPU'ya düşer (ölçüldü: 8.4 tok/s → 47 tok/s fark).
/// `GGML_BACKEND_PATH`'i doğrudan DLL'e işaret etmek + klasörü PATH'e eklemek
/// (bağımlı `cudart64_*.dll` için) GPU'yu devreye alır.
pub fn gpu_backend_env(exe: &Path) -> Vec<(String, String)> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<(u8, PathBuf, &'static str)> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        let (rank, dll): (u8, &'static str) = if name == "cuda_v13" {
            (0, "ggml-cuda.dll")
        } else if name == "cuda_v12" {
            (1, "ggml-cuda.dll")
        } else if name.starts_with("cuda") {
            (2, "ggml-cuda.dll")
        } else if name == "vulkan" {
            (3, "ggml-vulkan.dll")
        } else if name.starts_with("rocm") {
            (4, "ggml-hip.dll")
        } else {
            continue;
        };
        candidates.push((rank, path, dll));
    }
    candidates.sort_by_key(|(r, _, _)| *r);
    for (_, backend_dir, dll) in candidates {
        let file = backend_dir.join(dll);
        if !file.is_file() {
            continue;
        }
        let mut env = vec![(
            "GGML_BACKEND_PATH".to_string(),
            file.to_string_lossy().to_string(),
        )];
        // Bağımlı CUDA DLL'leri (cudart/cublas) yalnızca PATH üzerinden bulunur.
        let path_value = match std::env::var("PATH") {
            Ok(existing) => format!("{};{}", backend_dir.to_string_lossy(), existing),
            Err(_) => backend_dir.to_string_lossy().to_string(),
        };
        env.push(("PATH".to_string(), path_value));
        return env;
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_returns_known_engines() {
        let engines = detect();
        let ids: Vec<&str> = engines.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["ollama", "llamaserver", "python"]);
        // Tespit bu makinede tamamlanabilmeli (panik yok, JSON üretilebilmeli).
        assert!(engines.iter().all(|e| e.to_json().is_object()));
    }

    #[test]
    fn find_first_respects_depth() {
        let dir = std::env::temp_dir().join("thalamus_engine_depth_test");
        let deep = dir.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();
        let file = deep.join("needle.exe");
        std::fs::write(&file, b"x").unwrap();
        assert!(find_first(&dir, "needle.exe", 1).is_none());
        assert_eq!(find_first(&dir, "needle.exe", 3), Some(file));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

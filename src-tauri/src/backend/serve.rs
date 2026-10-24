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

/// Windows'ta süreci "uykuya" alır: CPU 0'a iner, çalışma kümesi sayfalanır.
/// GPU belleği süreçte kaldığı için VRAM serbest kalmaz; uzun boşlukta süreç
/// tamamen kapatılır. Askıdayken gelen ilk istek `resume` ile anında uyanır.
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type Handle = *mut c_void;
    const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    struct JobBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JobExtendedLimitInformation {
        basic: JobBasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn SetProcessWorkingSetSize(handle: Handle, min: usize, max: usize) -> i32;
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(handle: Handle) -> i32;
        fn NtResumeProcess(handle: Handle) -> i32;
    }

    fn open(pid: u32) -> Handle {
        if pid == 0 {
            return std::ptr::null_mut();
        }
        let access = PROCESS_SUSPEND_RESUME | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION;
        unsafe { OpenProcess(access, 0, pid) }
    }

    /// Uygulama zorla kapansa bile model süreçlerini öldüren job nesnesi.
    /// Tanıtıcı süreç ömrü boyunca açık kalır; kapanınca Windows alt süreçleri
    /// de sonlandırır. Böylece VRAM'de başıboş llama-server kalmaz.
    fn kill_job() -> Option<Handle> {
        static JOB: OnceLock<usize> = OnceLock::new();
        let raw = *JOB.get_or_init(|| {
            let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if job.is_null() {
                return 0;
            }
            let mut info: JobExtendedLimitInformation = unsafe { std::mem::zeroed() };
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JobExtendedLimitInformation>() as u32,
                )
            };
            if ok == 0 {
                unsafe { CloseHandle(job) };
                return 0;
            }
            job as usize
        });
        if raw == 0 {
            None
        } else {
            Some(raw as Handle)
        }
    }

    /// Yönetilen model sürecini "uygulama kapanınca öl" job'ına ekler.
    pub fn kill_on_exit(child: &std::process::Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        let Some(job) = kill_job() else {
            return false;
        };
        unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as Handle) != 0 }
    }

    /// True: süreç askıya alındı ve RAM'i sayfalaması istendi.
    pub fn suspend(pid: u32) -> bool {
        let handle = open(pid);
        if handle.is_null() {
            return false;
        }
        let ok = unsafe { NtSuspendProcess(handle) } == 0;
        if ok {
            // Working set'i küçült: sıcak sayfalar disk/standby'a gider.
            unsafe { SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX) };
        }
        unsafe { CloseHandle(handle) };
        ok
    }

    pub fn resume(pid: u32) -> bool {
        let handle = open(pid);
        if handle.is_null() {
            return false;
        }
        let ok = unsafe { NtResumeProcess(handle) } == 0;
        unsafe { CloseHandle(handle) };
        ok
    }
}

#[cfg(not(windows))]
mod win {
    pub fn suspend(_pid: u32) -> bool {
        false
    }
    pub fn resume(_pid: u32) -> bool {
        false
    }
    pub fn kill_on_exit(_child: &std::process::Child) -> bool {
        false
    }
}

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
    /// Son istek başlangıcı/bitişi. Boşta kapatma bunu kullanır.
    last_used_unix: u64,
    /// Süren istek sayısı; 0 değilken sunucu ASLA boşta kapatılmaz.
    active_requests: u32,
    /// Süreç askıya alındı mı (CPU 0, RAM sayfalandı; GPU VRAM kalır).
    suspended: bool,
    /// İstek bitince kapat: guard düşünce süreç öldürülür (sohbet sonu).
    stop_when_idle: bool,
    log: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<String, Server>> {
    static REG: OnceLock<Mutex<HashMap<String, Server>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Aynı anda iki model süreci başlatılmasını engeller. Model yükleme
/// dakikalar sürebildiği için kilit await boyunca tutulur; ikinci istek
/// bekler ve hazır sunucuyu bulur (çift VRAM tüketimi olmaz).
static SERVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

/// `ollama:ad:etiket` → Ollama manifestindeki gerçek GGUF blob'u.
///
/// Windows + CUDA'da Ollama 0.40, `llama-server`'ı `--load-mode none` ile
/// başlatıyor: 4.7 GB model belleğe kopyalanıyor ve boş RAM azken yükleme
/// 20–50 sn'ye çıkıyor. Aynı blob'u kendi `llama-server`'ımızla mmap ile
/// açınca yükleme ~4–10 sn'ye iniyor. Yalnızca tek parça, projector'suz
/// (görsel olmayan) modeller için kullanılır; aksi halde Ollama'ya düşülür.
fn resolve_ollama_blob(model: &str, hint: Option<&str>) -> Option<PathBuf> {
    fn blob_from_manifest(manifest: &std::path::Path) -> Option<PathBuf> {
        let text = std::fs::read_to_string(manifest).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let layers = v.get("layers")?.as_array()?;
        // Görsel modeller ayrı projector katmanı ister; bu hızlı yolda desteklenmez.
        if layers.iter().any(|l| {
            l.get("mediaType")
                .and_then(|m| m.as_str())
                .map(|m| m.contains("projector"))
                .unwrap_or(false)
        }) {
            return None;
        }
        let mut model_layers = layers.iter().filter(|l| {
            l.get("mediaType")
                .and_then(|m| m.as_str())
                .map(|m| m.ends_with(".model"))
                .unwrap_or(false)
        });
        let layer = model_layers.next()?;
        if model_layers.next().is_some() {
            return None; // parçalı model: llama-server tek blob ile açamaz
        }
        let digest = layer
            .get("digest")?
            .as_str()?
            .strip_prefix("sha256:")?;
        let models_root = manifest
            .ancestors()
            .find(|p| p.file_name().map(|n| n == "manifests").unwrap_or(false))?
            .parent()?;
        let blob = models_root.join("blobs").join(format!("sha256-{}", digest));
        blob.is_file().then_some(blob)
    }

    // Tarama zaten manifest yolunu veriyorsa doğrudan onu kullan.
    if let Some(path) = hint {
        let p = std::path::Path::new(path);
        if p.is_file() {
            if let Some(blob) = blob_from_manifest(p) {
                return Some(blob);
            }
        }
    }

    let root = std::env::var_os("OLLAMA_MODELS")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".ollama").join("models")))?;
    let (repo, tag) = model.rsplit_once(':').unwrap_or((model, "latest"));
    let tag = if tag.is_empty() { "latest" } else { tag };
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return None;
    }
    let rel = match parts.len() {
        1 => format!("registry.ollama.ai/library/{}/{}", parts[0], tag),
        2 => format!("registry.ollama.ai/{}/{}", repo, tag),
        _ => format!("{}/{}", repo, tag),
    };
    blob_from_manifest(&root.join("manifests").join(rel))
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
        tokio::time::sleep(Duration::from_millis(100)).await;
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

fn spawn_logged(
    exe: &PathBuf,
    args: &[String],
    env: &[(String, String)],
    log: &PathBuf,
    kill_on_exit: bool,
) -> Result<Child, String> {
    let out = std::fs::File::create(log).map_err(|e| format!("log dosyası: {}", e))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    // CUDA/Vulkan arka ucu (ggml-cuda.dll) yalnızca kendi klasöründen
    // yüklenebiliyor; Windows'ta PATH tek başına yetmiyor. llama-server'ın
    // çalışma dizinini backend DLL'inin yanına al ki GPU gerçekten kullanılsın.
    if let Some((_, dll)) = env.iter().find(|(k, _)| k == "GGML_BACKEND_PATH") {
        if let Some(dir) = std::path::Path::new(dll).parent() {
            cmd.current_dir(dir);
        }
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(engines::CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("{} başlatılamadı: {}", exe.display(), e))?;
    if kill_on_exit && !win::kill_on_exit(&child) {
        log::warn!(
            "Model süreci uygulama kapanınca öldürülemedi (job nesnesi): pid {}",
            child.id()
        );
    }
    Ok(child)
}

/// Model süreci kaydedilene kadar sahiplik: yükleme hata verirse, istek iptal
/// edilirse veya görev düşerse süreç öldürülür. Aksi halde yarım kalan
/// llama-server arka planda VRAM tutmaya devam ederdi.
struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }
    fn get_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child guard")
    }
    fn id(&self) -> u32 {
        self.0.as_ref().map(Child::id).unwrap_or(0)
    }
    fn take(mut self) -> Child {
        self.0.take().expect("child guard")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let pid = child.id();
            if child.kill().is_err() && pid != 0 {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(engines::CREATE_NO_WINDOW)
                        .status();
                }
            }
            let _ = child.wait();
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Taban URL karşılaştırması: sondaki `/`, `localhost` ↔ `127.0.0.1` ve
/// `/v1` farkı aynı sunucuyu göstermeli. Aksi halde Ollama'da istek "meşgul"
/// sayılmaz ve yanıt sonrası kapatma çalışmaz.
fn norm_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.ends_with("/v1") {
        u.truncate(u.len() - 3);
    }
    u = u.replace("://localhost:", "://127.0.0.1:");
    u
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
        "last_used": s.last_used_unix,
        "active": s.active_requests,
        "suspended": s.suspended,
        "stop_when_idle": s.stop_when_idle,
        "standby_timeout": standby_timeout().as_secs(),
        "idle_timeout": idle_timeout().as_secs(),
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
    let _serial = SERVE_LOCK.lock().await;

    // Zaten çalışıyorsa tekrar başlatma; ölmüş kaydı temizle.
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = reg.get_mut(&id) {
            let alive = match s.child.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(None)),
                // Ollama servisi bizim çocuğumuz değilse canlı kabul et.
                None => s.kind.starts_with("ollama"),
            };
            if alive {
                wake_locked(s);
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
    let (mut kind, mut target, model_name) = if let Some(rest) = id.strip_prefix("ollama:") {
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

    // Ollama modeli tek GGUF blob'u ise llama-server'ı doğrudan mmap ile aç.
    // Ollama'nın Windows CUDA'da `--load-mode none` kullanması, düşük RAM'de
    // 4.7 GB'lık kopya yüzünden 20–50 sn sürüyor; mmap yolu hem RAM'i hem
    // yükleme süresini ciddi biçimde azaltıyor.
    if kind == "ollama" {
        if let Some(blob) = resolve_ollama_blob(&model_name, req.path.as_deref()) {
            log::info!(
                "Ollama modeli hızlı mmap yoluyla açılıyor: {} → {}",
                model_name,
                blob.display()
            );
            kind = "gguf";
            target = blob.to_string_lossy().to_string();
        }
    }

    let log = temp_log_path(&id);

    match kind {
        // ── Ollama: servis ayakta mı, model indirilmiş mi? ──────────────
        "ollama" => {
            // Başka bir yerel model boşta duruyorsa VRAM'i paylaşmasın.
            stop_other_idle_managed(&id);
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
                let mut child = ChildGuard::new(
                    spawn_logged(&exe, &["serve".to_string()], &[], &log, false)
                        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?,
                );
                wait_ready(&client, &base, READY_TIMEOUT_OLLAMA, Some(child.get_mut()), &log)
                    .await
                    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
                let pid = child.id();
                let child = child.take();
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
                    last_used_unix: now_unix(),
                    active_requests: 0,
                    suspended: false,
                    stop_when_idle: false,
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
                last_used_unix: now_unix(),
                active_requests: 0,
                suspended: false,
                stop_when_idle: false,
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
            stop_other_idle_managed(&id);
            let port = free_port().map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            // 8 GB sınıfı dizüstü GPU'larda 8192 bağlam + model VRAM'i taşırıyor.
            // 4096 hem iki modelin sığmasını hem KV kurulumunu hızlandırıyor.
            let ctx = req.ctx.unwrap_or(4096);
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
                // Tek kullanıcı: tek slot hem daha az KV belleği ayırır hem
                // bağlamın tamamını bu isteğe verir (auto böler).
                "-np".into(), "1".into(),
                "--alias".into(), model_name.clone(),
                // Model ağırlıklarını RAM'e kopyalamadan mmap ile aç.
                "--load-mode".into(), "mmap".into(),
                // Boş/ısınma turu ilk yanıtı geciktiriyor; ilk gerçek istek
                // zaten aynı işi yapıyor.
                "--no-warmup".into(),
                "--jinja".into(),
            ];
            // GPU arka ucunu (Ollama'nın getirdiği CUDA/Vulkan klasörleri) bul.
            let gpu_env = engines::gpu_backend_env(&exe);
            let load_started = Instant::now();
            let mut child = ChildGuard::new(
                spawn_logged(&exe, &args, &gpu_env, &log, true)
                    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?,
            );
            let base = format!("http://127.0.0.1:{}/v1", port);
            wait_ready(&client, &base, READY_TIMEOUT_GGUF, Some(child.get_mut()), &log)
                .await
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            log::info!(
                "Yerel model hazır ({} ms): {}",
                load_started.elapsed().as_millis(),
                model_name
            );
            let pid = child.id();
            let child = child.take();
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
                last_used_unix: now_unix(),
                active_requests: 0,
                suspended: false,
                stop_when_idle: false,
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
            stop_other_idle_managed(&id);
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
            let load_started = Instant::now();
            let mut child = ChildGuard::new(
                spawn_logged(
                    &exe,
                    &args,
                    &[("PYTHONUNBUFFERED".to_string(), "1".to_string())],
                    &log,
                    true,
                )
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?,
            );
            let base = format!("http://127.0.0.1:{}/v1", port);
            wait_ready(&client, &base, READY_TIMEOUT_HF, Some(child.get_mut()), &log)
                .await
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            log::info!(
                "Yerel model hazır ({} ms): {}",
                load_started.elapsed().as_millis(),
                model_name
            );
            let pid = child.id();
            let child = child.take();
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
                last_used_unix: now_unix(),
                active_requests: 0,
                suspended: false,
                stop_when_idle: false,
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

/// Boşta kapatma süresi: varsayılan 2 dk, `THALAMUS_LOCAL_IDLE_SECS` ile değişir.
/// Sohbet/görsel yolları zaten yanıt sonunda kapatır; bu, ajan/panel gibi
/// artık kalan yollar için son güvenlik ağıdır.
fn idle_timeout() -> Duration {
    std::env::var("THALAMUS_LOCAL_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s >= 30)
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(120))
}

/// Yalnızca bizim başlattığımız model sunucuları boşta kapatılır. Ollama
/// servisi kullanıcıya ait olabilir; ona dokunmayız.
fn managed_model(kind: &str) -> bool {
    matches!(kind, "gguf" | "hf")
}

/// Kısa boşlukta süreci askıya alma süresi (varsayılan kapalı).
/// Askıya alma VRAM'i serbest bırakmaz; kullanıcı yalnızca cevap sürerken
/// donanım kullanılmasını istediği için varsayılan 0. `THALAMUS_LOCAL_STANDBY_SECS`
/// ile (>=15) açılabilir.
fn standby_timeout() -> Duration {
    std::env::var("THALAMUS_LOCAL_STANDBY_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s == 0 || *s >= 15)
        .map(Duration::from_secs)
        .unwrap_or(Duration::ZERO)
}

fn idle_expired(active: u32, last_used: u64, now: u64, ttl: Duration) -> bool {
    active == 0 && now.saturating_sub(last_used) >= ttl.as_secs()
}

/// Askıdaki süreci uyandır. Başarısızsa istek yine denenir (zaman aşımına düşer).
fn wake_locked(s: &mut Server) {
    // Yeni istek, önceki "bitince kapat" talebini iptal eder.
    s.stop_when_idle = false;
    if !s.suspended {
        return;
    }
    if win::resume(s.pid) {
        s.suspended = false;
        s.last_used_unix = now_unix();
        log::info!("Yerel model uyandı: {}", s.model);
    } else {
        log::warn!("Yerel model uyandırılamadı (pid {}): {}", s.pid, s.model);
    }
}

/// Boşta kalanları askıya al: CPU 0, RAM sayfalanır; süreç/VRAM korunur.
/// Böylece kısa aradan sonra ilk cevap yeniden yükleme olmadan gelir.
fn suspend_idle(ttl: Duration) {
    if ttl.is_zero() {
        return;
    }
    let now = now_unix();
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    for s in reg.values_mut() {
        if !managed_model(s.kind) || s.suspended || s.pid == 0 {
            continue;
        }
        if !idle_expired(s.active_requests, s.last_used_unix, now, ttl) {
            continue;
        }
        if win::suspend(s.pid) {
            s.suspended = true;
            log::info!("Yerel model uykuya alındı (CPU 0): {}", s.model);
        }
    }
}

/// Bir istek sunucuyu "meşgul" işaretler; guard düşünce süre sıfırlanır.
/// Boşta kapatma, süren bir nesli asla ortadan kesmez.
pub struct UseGuard {
    base_url: String,
}

pub fn begin_use(url: &str) -> Option<UseGuard> {
    let target = norm_base(url);
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    for s in reg.values_mut() {
        let base = norm_base(&s.base_url);
        if target == base || target.starts_with(&format!("{}/", base)) {
            wake_locked(s);
            s.active_requests = s.active_requests.saturating_add(1);
            s.last_used_unix = now_unix();
            return Some(UseGuard {
                base_url: s.base_url.clone(),
            });
        }
    }
    None
}

impl Drop for UseGuard {
    fn drop(&mut self) {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        let mut stop_id = None;
        if let Some(s) = reg.values_mut().find(|s| s.base_url == self.base_url) {
            s.active_requests = s.active_requests.saturating_sub(1);
            s.last_used_unix = now_unix();
            // "Yanıt bitince kapat" istendiyse ve başka istek yoksa hemen kapat.
            if s.active_requests == 0 && s.stop_when_idle {
                stop_id = Some(s.id.clone());
            }
        }
        if let Some(id) = stop_id {
            stop_locked(&mut reg, &id, "yanıt bitti");
        }
    }
}

fn stop_locked(reg: &mut HashMap<String, Server>, id: &str, reason: &str) {
    let Some(mut s) = reg.remove(id) else { return };
    if let Some(child) = s.child.as_mut() {
        if child.kill().is_err() && s.pid != 0 {
            // Nadir: TerminateProcess reddedildi. Ağaç hâlinde zorla kapat.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &s.pid.to_string()])
                    .creation_flags(engines::CREATE_NO_WINDOW)
                    .status();
            }
        }
        let _ = child.wait();
    }
    log::info!(
        "Yerel model kapatıldı ({}): {} · {}",
        reason,
        s.label,
        s.model
    );
}

fn collect_reapable(ttl: Duration, only_idle: bool) -> Vec<String> {
    let now = now_unix();
    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.iter()
        .filter(|(_, s)| {
            managed_model(s.kind)
                && if only_idle {
                    idle_expired(s.active_requests, s.last_used_unix, now, ttl)
                } else {
                    s.active_requests == 0
                }
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// Boşta kalan model sunucularını kapat (süren istek varsa dokunma).
fn reap_idle(ttl: Duration) {
    let ids = collect_reapable(ttl, true);
    if ids.is_empty() {
        return;
    }
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    for id in ids {
        stop_locked(&mut reg, &id, "boşta");
    }
}

/// Yeni bir model yüklenirken, başka boşta duran yönetilen modelleri kapat:
/// tek GPU'da iki model bellekte kalmasın. Meşgul olanlara dokunulmaz.
fn stop_other_idle_managed(except: &str) {
    let ids: Vec<String> = collect_reapable(Duration::ZERO, false)
        .into_iter()
        .filter(|id| id != except)
        .collect();
    if ids.is_empty() {
        return;
    }
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    for id in ids {
        stop_locked(&mut reg, &id, "başka model yüklendi");
    }
}

/// Arka plan: her 15 sn'de boşta kalan modelleri kapatır.
pub async fn idle_monitor() {
    let ttl = idle_timeout();
    let standby = standby_timeout();
    if standby.is_zero() {
        log::info!("Yerel model politikası: uyku kapalı, {} sn sonra kapatma", ttl.as_secs());
    } else {
        log::info!(
            "Yerel model politikası: {} sn sonra uyku, {} sn sonra kapatma",
            standby.as_secs(),
            ttl.as_secs()
        );
    }
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        suspend_idle(standby);
        reap_idle(ttl);
    }
}

/// POST /api/ai/serve/stop — bu modülün başlattığı bir sunucuyu durdurur.
/// `when_idle: true` ise süren istek varsa hemen öldürmez; istek bitince kapatır.
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
    let when_idle = req
        .get("when_idle")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let Some(info) = reg.get(&id).map(|s| {
        (
            s.kind,
            s.base_url.clone(),
            s.model.clone(),
            s.active_requests,
            s.child.is_some(),
        )
    }) else {
        return Ok(Json(json!({ "stopped": false, "reason": "çalışmıyor" })));
    };
    let (kind, base, model, active, has_child) = info;
    // Ollama'da "durdurma" modeli VRAM'den boşaltmak demek; servisi öldürme.
    if kind.starts_with("ollama") && !has_child {
        drop(reg);
        tokio::spawn(async move {
            let _ = unload_model(Json(json!({ "base_url": base, "model": model }))).await;
        });
        return Ok(Json(json!({ "stopped": true, "id": id, "unloaded": true })));
    }
    if when_idle && active > 0 {
        if let Some(s) = reg.get_mut(&id) {
            s.stop_when_idle = true;
        }
        return Ok(Json(json!({ "stopped": false, "queued": true, "id": id })));
    }
    stop_locked(&mut reg, &id, "istek üzerine");
    Ok(Json(json!({ "stopped": true, "id": id })))
}

/// POST /api/ai/serve/unload — Ollama modelini VRAM'den boşaltır (servisi
/// kapatmadan). Yanıt sonrası donanımı serbest bırakmak için kullanılır.
pub async fn unload_model(Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let base = req
        .get("base_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let model = req
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if model.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Model adı boş.".into()));
    }
    // Yalnızca yerel Ollama; rastgele adrese istek atılmasın.
    let ollama_root = base.strip_suffix("/v1").unwrap_or(&base).to_string();
    if !(ollama_root.starts_with("http://127.0.0.1:11434")
        || ollama_root.starts_with("http://localhost:11434"))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Bu uç nokta boşaltmayı desteklemiyor.".into(),
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Model zaten yüklü değilse boşaltma isteği gönderme (tekrar yüklemesin).
    let mut loaded = false;
    if let Ok(resp) = client.get(format!("{}/api/ps", ollama_root)).send().await {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<Value>().await {
                loaded = v
                    .get("models")
                    .and_then(|m| m.as_array())
                    .map(|models| {
                        models.iter().any(|m| {
                            m.get("name")
                                .or_else(|| m.get("model"))
                                .and_then(|n| n.as_str())
                                .map(|n| {
                                    n == model
                                        || n == format!("{}:latest", model)
                                        || model == format!("{}:latest", n)
                                })
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
            }
        }
    }

    if loaded {
        let _ = client
            .post(format!("{}/api/generate", ollama_root))
            .json(&json!({ "model": model, "keep_alive": 0 }))
            .send()
            .await;
        log::info!("Ollama modeli VRAM'den boşaltıldı: {}", model);
    }
    // Yüklü kaydı listeden düşür.
    let base_norm = norm_base(&base);
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.retain(|_, s| !(s.kind.starts_with("ollama") && norm_base(&s.base_url) == base_norm));
    Ok(Json(json!({ "unloaded": loaded })))
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
    fn base_url_matching_normalizes_loopback_and_v1() {
        assert_eq!(
            norm_base("http://localhost:11434/v1/"),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            norm_base("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            norm_base("http://127.0.0.1:11500/v1/"),
            "http://127.0.0.1:11500"
        );
    }

    #[cfg(windows)]
    #[test]
    fn managed_child_joins_kill_job() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("dummy process");
        let assigned = win::kill_on_exit(&child);
        let _ = child.kill();
        let _ = child.wait();
        assert!(assigned, "AssignProcessToJobObject başarısız");
    }

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

    #[test]
    fn only_spawned_model_servers_are_reaped() {
        assert!(managed_model("gguf"));
        assert!(managed_model("hf"));
        // Kullanıcının kendi Ollama servisi boşta kapatılmaz.
        assert!(!managed_model("ollama"));
        assert!(!managed_model("ollama-service"));
    }

    #[test]
    fn idle_reap_respects_active_requests_and_ttl() {
        let ttl = Duration::from_secs(300);
        // Süren istek varken TTL dolmuş olsa bile kapatma.
        assert!(!idle_expired(1, 0, 10_000, ttl));
        // TTL dolmadı.
        assert!(!idle_expired(0, 9_900, 10_000, ttl));
        // Tam sınırda ve üzerinde kapat.
        assert!(idle_expired(0, 9_700, 10_000, ttl));
        assert!(idle_expired(0, 0, 10_000, ttl));
    }

    #[cfg(windows)]
    #[test]
    fn suspend_resume_roundtrip() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 20 127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("dummy process");
        std::thread::sleep(Duration::from_millis(200));
        assert!(win::suspend(child.id()));
        assert!(child.try_wait().unwrap().is_none());
        assert!(win::resume(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    fn idle_suspend_and_wake_on_use() {
        use std::process::{Command, Stdio};
        let id = "test:standby";
        let base = "http://127.0.0.1:59998/v1";
        let child = Command::new("cmd")
            .args(["/C", "ping -n 20 127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("dummy process");
        let pid = child.id();
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                Server {
                    id: id.to_string(),
                    kind: "gguf",
                    label: "test".into(),
                    model: "test".into(),
                    base_url: base.to_string(),
                    port: 59998,
                    pid,
                    child: Some(child),
                    started_unix: 0,
                    last_used_unix: 0,
                    active_requests: 0,
                    suspended: false,
                    stop_when_idle: false,
                    log: PathBuf::from("test.log"),
                },
            );

        suspend_idle(Duration::from_secs(1));
        {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            assert!(reg.get(id).unwrap().suspended);
        }
        let guard = begin_use(&format!("{}/chat/completions", base)).expect("guard");
        {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            assert!(!reg.get(id).unwrap().suspended);
        }
        drop(guard);

        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut s) = reg.remove(id) {
            if let Some(mut child) = s.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn stop_when_idle_waits_for_last_request() {
        use std::process::{Command, Stdio};
        let id = "test:close-after";
        let base = "http://127.0.0.1:59997/v1";
        let child = Command::new("cmd")
            .args(["/C", "ping -n 20 127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("dummy process");
        let pid = child.id();
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                Server {
                    id: id.to_string(),
                    kind: "gguf",
                    label: "test".into(),
                    model: "test".into(),
                    base_url: base.to_string(),
                    port: 59997,
                    pid,
                    child: Some(child),
                    started_unix: 0,
                    last_used_unix: 0,
                    active_requests: 0,
                    suspended: false,
                    stop_when_idle: false,
                    log: PathBuf::from("test.log"),
                },
            );

        let g1 = begin_use(&format!("{}/chat/completions", base)).expect("guard 1");
        let g2 = begin_use(&format!("{}/chat/completions", base)).expect("guard 2");
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(id)
            .unwrap()
            .stop_when_idle = true;

        drop(g1);
        assert!(registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id));
        drop(g2);
        assert!(!registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id));
    }

    #[test]
    fn use_guard_marks_server_busy_until_drop() {
        let id = "test:use-guard";
        let base = "http://127.0.0.1:59999/v1";
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                Server {
                    id: id.to_string(),
                    kind: "gguf",
                    label: "test".into(),
                    model: "test".into(),
                    base_url: base.to_string(),
                    port: 59999,
                    pid: 0,
                    child: None,
                    started_unix: 0,
                    last_used_unix: 0,
                    active_requests: 0,
                    suspended: false,
                    stop_when_idle: false,
                    log: PathBuf::from("test.log"),
                },
            );

        let guard = begin_use(&format!("{}/chat/completions", base)).expect("guard");
        {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(reg.get(id).unwrap().active_requests, 1);
            // Boşta kapatma meşgul sunucuya dokunamaz.
            assert!(!idle_expired(1, 0, 10_000, Duration::from_secs(1)));
        }
        drop(guard);
        {
            let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(reg.get(id).unwrap().active_requests, 0);
            reg.remove(id);
        }
    }
}

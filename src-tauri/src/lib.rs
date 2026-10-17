use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use tauri::{Emitter, State};
use tiktoken_rs::cl100k_base;

mod backend;
mod engine;
mod secrets;

pub use engine::{CompressionMetrics, JsonCompressor};

/// Aktif terminal oturumu: PTY master + writer + alt süreç.
pub struct TerminalSession {
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct AppState {
    /// Aktif PTY terminal oturumu; yeni terminal başlatılırken eskisi öldürülür.
    pub terminal: Arc<Mutex<Option<TerminalSession>>>,
    pub bpe: Arc<tiktoken_rs::CoreBPE>,
    /// Tüm dosya işlemlerinin güvenli tabanı (ayarlanabilir workspace root).
    pub workspace_root: Arc<RwLock<String>>,
    /// HTTP backend başlatma sonucu (bind hatası buradan raporlanır).
    pub backend_status: backend::BackendStatus,
}

#[derive(Serialize)]
pub struct InitContext {
    pub current_dir: String,
    pub file_count: usize,
}

#[derive(Serialize)]
pub struct EngineStatus {
    pub is_ready: bool,
    pub model_loaded: bool,
    pub model_path: Option<String>,
    pub info: String,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
    pub file_count: usize,
}

// ---------------------------------------------------------------------------
// Workspace root yardımcıları
// ---------------------------------------------------------------------------

/// Windows'ta `canonicalize()`'in ürettiği `\\?\` uzun-yol önekini gösterim
/// ve config için temizler; diğer platformlarda olduğu gibi döner.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    #[cfg(windows)]
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    s
}

// ---------------------------------------------------------------------------
// Config dosyası: her zaman app-data dizininde tutulur (paketlenmiş Windows
// uygulamasında CWD genelde Program Files olduğu için oraya yazılamaz).
// ---------------------------------------------------------------------------

/// Config dosyasının tam yolu. Öncelik: `THALAMUS_CONFIG_DIR` env'i, sonra
/// OS app-data (`%APPDATA%\com.thalamus.desktop`), en son CWD (fallback).
fn config_path() -> PathBuf {
    let dir = env::var_os("THALAMUS_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|d| d.join("com.thalamus.desktop")))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf()));
    let _ = fs::create_dir_all(&dir);
    dir.join("thalamus_config.json")
}

/// Eski sürümler config'i CWD'ye yazıyordu; geçerli bir dosya varsa yeni
/// konuma bir kez taşınır.
fn migrate_legacy_config() {
    let new_path = config_path();
    if new_path.exists() {
        return;
    }
    let legacy = env::current_dir()
        .ok()
        .map(|d| d.join("thalamus_config.json"));
    if let Some(legacy) = legacy {
        if legacy.exists() && legacy != new_path {
            if let Ok(content) = fs::read_to_string(&legacy) {
                let _ = fs::write(&new_path, content);
            }
        }
    }
}

/// Config dosyasından kayıtlı workspace root'u yükler (geçerli bir klasörse).
fn load_workspace_root_from_config() -> Option<String> {
    let config_path = config_path();
    if config_path.exists() {
        if let Ok(config_str) = fs::read_to_string(config_path) {
            if let Ok(config_val) = serde_json::from_str::<serde_json::Value>(&config_str) {
                if let Some(root) = config_val["workspace_root"].as_str() {
                    let p = Path::new(root);
                    if p.is_dir() {
                        if let Ok(canon) = p.canonicalize() {
                            return Some(display_path(&canon));
                        }
                        return Some(root.to_string());
                    }
                }
            }
        }
    }
    None
}

fn default_workspace_root() -> String {
    if let Some(root) = load_workspace_root_from_config() {
        return root;
    }
    env::current_dir()
        .unwrap_or_else(|_| Path::new(".").to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn workspace_base(state: &AppState) -> PathBuf {
    PathBuf::from(
        state
            .workspace_root
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    )
}

fn build_workspace_info(root_dir: &Path) -> WorkspaceInfo {
    let name = root_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());
    let mut file_count = 0;
    let _ = count_files(root_dir, &mut file_count);
    WorkspaceInfo {
        root: root_dir.to_string_lossy().to_string(),
        name,
        file_count,
    }
}

/// Dizin adlari: agir/alakasiz klasorler taranmaz. Acilis suresi ve file_count
/// anlami icin node_modules/target/.git gibi agaclar sayilmaz (repo_map ile ayni mantik).
const COUNT_SKIP_DIRS: [&str; 12] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
    "vendor",
    ".idea",
];

/// Bir workspace icin sayilan dosya ust siniri: 200k dosyali bir agacta
/// acilis beklenmez, sayim yeterli bilgi verir.
const COUNT_FILES_CAP: usize = 100_000;

fn count_files(dir: &Path, count: &mut usize) -> std::io::Result<()> {
    if *count >= COUNT_FILES_CAP {
        return Ok(());
    }
    if dir.is_dir() {
        for entry in fs::read_dir(dir)? {
            if *count >= COUNT_FILES_CAP {
                return Ok(());
            }
            let entry = entry?;
            let path = entry.path();
            let ty = entry.file_type()?;
            if ty.is_file() {
                *count += 1;
            } else if ty.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if COUNT_SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                count_files(&path, count)?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Güvenli dosya erişimi: tüm okuma/yazma/taşıma işlemleri workspace root içine
// kilitlenir (path-traversal koruması).
// ---------------------------------------------------------------------------
fn is_safe_path(path_str: &str, base: &Path) -> Result<PathBuf, String> {
    let base_canonical = base
        .canonicalize()
        .map_err(|e| format!("Could not resolve working directory: {}", e))?;

    let target = Path::new(path_str);
    let absolute_target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        base_canonical.join(target)
    };

    // G1: `..` bileşenini kontrol ÖNCESİNDE reddet. Olmayan hedeflerde yalnızca
    // en yakın var ata denetleniyordu; `ws\..\..\evil.txt` ilk var atası kök
    // içinde kaldığı için geçip OS'te kök dışına çözülebiliyordu.
    if absolute_target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Security violation: path cannot contain '..' components.".to_string());
    }

    if absolute_target.exists() {
        let canonical_target = absolute_target
            .canonicalize()
            .map_err(|e| format!("Could not resolve target path: {}", e))?;
        if canonical_target.starts_with(&base_canonical) {
            return Ok(canonical_target);
        }
    } else {
        let mut ancestor = absolute_target.as_path();
        while let Some(parent) = ancestor.parent() {
            if parent.exists() {
                let canonical_parent = parent
                    .canonicalize()
                    .map_err(|e| format!("Could not resolve ancestor directory: {}", e))?;
                if canonical_parent.starts_with(&base_canonical) {
                    return Ok(absolute_target);
                } else {
                    return Err("Security violation: directory access denied.".to_string());
                }
            }
            ancestor = parent;
        }
    }

    Err("Security violation: directory access denied.".to_string())
}

// ---------------------------------------------------------------------------
// Tauri komutları
// ---------------------------------------------------------------------------

#[tauri::command]
fn thalamus_get_engine_status(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    // HTTP backend başlatılamadıysa bunu dürüstçe raporla — motor hazır
    // desem arayüz boşuna "aktif" sanır.
    if let Some(Err(e)) = state
        .backend_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Ok(EngineStatus {
            is_ready: false,
            model_loaded: false,
            model_path: None,
            info: format!("HTTP backend failed to start: {}", e),
        });
    }
    // Yerel sıkıştırma motoru model gerektirmediği için her zaman hazırdır.
    Ok(EngineStatus {
        is_ready: true,
        model_loaded: true,
        model_path: None,
        info: "Local compression engine active (no ONNX required)".to_string(),
    })
}

#[tauri::command]
fn thalamus_compress_prompt(
    prompt: String,
    veto_override: bool,
    state: State<'_, AppState>,
) -> Result<CompressionMetrics, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt text cannot be empty.".to_string());
    }

    let bpe = &state.bpe;
    Ok(engine::process_with_metrics(&prompt, bpe, veto_override))
}

/// Duzenleyici okumasi icin bayt ust siniri: cok buyuk dosya textarea'yi
/// kilitler. Asilirsa net bir hata doner (AI araciyla ayni limit: 200 KB).
const MAX_EDITOR_READ_BYTES: u64 = 200_000;

#[tauri::command]
fn thalamus_read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let base = workspace_base(&state);
    let safe_path = is_safe_path(&path, &base)?;

    // Boyut kontrolu okumadan once: 1 GB'lik bir dosyayi string'e cevirmeye
    // calismak UI'i kilitler.
    let meta = fs::metadata(&safe_path).map_err(|e| format!("Could not read file: {}", e))?;
    if meta.is_dir() {
        return Err("The given path is a directory, not a file.".to_string());
    }
    if meta.len() > MAX_EDITOR_READ_BYTES {
        return Err(format!(
            "File is too large for the editor ({} KB, limit {} KB). Open it externally.",
            meta.len() / 1024,
            MAX_EDITOR_READ_BYTES / 1024
        ));
    }

    fs::read_to_string(safe_path).map_err(|e| format!("Could not read file: {}", e))
}

#[tauri::command]
fn thalamus_write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let base = workspace_base(&state);
    let safe_path = is_safe_path(&path, &base)?;
    if let Some(parent) = safe_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(safe_path, content).map_err(|e| format!("Could not write file: {}", e))
}

#[tauri::command]
fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<DirEntry>, String> {
    let base = workspace_base(&state);
    let safe_path = is_safe_path(&path, &base)?;
    if !safe_path.is_dir() {
        return Err("The given path is not a directory.".to_string());
    }

    // Agir klasorler agacta hic gorunmez (on yuzdeki FILTERED_DIRS ile ayni
    // mantik): IPC yuku ve agac boyutu dusar, kullanici deneyimi degismez.
    const SKIP_DIRS: [&str; 8] = [
        "node_modules",
        "target",
        "dist",
        ".git",
        ".vscode",
        "__pycache__",
        "src_backup_before_copy",
        ".cache",
    ];
    // Tek klasorde ust sinir: binlerce girdili bir dizin agaci kilitlemesin.
    const MAX_ENTRIES: usize = 2000;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&safe_path).map_err(|e| format!("Could not read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Could not read entry: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let ft = entry
            .file_type()
            .map_err(|e| format!("Could not read entry type: {}", e))?;
        if ft.is_dir() && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            is_dir: ft.is_dir(),
        });
    }

    // Klasörler önce, sonra ada göre (büyük/küçük harf duyarsız)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    if entries.len() > MAX_ENTRIES {
        entries.truncate(MAX_ENTRIES);
    }

    Ok(entries)
}

#[tauri::command]
fn create_entry(path: String, is_dir: bool, state: State<'_, AppState>) -> Result<(), String> {
    let base = workspace_base(&state);
    let safe_path = is_safe_path(&path, &base)?;

    if safe_path.exists() {
        return Err("An entry with this name already exists.".to_string());
    }

    if is_dir {
        fs::create_dir_all(&safe_path).map_err(|e| format!("Could not create directory: {}", e))?;
    } else {
        if let Some(parent) = safe_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&safe_path, "").map_err(|e| format!("Could not create file: {}", e))?;
    }

    Ok(())
}

/// Bir klasörü hedefe özyinelemeli kopyalar (sürücüler arası taşıma fallback'i).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn move_entry(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let base = workspace_base(&state);
    let src = is_safe_path(&from, &base)?;
    let dst = is_safe_path(&to, &base)?;

    if !src.exists() {
        return Err("Source not found.".to_string());
    }
    if dst.exists() {
        return Err("An entry with this name already exists at the target.".to_string());
    }

    // Hızlı yol: aynı birimde atomik rename. Başarısız olursa (farklı sürücü,
    // kilitli dosya vb.) kopyala + sil ile devam et.
    if fs::rename(&src, &dst).is_ok() {
        return Ok(());
    }

    let moved = if src.is_dir() {
        copy_dir_recursive(&src, &dst).and_then(|_| fs::remove_dir_all(&src))
    } else {
        fs::copy(&src, &dst).and_then(|_| fs::remove_file(&src))
    };
    moved.map_err(|e| format!("Move failed: {}", e))
}

/// D9: canonicalize Windows'ta `\\?\` verbatim ön-eki üretir; VisualBasic
/// FileIO bu öneki desteklemez ve sessizce patlayarak delete_entry'yi kalıcı
/// silmeye düşürüyordu (kullanıcıya "çöp kutusuna taşındı" denirken dosya
/// tamamen siliniyordu). Çöp kutusu çağrısı önceden önek sökülür.
#[cfg(windows)]
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", rest))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Öğeyi OS çöp kutusuna gönderir (Windows: PowerShell + VisualBasic
/// FileIO). Crate bağımlılığı olmadan recycle-bin desteği sağlar.
#[cfg(windows)]
fn send_to_recycle_bin(path: &Path) -> Result<(), String> {
    let path = strip_verbatim_prefix(path);
    // Tek tırnakları PowerShell literal'i için escape'le
    let ps_path = path.to_string_lossy().replace('\'', "''");
    let api = if path.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{}('{}', 'OnlyErrorDialogs', 'SendToRecycleBin')",
        api, ps_path
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("Could not start PowerShell: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(windows))]
fn send_to_recycle_bin(_path: &Path) -> Result<(), String> {
    Err("Recycle bin is not supported on this platform.".to_string())
}

/// Öğeyi çöp kutusuna gönderir; çöp kutusu kullanılamazsa kalıcı silmeye
/// düşer ve hatada her iki sebebi de bildirir.
///
/// D9 (dürüstlük): başarıda kullanılan yolu bildirir — "recycled" veya
/// "permanently_deleted". UI buna göre konuşur; kalıcı silme yaşandıysa
/// "çöp kutusuna taşındı" YALANI söylenmez.
#[tauri::command]
fn delete_entry(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let base = workspace_base(&state);
    let safe_path = is_safe_path(&path, &base)?;

    if !safe_path.exists() {
        return Err("Item to delete not found.".to_string());
    }

    match send_to_recycle_bin(&safe_path) {
        Ok(()) => Ok("recycled".to_string()),
        Err(trash_err) => {
            let res = if safe_path.is_dir() {
                fs::remove_dir_all(&safe_path)
            } else {
                fs::remove_file(&safe_path)
            };
            match res {
                Ok(()) => Ok(format!(
                    "permanently_deleted (recycle bin unavailable: {})",
                    trash_err
                )),
                Err(e) => Err(format!(
                    "Delete failed (recycle bin: {}; permanent delete: {})",
                    trash_err, e
                )),
            }
        }
    }
}

#[tauri::command]
fn set_workspace_root(path: String, state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("The given path was not found.".to_string());
    }
    if !p.is_dir() {
        return Err("The given path is not a directory.".to_string());
    }

    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Could not resolve path: {}", e))?;
    let root_str = display_path(&canonical);
    *state
        .workspace_root
        .write()
        .unwrap_or_else(|e| e.into_inner()) = root_str.clone();

    // Config'e kalıcı olarak yaz (mevcut ayarları bozmadan)
    let config_path = config_path();
    let mut config_val = serde_json::json!({});
    if config_path.exists() {
        if let Ok(s) = fs::read_to_string(&config_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                config_val = v;
            }
        }
    }
    config_val["workspace_root"] = serde_json::Value::String(root_str.clone());
    let _ = fs::write(
        &config_path,
        serde_json::to_string_pretty(&config_val).unwrap_or_default(),
    );

    Ok(build_workspace_info(Path::new(&root_str)))
}

/// Ayarları sıfırlarken backend config dosyasını da siler. Aksi halde
/// `workspace_root` (%APPDATA%\com.thalamus.desktop) yerinde kalır ve bir
/// sonraki açılışta "sıfırlandı" denen ayar geri gelir.
#[tauri::command]
fn reset_app_config(state: State<'_, AppState>) -> Result<(), String> {
    let p = config_path();
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("Config could not be removed: {}", e))?;
    }
    let fresh = default_workspace_root();
    *state.workspace_root.write().unwrap_or_else(|e| e.into_inner()) = fresh;
    Ok(())
}

/// C9: son kullanılan projeler listesindeki klasörlerin hâlâ var olup
/// olmadığını denetlemek için kullanılır (yalnızca var/yok bildirir).
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn get_workspace_info(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    let root = state
        .workspace_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    Ok(build_workspace_info(Path::new(&root)))
}

// ---------------------------------------------------------------------------
// Terminal: gerçek PTY (Windows'ta ConPTY). ANSI/renk ve vim gibi interaktif
// programlar çalışır; çıktı UTF-8 güvenli şekilde akıtılır.
// ---------------------------------------------------------------------------

/// Parçalı gelen PTY çıktısını UTF-8 güvenli birleştirir: chunk sınırında
/// bölünen çok-baytlı karakterler bir sonraki parçayla tamamlanır; gerçekten
/// geçersiz baytlar replacement karakteriyle düşürülür (akış tıkanmaz).
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or(""));
                        self.pending.drain(..valid);
                    }
                    match e.error_len() {
                        // Eksik (bölünmüş) dizi: kalanı sonraki chunk'la tamamla
                        None => break,
                        // Gerçekten geçersiz bayt: düşür ve devam et
                        Some(_) => {
                            self.pending.remove(0);
                            out.push('\u{FFFD}');
                        }
                    }
                }
            }
        }
        // Tek bir dizi 4 KB'yi aşıyorsa geçersizdir — kaybı kabul edip tıkanmayı önle
        if self.pending.len() > 4096 {
            out.push_str(&String::from_utf8_lossy(&self.pending));
            self.pending.clear();
        }
        out
    }
}

/// PTY çocuğunu kapatırken SÜREÇ AĞACINI öldürür. Windows ConPTY'de düz
/// `child.kill()` yalnız doğrudan süreci (powershell.exe) öldürür; terminalde
/// başlatılan alt süreçler (dev-server, node, python… ) yetim kalıp sızar.
/// `taskkill /T /F` tüm ağacı kapatır. Diğer platformlarda normal kill yeterli.
fn kill_child_tree(child: &mut Box<dyn portable_pty::Child + Send + Sync>) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.process_id() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            return;
        }
    }
    let _ = child.kill();
}

#[tauri::command]
fn start_terminal(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<InitContext, String> {
    let base = workspace_base(&state);

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open PTY: {}", e))?;

    let mut cmd = portable_pty::CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.cwd(&base);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Could not start terminal: {}", e))?;

    // Slave tarafı kopyalandıktan sonra kapatılır ki okuma akışı EOF alabilsin.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not take PTY reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not take PTY writer: {}", e))?;

    // Es/kuşak sızıntısını önlemek için önceki terminal oturumunu kapat.
    {
        let mut slot = state.terminal.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut prev) = slot.take() {
            kill_child_tree(&mut prev.child);
        }
        *slot = Some(TerminalSession {
            master: pair.master,
            writer,
            child,
        });
    }

    // Çıktı dinleyici thread — UTF-8 güvenli akış
    let handle_out = app_handle.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut stream = Utf8Stream::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = stream.push(&buf[..n]);
                    if !data.is_empty() {
                        let _ = handle_out.emit("terminal-data", data);
                    }
                }
                _ => break,
            }
        }
    });

    let mut file_count = 0;
    let _ = count_files(&base, &mut file_count);

    Ok(InitContext {
        current_dir: display_path(&base),
        file_count,
    })
}

#[tauri::command]
fn write_terminal(data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.terminal.lock().unwrap_or_else(|e| e.into_inner());
    let session = slot
        .as_mut()
        .ok_or_else(|| "Terminal has not been started yet.".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_terminal(rows: u16, cols: u16, state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.terminal.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = slot.as_ref() {
        session
            .master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Could not resize terminal: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn close_terminal(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(mut session) = state
        .terminal
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        kill_child_tree(&mut session.child);
    }
    Ok(())
}

#[tauri::command]
fn thalamus_save_config(config_json: String) -> Result<(), String> {
    let config_path = config_path();
    fs::write(config_path, config_json).map_err(|e| format!("Ayarlar kaydedilemedi: {}", e))
}

#[tauri::command]
fn thalamus_load_config() -> Result<String, String> {
    let config_path = config_path();
    if config_path.exists() {
        fs::read_to_string(config_path).map_err(|e| format!("Could not read settings: {}", e))
    } else {
        Ok("{}".to_string())
    }
}

// ---------------------------------------------------------------------------
// API anahtarı deposu: OS Credential Manager (düz metin localStorage değil).
// ---------------------------------------------------------------------------

#[tauri::command]
fn secret_set(provider: String, secret: String) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("Provider name cannot be empty.".to_string());
    }
    secrets::imp::secret_set(provider.trim(), &secret)
}

#[tauri::command]
fn secret_get(provider: String) -> Result<Option<String>, String> {
    secrets::imp::secret_get(provider.trim())
}

#[tauri::command]
fn secret_delete(provider: String) -> Result<(), String> {
    secrets::imp::secret_delete(provider.trim())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Eski CWD config'i varsa app-data altına taşı.
    migrate_legacy_config();

    // Yerel motor her zaman hazır olduğundan model yükleme thread'ine gerek yok.
    let workspace_root = Arc::new(RwLock::new(default_workspace_root()));

    let bpe = Arc::new(cl100k_base().expect("Failed to load BPE tokenizer"));

    // HTTP backend (her zaman): tarayıcı önizlemesi ve masaüstü için 127.0.0.1:<port>.
    // Workspace root paylaşılır → repo map diskten okuyabilir.
    let backend_status = backend::serve(bpe.clone(), workspace_root.clone());

    // `cargo run -- --serve-only` → pencere açmadan yalnızca HTTP sunucusu.
    // (tarayıcı + `npm run dev` ile kullanmak için)
    let serve_only = std::env::args().any(|a| a == "--serve-only");
    if serve_only {
        let (_tx, rx) = std::sync::mpsc::channel::<()>();
        while rx.recv().is_ok() {}
        return;
    }

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Uygulama logları Info'da kalır; kütüphane gürültüsü (reqwest,
                // hyper, axum, portable_pty TRACE/DEBUG) tamamen kesilir.
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(AppState {
            terminal: Arc::new(Mutex::new(None)),
            bpe,
            workspace_root,
            backend_status,
        })
        // T1 close-guard: pencere X / Alt+F4 kapatmayı sorunsuz kapatır;
        // webview'daki kirli-editör kontrolü destroy() ile asıl kapanışı yapar.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            thalamus_get_engine_status,
            thalamus_compress_prompt,
            thalamus_read_file,
            thalamus_write_file,
            list_dir,
            create_entry,
            move_entry,
            delete_entry,
            set_workspace_root,
            get_workspace_info,
            path_is_dir,
            reset_app_config,
            thalamus_save_config,
            thalamus_load_config,
            secret_set,
            secret_get,
            secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_safe_path() {
        let base = env::current_dir().unwrap().canonicalize().unwrap();

        // 1. Workspace içindeki güvenli hedef
        let safe_target = base.join("Cargo.toml");
        assert!(is_safe_path(safe_target.to_str().unwrap(), &base).is_ok());

        // 2. Workspace sınırının dışına çıkma girişimi
        let unsafe_target = base.join("../../../Windows/System32/cmd.exe");
        assert!(is_safe_path(unsafe_target.to_str().unwrap(), &base).is_err());

        // 3. Workspace içinde henüz var olmayan yeni dosya hedefi
        let new_file = base.join("src/nonexistent_test_file.tmp");
        assert!(is_safe_path(new_file.to_str().unwrap(), &base).is_ok());

        // 4. Workspace içindeki göreceli yollar
        assert!(is_safe_path("Cargo.toml", &base).is_ok());
        assert!(is_safe_path("src/lib.rs", &base).is_ok());
    }

    #[test]
    fn test_sanitize_json_string() {
        let input = "{\"a\": \"line1\nline2\"}";
        let sanitized = engine::sanitize_json_string(input);
        assert!(!sanitized.contains('\n'));
        assert!(sanitized.contains("\\n"));
    }

    #[test]
    fn test_utf8_stream_splits_multibyte_chars() {
        let mut stream = Utf8Stream::new();
        // 'ğ' = [0xC4, 0x9F]: chunk sınırında bölünen karakter bozulmadan
        // birleşmeli.
        let first = stream.push(&[0xC4]);
        assert_eq!(first, "");
        let second = stream.push(&[0x9F]);
        assert_eq!(second, "ğ");
    }

    #[test]
    fn test_utf8_stream_invalid_byte_is_replaced() {
        let mut stream = Utf8Stream::new();
        let out = stream.push(&[0x61, 0xFF, 0x62]);
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn test_utf8_stream_ascii_passes_through() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.push(b"hello "), "hello ");
        assert_eq!(stream.push(b"world"), "world");
    }

    #[test]
    fn test_config_path_respects_env_override() {
        // THALAMUS_CONFIG_DIR tanımlıysa config dosyası orada aranır/yazılır
        // (--serve-only ve test ortamı için gerekli davranış).
        let tmp = std::env::temp_dir().join("thalamus_cfg_test_override_dir");
        let _ = fs::remove_dir_all(&tmp);
        env::set_var("THALAMUS_CONFIG_DIR", &tmp);

        let p = config_path();
        assert_eq!(p.parent().map(|d| d.to_path_buf()), Some(tmp.clone()));
        assert!(p.file_name().unwrap() == "thalamus_config.json");
        assert!(tmp.exists(), "config dizini otomatik oluşturulmalı");

        env::remove_var("THALAMUS_CONFIG_DIR");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_copy_dir_recursive_round_trip() {
        let base = std::env::temp_dir().join("thalamus_copy_dir_test");
        let src = base.join("src_dir");
        let dst = base.join("dst_dir");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("a.txt"), "alpha").unwrap();
        fs::write(src.join("nested").join("b.txt"), "beta").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "alpha");
        assert_eq!(
            fs::read_to_string(dst.join("nested").join("b.txt")).unwrap(),
            "beta"
        );
        let _ = fs::remove_dir_all(&base);
    }
}

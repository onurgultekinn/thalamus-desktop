// Ajan ARAÇ KAYIT SİSTEMİ (backend, yerel).
//
// Şu an tool-loop'un tek aracı `get_code_body` idi; gerçek bir kodlama ajanı
// için dosya/arama/listeleme araçları gerekir (ZCode/Cline ekolü). Bu modül
// araçları TEK yerde tanımlar: modele giden spec + yerel yürütme.
//
// Güvenlik: tüm yollar workspace köküne SABİTLENİR (kök dışına çıkış reddedilir,
// canonicalize ile symlink/.. çözülür). Çıktılar boyutla sınırlanır; ajan
// patlamasın diye. Ağ erişen araç YOK (yalnız yerel dosya sistemi).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::engine::edits;

/// edit_file/write_file araçlarının kaydettiği düzenleme. Araç diske YAZMAZ:
/// düzenleme döngü sonunda frontend'in `edits` raporuna birleştirilir —
/// editör state'i ve undo zinciri bozulmaz (aynı sözleşme, tek yol).
#[derive(Debug, Clone)]
pub struct RecordedEdit {
    pub file: String,
    pub new_body: String,
    pub message: String,
}

/// Araç yürütme bağlamı: workspace kökü + istekteki kod blokları.
pub struct ToolCtx<'a> {
    pub root: &'a Path,
    pub code_blocks: &'a [(String, String, String)],
    /// edit_file/write_file kayıtları. Aynı dosya için birden çok kayıt
    /// olabilir (kümülatif); birleştirmede yalnız sonuncusu kullanılır.
    pub edits: std::cell::RefCell<Vec<RecordedEdit>>,
    /// todo_write ile izlenen adımlar: (metin, durum). Durum: pending |
    /// in_progress | done. Run sonunda yanıtla döner.
    pub todos: std::cell::RefCell<Vec<(String, String)>>,
    /// run_command aracı yalnızca açık izin modlarında (auto/autonomous)
    /// etkindir; varsayılan kapalıdır.
    pub allow_shell: bool,
}

impl<'a> ToolCtx<'a> {
    pub fn new(root: &'a Path, code_blocks: &'a [(String, String, String)]) -> Self {
        Self {
            root,
            code_blocks,
            edits: std::cell::RefCell::new(Vec::new()),
            todos: std::cell::RefCell::new(Vec::new()),
            allow_shell: false,
        }
    }
}

// Maliyet sınırı: 200 KB'lık tek read_file ~50k token faturalanıyordu; 32 KB
// (~8k token) bir tur için yeterli, kalanı offset ile istenir.
const MAX_READ_BYTES: usize = 32_768;
const DEFAULT_READ_LINES: usize = 400;
const MAX_READ_LINES: usize = 2000;
const MAX_LIST: usize = 500;
const MAX_GREP_HITS: usize = 80;
const MAX_GREP_FILE_BYTES: u64 = 1_500_000;
// Grep hit'lerinde uzun satır kırpma (minified/tek satırlık dosyalar için).
const MAX_GREP_LINE_CHARS: usize = 240;
// Tek turda tüm araç sonuçlarının toplam karakter bütçesi (~37k token).
// Aşılırsa tur hata ile durur: sessizce $5'lık istek atmak yerine patla.
pub const TOOL_RESULT_BUDGET: usize = 150_000;

/// Araç taramalarının yok saydığı dizin adları (bağımlılık/çıktı klasörleri).
fn is_ignored_entry(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "coverage"
                | "__pycache__"
                | "venv"
                | "vendor"
        )
}

/// Modelin gördüğü araç şemaları (OpenAI function-calling biçimi).
/// `run_command` yalnızca izin modu izin veriyorsa listelenir.
pub fn specs(allow_shell: bool) -> Value {
    let mut all = vec![
            {
                "type": "function",
                "function": {
                    "name": "edit_file",
                    "description": "Applies a SEARCH/REPLACE edit to a file and records it (applied after the run, not written to disk mid-run). SEARCH must match the current content exactly (newline-tolerant). For multiple changes, call edit_file several times. PREFERRED way to edit code.",
                    "parameters": {"type":"object","properties":{
                        "path":{"type":"string","description":"path relative to the workspace root"},
                        "search":{"type":"string","description":"exact existing lines to replace"},
                        "replace":{"type":"string","description":"new lines (may be empty to delete)"}
                    },"required":["path","search","replace"]}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Records the FULL content of a file (creates new files or rewrites a small existing file entirely). Prefer edit_file for small changes to existing files.",
                    "parameters": {"type":"object","properties":{
                        "path":{"type":"string","description":"path relative to the workspace root"},
                        "content":{"type":"string","description":"the complete file content"}
                    },"required":["path","content"]}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "find_files",
                    "description": "Finds files by glob pattern (e.g. '**/*.rs', 'src/*.ts'). Returns up to 100 relative paths.",
                    "parameters": {"type":"object","properties":{
                        "pattern":{"type":"string","description":"glob pattern relative to the workspace root"}
                    },"required":["pattern"]}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_code_body",
                "description": "Returns the full body of a function/class definition seen in the schema. Call when you need details.",
                "parameters": {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}
            }
        },
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Reads a file inside the workspace, page by page. Returns up to `limit` lines (default 400) starting at `offset` (1-based line number). READ the relevant file before making changes; pass offset to continue past a truncation notice. Set numbered=true to prefix line numbers (for referencing, not for SEARCH blocks).",
                    "parameters": {"type":"object","properties":{
                        "path":{"type":"string","description":"path relative to the workspace root"},
                        "offset":{"type":"integer","description":"1-based first line to read (default 1)"},
                        "limit":{"type":"integer","description":"max lines to read (default 400, max 2000)"},
                        "numbered":{"type":"boolean","description":"prefix each line with its line number"}
                    },"required":["path"]}
                }
            },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "Lists the entries of a directory (files/folders, sizes).",
                "parameters": {"type":"object","properties":{
                    "path":{"type":"string","description":"relative directory (empty = root)"}
                }}
            }
        },
            {
                "type": "function",
                "function": {
                    "name": "grep_search",
                    "description": "Searches for text/pattern inside workspace files, case-insensitive. Set regex=true to treat the query as a regular expression. Returns up to 80 'path:line: text' hits (long lines are trimmed).",
                    "parameters": {"type":"object","properties":{
                        "query":{"type":"string"},
                        "path":{"type":"string","description":"subdirectory (empty = root)"},
                        "regex":{"type":"boolean","description":"treat query as a regular expression"}
                    },"required":["query"]}
                }
            }
    ])
}

/// Kök dışına çıkan yolları reddeder; kök altına canonicalize eder.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_c = root
        .canonicalize()
        .map_err(|e| format!("could not resolve workspace root: {}", e))?;
    let p = Path::new(rel);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root_c.join(p)
    };
    // G1: `..` bileşenini kontrol ÖNCESİNDE reddet (yok-hedefta ata-traversal'ı kapatır).
    if abs
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Security: path cannot contain '..' components".into());
    }
    if abs.exists() {
        let c = abs
            .canonicalize()
            .map_err(|e| format!("could not resolve path: {}", e))?;
        if c.starts_with(&root_c) {
            Ok(c)
        } else {
            Err("Security: access outside the workspace root was denied".into())
        }
    } else {
        // var olmayan hedef: en yakın var olan atası kök altındaysa kabul
        let mut anc = abs.as_path();
        while let Some(par) = anc.parent() {
            if par.exists() {
                let pc = par.canonicalize().map_err(|e| e.to_string())?;
                return if pc.starts_with(&root_c) {
                    Ok(abs)
                } else {
                    Err("Security: access outside the workspace root was denied".into())
                };
            }
            anc = par;
        }
        Err("could not resolve path".into())
    }
}

fn tool_read_file(root: &Path, args: &Value) -> String {
    let rel = args["path"].as_str().unwrap_or("");
    if rel.is_empty() {
        return "HATA: path gerekli".into();
    }
    let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
    let limit = (args["limit"].as_u64().unwrap_or(DEFAULT_READ_LINES as u64) as usize)
        .clamp(1, MAX_READ_LINES);
    let numbered = args["numbered"].as_bool().unwrap_or(false);
    match safe_join(root, rel) {
        Ok(p) => {
            if p.is_dir() {
                return format!("HATA: '{}' bir dizin (list_dir kullan)", rel);
            }
            match std::fs::read(&p) {
                Ok(bytes) => {
                    // Binary dosyayı token olarak boşa harcama: ilk 8 KB'de NUL
                    // byte varsa içerik gösterilmez.
                    if bytes.iter().take(8_192).any(|&b| b == 0) {
                        return format!(
                            "'{}' is a binary file ({} bytes) — content not shown",
                            rel,
                            bytes.len()
                        );
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let lines: Vec<&str> = text.lines().collect();
                    let total = lines.len();
                    let start = (offset - 1).min(total);
                    let end = (start + limit).min(total);
                    // Karakter sınırını bozmadan byte bütçesine uyan satırları al.
                    let mut out = String::new();
                    let mut shown_end = start;
                    for (i, line) in lines[start..end].iter().enumerate() {
                        let line_no = start + i + 1;
                        let piece = if numbered {
                            format!("{:>5}| {}\n", line_no, line)
                        } else {
                            format!("{}\n", line)
                        };
                        if out.len() + piece.len() > MAX_READ_BYTES {
                            break;
                        }
                        out.push_str(&piece);
                        shown_end = line_no;
                    }
                    if shown_end < total {
                        format!(
                            "[lines {}-{} of {} — output truncated, call again with offset={} for the rest]\n{}",
                            start + 1,
                            shown_end,
                            total,
                            shown_end + 1,
                            out
                        )
                    } else {
                        out
                    }
                }
                Err(e) => format!("could not read '{}': {}", rel, e),
            }
        }
        Err(e) => e,
    }
}

fn tool_list_dir(root: &Path, args: &Value) -> String {
    let rel = args["path"].as_str().unwrap_or("");
    match safe_join(root, rel) {
        Ok(p) => match std::fs::read_dir(&p) {
            Ok(rd) => {
                let mut items: Vec<String> = Vec::new();
                for e in rd.flatten() {
                    if items.len() >= MAX_LIST {
                        break;
                    }
                    let name = e.file_name().to_string_lossy().to_string();
                    // Bağımlılık/çıktı klasörleri model için gürültü: 500'lük
                    // limiti boşa harcamasın.
                    if is_ignored_entry(&name) {
                        continue;
                    }
                    let ft = e.file_type().ok();
                    let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    items.push(format!(
                        "{}{}  {}",
                        name,
                        if is_dir { "/" } else { "" },
                        if is_dir {
                            String::new()
                        } else {
                            format!("{}B", size)
                        }
                    ));
                }
                items.sort();
                if items.is_empty() {
                    "(empty directory)".into()
                } else {
                    items.join("\n")
                }
            }
            Err(e) => format!("listelenemedi '{}': {}", rel, e),
        },
        Err(e) => e,
    }
}

fn tool_grep(root: &Path, args: &Value) -> String {
    let query = args["query"].as_str().unwrap_or("").to_string();
    if query.is_empty() {
        return "HATA: query gerekli".into();
    }
    let rel = args["path"].as_str().unwrap_or("");
    let start = match safe_join(root, rel) {
        Ok(p) => p,
        Err(e) => return e,
    };
    // regex=true istendiyse gerçek regex; derlenemezse sessizce düz metne düş.
    let re = if args["regex"].as_bool().unwrap_or(false) {
        regex::RegexBuilder::new(&query)
            .case_insensitive(true)
            .size_limit(1_000_000)
            .build()
            .ok()
    } else {
        None
    };
    let lower = query.to_lowercase();
    let hit_line = |line: &str| -> bool {
        match &re {
            Some(re) => re.is_match(line),
            None => line.to_lowercase().contains(&lower),
        }
    };
    let mut hits: Vec<String> = Vec::new();
    let mut stack = vec![start];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            if hits.len() >= MAX_GREP_HITS {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if is_ignored_entry(&name) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                // Büyük dosyalar belleğe alınmaz (model için gereksiz; OOME domuzlarına hayır).
                if e.metadata().map(|m| m.len()).unwrap_or(0) > MAX_GREP_FILE_BYTES {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&p) {
                    for (i, line) in text.lines().enumerate() {
                        if hit_line(line) {
                            let disp = p.strip_prefix(root).unwrap_or(&p);
                            // Minified/tek satırlık dosyalar hit'i şişirmesin.
                            let trimmed = line.trim();
                            let shown: String =
                                if trimmed.chars().count() > MAX_GREP_LINE_CHARS {
                                    let head: String = trimmed
                                        .chars()
                                        .take(MAX_GREP_LINE_CHARS)
                                        .collect();
                                    format!("{}…", head)
                                } else {
                                    trimmed.to_string()
                                };
                            hits.push(format!("{}:{}: {}", disp.display(), i + 1, shown));
                            if hits.len() >= MAX_GREP_HITS {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    if hits.is_empty() {
        format!("no match: '{}'", query)
    } else {
        hits.join("\n")
    }
}

fn tool_get_code_body(args: &Value, blocks: &[(String, String, String)]) -> String {
    let wanted = args["name"].as_str().unwrap_or("").to_lowercase();
    if wanted.is_empty() {
        return "HATA: name parametresi gerekli.".into();
    }
    for (id, name, body) in blocks {
        if name.to_lowercase().contains(&wanted)
            || id.to_lowercase().contains(&wanted)
            || body.contains(&format!("def {}", wanted))
            || body.contains(&format!("class {}", wanted))
        {
            return body.clone();
        }
    }
    format!(
        "'{}' not found. You can search in files with read_file/grep_search.",
        wanted
    )
}

/// Düzenlenecek dosyanın GÜNCEL gövdesini çözer. Sıra önemli: (1) bu oturumda
/// bu dosyaya önceki edit_file/write_file kaydı varsa kümülatif gövde, (2)
/// istekteki code_blocks (editörün kaydedilmemiş durumunu korur), (3) disk.
fn resolve_edit_base(ctx: &ToolCtx, rel: &str) -> Option<String> {
    if let Some(rec) = ctx
        .edits
        .borrow()
        .iter()
        .rev()
        .find(|r| r.file == rel)
    {
        return Some(rec.new_body.clone());
    }
    if let Some((_, name, body)) = ctx.code_blocks.iter().find(|(_, name, _)| name == rel) {
        let _ = name;
        return Some(body.clone());
    }
    let p = safe_join(ctx.root, rel).ok()?;
    let bytes = std::fs::read(&p).ok()?;
    if bytes.iter().take(8_192).any(|&b| b == 0) {
        return None; // binary dosya düzenlenmez
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn tool_edit_file(_root: &Path, args: &Value, ctx: &ToolCtx) -> String {
    let rel = args["path"].as_str().unwrap_or("").trim_start_matches("./");
    let search = args["search"].as_str().unwrap_or("");
    let replace = args["replace"].as_str().unwrap_or("");
    if rel.is_empty() || search.is_empty() {
        return "HATA: path ve search gerekli (search boş olamaz; yeni dosya için write_file kullan)".into();
    }
    let Some(body) = resolve_edit_base(ctx, rel) else {
        return format!(
            "'{}' not found (or binary). Check the path with find_files/list_dir.",
            rel
        );
    };
    match edits::apply_search_replace(&body, search, replace) {
        Ok(new_body) => {
            let lines = new_body.lines().count();
            ctx.edits.borrow_mut().push(RecordedEdit {
                file: rel.to_string(),
                new_body,
                message: "applied via edit_file tool".into(),
            });
            format!(
                "applied to '{}' (file is now {} lines). The edit is recorded and will be applied after the run.",
                rel, lines
            )
        }
        Err(e) => format!(
            "edit failed: {}. Read the file again (read_file) and make sure SEARCH matches exactly.",
            e
        ),
    }
}

fn tool_write_file(_root: &Path, args: &Value, ctx: &ToolCtx) -> String {
    let rel = args["path"].as_str().unwrap_or("").trim_start_matches("./");
    let content = args["content"].as_str().unwrap_or("");
    if rel.is_empty() {
        return "HATA: path gerekli".into();
    }
    // Hedefin workspace içinde olduğunu doğrula (var olan dosyada yazım onayı).
    if let Ok(p) = safe_join(ctx.root, rel) {
        if p.is_dir() {
            return format!("HATA: '{}' bir dizin", rel);
        }
    }
    ctx.edits.borrow_mut().push(RecordedEdit {
        file: rel.to_string(),
        new_body: content.to_string(),
        message: "whole file via write_file tool".into(),
    });
    format!(
        "recorded '{}' ({} lines). It will be written after the run.",
        rel,
        content.lines().count()
    )
}

/// Glob desenini regex'e çevirir: `**` yol aşar, `*` yol segmenti içinde,
/// `?` tek karakter. Kalan karakterler escape edilir.
fn glob_to_regex(pattern: &str) -> Result<regex::Regex, String> {
    let mut out = String::from("^(?i)");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                if i + 2 < chars.len() && chars[i + 2] == '/' {
                    out.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    out.push_str(".*");
                    i += 2;
                }
            }
            '*' => {
                out.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                out.push('.');
                i += 1;
            }
            c => {
                out.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    out.push('$');
    regex::Regex::new(&out).map_err(|e| e.to_string())
}

fn tool_find_files(root: &Path, args: &Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    if pattern.is_empty() {
        return "HATA: pattern gerekli".into();
    }
    let re = match glob_to_regex(pattern) {
        Ok(re) => re,
        Err(e) => return format!("HATA: geçersiz pattern: {}", e),
    };
    let root_c = match root.canonicalize() {
        Ok(r) => r,
        Err(e) => return format!("could not resolve workspace root: {}", e),
    };
    let mut found: Vec<String> = Vec::new();
    let mut stack = vec![root_c.clone()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if is_ignored_entry(&name) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(&root_c)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                if re.is_match(&rel) {
                    found.push(rel);
                    if found.len() >= 100 {
                        return format!("{}\n…(limited to 100 files)", found.join("\n"));
                    }
                }
            }
        }
    }
    if found.is_empty() {
        format!("no files match '{}'", pattern)
    } else {
        found.join("\n")
    }
}

/// Araç çağrısını yürütür; sonucu modele metin olarak döndürür.
pub fn execute(name: &str, args: &Value, ctx: &ToolCtx) -> String {
    match name {
        "get_code_body" => tool_get_code_body(args, ctx.code_blocks),
        "read_file" => tool_read_file(ctx.root, args),
        "list_dir" => tool_list_dir(ctx.root, args),
        "grep_search" => tool_grep(ctx.root, args),
        "find_files" => tool_find_files(ctx.root, args),
        "edit_file" => tool_edit_file(ctx.root, args, ctx),
        "write_file" => tool_write_file(ctx.root, args, ctx),
        other => format!("unknown tool: {}", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(root: &'a Path, blocks: &'a [(String, String, String)]) -> ToolCtx<'a> {
        ToolCtx::new(root, blocks)
    }

    #[test]
    fn read_and_list_within_root() {
        let tmp = std::env::temp_dir().join(format!("thx_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("a.txt"), "merhaba").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        assert!(execute("read_file", &json!({"path":"a.txt"}), &c).contains("merhaba"));
        assert!(execute("list_dir", &json!({"path":""}), &c).contains("a.txt"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_path_escape() {
        let tmp = std::env::temp_dir().join(format!("thx_{}b", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute("read_file", &json!({"path":"../../etc/passwd"}), &c);
        assert!(
            out.contains("Security") || out.contains("could not read"),
            "çıkış reddedilmeli: {}",
            out
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_file_pages_by_offset_and_limit() {
        let tmp = std::env::temp_dir().join(format!("thx_{}d", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let body: String = (0..1000).map(|i| format!("satır{}\n", i)).collect();
        std::fs::write(tmp.join("big.txt"), &body).unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let page1 = execute("read_file", &json!({"path":"big.txt"}), &c);
        assert!(page1.contains("satır0"));
        assert!(!page1.contains("satır400\n"), "varsayılan 400 satır");
        assert!(page1.contains("offset=401"), "devam notu olmalı");
        let page2 = execute(
            "read_file",
            &json!({"path":"big.txt","offset":401,"limit":100}),
            &c,
        );
        assert!(page2.contains("satır400"));
        assert!(!page2.contains("satır500\n"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_file_detects_binary_files() {
        let tmp = std::env::temp_dir().join(format!("thx_{}e", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute("read_file", &json!({"path":"bin.dat"}), &c);
        assert!(out.contains("binary file"), "binary algılanmalı: {}", out);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_file_numbered_prefixes_real_line_numbers() {
        let tmp = std::env::temp_dir().join(format!("thx_{}f", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let body: String = (1..=30).map(|i| format!("l{}\n", i)).collect();
        std::fs::write(tmp.join("n.txt"), &body).unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute(
            "read_file",
            &json!({"path":"n.txt","offset":10,"limit":5,"numbered":true}),
            &c,
        );
        assert!(out.contains("   10| l10"), "gerçek satır no ile: {}", out);
        assert!(out.contains("   14| l14"));
        assert!(!out.contains("| l15"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn grep_regex_mode_matches_pattern() {
        let tmp = std::env::temp_dir().join(format!("thx_{}g", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("r.rs"), "fn foo_1() {}\nfn bar() {}\n").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute(
            "grep_search",
            &json!({"query":"foo_\\d","regex":true}),
            &c,
        );
        assert!(out.contains("foo_1"), "regex hit: {}", out);
        // Regex olmayan modda aynı sorgu bulamaz (alt çizgi + rakam araması).
        let plain = execute("grep_search", &json!({"query":"foo_\\d"}), &c);
        assert!(plain.contains("no match"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn grep_trims_long_hit_lines() {
        let tmp = std::env::temp_dir().join(format!("thx_{}h", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let long = format!("hedef {}", "x".repeat(2_000));
        std::fs::write(tmp.join("min.js"), long).unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute("grep_search", &json!({"query":"hedef"}), &c);
        assert!(out.contains('…'), "uzun satır kırpılmalı");
        assert!(out.len() < 500, "hit kısa kalmalı: {}", out.len());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn grep_and_list_skip_dependency_dirs() {
        let tmp = std::env::temp_dir().join(format!("thx_{}i", std::process::id()));
        let nm = tmp.join("node_modules").join("paket");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("x.js"), "gizli_hedef\n").unwrap();
        std::fs::write(tmp.join("a.js"), "gizli_hedef\n").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let hits = execute("grep_search", &json!({"query":"gizli_hedef"}), &c);
        assert!(!hits.contains("node_modules"), "ignore: {}", hits);
        assert!(hits.contains("a.js"));
        let listing = execute("list_dir", &json!({"path":""}), &c);
        assert!(!listing.contains("node_modules"), "list ignore: {}", listing);
        assert!(listing.contains("a.js"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn edit_file_records_edit_and_chains() {
        let tmp = std::env::temp_dir().join(format!("thx_{}j", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("f.rs"), "fn a() {}\nfn b() {}\n").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute(
            "edit_file",
            &json!({"path":"f.rs","search":"fn a() {}","replace":"fn a() { /* x */ }"}),
            &c,
        );
        assert!(out.contains("applied"), "{}", out);
        // Zincirleme: ikinci düzenleme İLK düzenlemenin sonucuna uygulanmalı.
        let out2 = execute(
            "edit_file",
            &json!({"path":"f.rs","search":"fn a() { /* x */ }","replace":"fn a() { /* y */ }"}),
            &c,
        );
        assert!(out2.contains("applied"), "{}", out2);
        let recs = c.edits.borrow();
        assert_eq!(recs.len(), 2);
        assert!(recs[1].new_body.contains("/* y */"));
        assert!(recs[1].new_body.contains("fn b() {}"));
        // Disk DEĞİŞMEMELİ — düzenleme run sonunda frontend'e gider.
        let disk = std::fs::read_to_string(tmp.join("f.rs")).unwrap();
        assert!(disk.contains("fn a() {}"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn edit_file_prefers_code_block_body() {
        // Editörde kaydedilmemiş içerik code_blocks'ta gelir; diskten değil
        // oradan düzenlenmeli.
        let tmp = std::env::temp_dir().join(format!("thx_{}k", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("e.ts"), "disk hali\n").unwrap();
        let blocks = vec![(
            "b1".to_string(),
            "e.ts".to_string(),
            "editör hali\n".to_string(),
        )];
        let c = ctx(&tmp, &blocks);
        let out = execute(
            "edit_file",
            &json!({"path":"e.ts","search":"editör hali","replace":"düzenlendi"}),
            &c,
        );
        assert!(out.contains("applied"), "code_block gövdesi bulunmalı: {}", out);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_file_records_whole_body() {
        let tmp = std::env::temp_dir().join(format!("thx_{}l", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute(
            "write_file",
            &json!({"path":"yeni/mod.py","content":"def x():\n    return 1\n"}),
            &c,
        );
        assert!(out.contains("recorded"), "{}", out);
        assert_eq!(c.edits.borrow()[0].file, "yeni/mod.py");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_files_matches_glob_and_skips_ignored() {
        let tmp = std::env::temp_dir().join(format!("thx_{}m", std::process::id()));
        let sub = tmp.join("src").join("derin");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(tmp.join("node_modules")).unwrap();
        std::fs::write(sub.join("a.rs"), "").unwrap();
        std::fs::write(tmp.join("b.rs"), "").unwrap();
        std::fs::write(tmp.join("c.ts"), "").unwrap();
        std::fs::write(tmp.join("node_modules").join("n.rs"), "").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        let out = execute("find_files", &json!({"pattern":"**/*.rs"}), &c);
        assert!(out.contains("src/derin/a.rs"), "{}", out);
        assert!(out.contains("b.rs"));
        assert!(!out.contains("node_modules"));
        let top = execute("find_files", &json!({"pattern":"*.rs"}), &c);
        assert!(top.contains("b.rs"));
        assert!(!top.contains("src/derin/a.rs"), "tek * yol aşmamalı");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn grep_finds_line() {
        let tmp = std::env::temp_dir().join(format!("thx_{}c", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("f.rs"), "fn hedef() {}\n").unwrap();
        let blocks: Vec<(String, String, String)> = vec![];
        let c = ctx(&tmp, &blocks);
        assert!(execute("grep_search", &json!({"query":"hedef"}), &c).contains("hedef"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn code_body_from_blocks() {
        let blocks = vec![(
            "b1".to_string(),
            "login".to_string(),
            "def login(): pass".to_string(),
        )];
        let tmp = std::env::temp_dir();
        let c = ctx(&tmp, &blocks);
        assert!(execute("get_code_body", &json!({"name":"login"}), &c).contains("def login"));
    }
}

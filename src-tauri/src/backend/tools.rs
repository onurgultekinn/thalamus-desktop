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

/// Araç yürütme bağlamı: workspace kökü + istekteki kod blokları.
pub struct ToolCtx<'a> {
    pub root: &'a Path,
    pub code_blocks: &'a [(String, String, String)],
}

const MAX_READ_BYTES: usize = 200_000;
const MAX_LIST: usize = 500;
const MAX_GREP_HITS: usize = 80;

/// Modelin gördüğü araç şemaları (OpenAI function-calling biçimi).
pub fn specs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_code_body",
                "description": "Şemada gördüğün bir fonksiyon/sınıf tanımının tam gövdesini döndürür. Detaya ihtiyacın olduğunda çağır.",
                "parameters": {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Workspace içindeki bir dosyanın içeriğini okur. Değişiklik yapmadan önce ilgili dosyayı OKU.",
                "parameters": {"type":"object","properties":{
                    "path":{"type":"string","description":"workspace köküne göreli yol"}
                },"required":["path"]}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "Bir dizinin girdilerini listeler (dosya/klasör, boyut).",
                "parameters": {"type":"object","properties":{
                    "path":{"type":"string","description":"göreli dizin (boş = kök)"}
                }}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep_search",
                "description": "Workspace içinde metin/desen arar (büyük/küçük harf duyarsız). Sembol nerede kullanılıyor bulmak için çağır.",
                "parameters": {"type":"object","properties":{
                    "query":{"type":"string"},
                    "path":{"type":"string","description":"alt dizin (boş = kök)"}
                },"required":["query"]}
            }
        }
    ])
}

/// Kök dışına çıkan yolları reddeder; kök altına canonicalize eder.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_c = root
        .canonicalize()
        .map_err(|e| format!("workspace kökü çözülemedi: {}", e))?;
    let p = Path::new(rel);
    let abs = if p.is_absolute() { p.to_path_buf() } else { root_c.join(p) };
    if abs.exists() {
        let c = abs.canonicalize().map_err(|e| format!("yol çözülemedi: {}", e))?;
        if c.starts_with(&root_c) {
            Ok(c)
        } else {
            Err("Güvenlik: kök dışına erişim reddedildi".into())
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
                    Err("Güvenlik: kök dışına erişim reddedildi".into())
                };
            }
            anc = par;
        }
        Err("yol çözülemedi".into())
    }
}

fn tool_read_file(root: &Path, args: &Value) -> String {
    let rel = args["path"].as_str().unwrap_or("");
    if rel.is_empty() {
        return "HATA: path gerekli".into();
    }
    match safe_join(root, rel) {
        Ok(p) => match std::fs::read(&p) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_READ_BYTES)]);
                if p.is_dir() {
                    format!("HATA: '{}' bir dizin (list_dir kullan)", rel)
                } else {
                    text.to_string()
                }
            }
            Err(e) => format!("okunamadı '{}': {}", rel, e),
        },
        Err(e) => e,
    }
}

fn tool_list_dir(root: &Path, args: &Value) -> String {
    let rel = args["path"].as_str().unwrap_or("");
    match safe_join(root, rel) {
        Ok(p) => match std::fs::read_dir(&p) {
            Ok(rd) => {
                let mut items: Vec<String> = Vec::new();
                for e in rd.flatten().take(MAX_LIST) {
                    let ft = e.file_type().ok();
                    let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    items.push(format!(
                        "{}{}  {}",
                        e.file_name().to_string_lossy(),
                        if is_dir { "/" } else { "" },
                        if is_dir { String::new() } else { format!("{}B", size) }
                    ));
                }
                items.sort();
                if items.is_empty() { "(boş dizin)".into() } else { items.join("\n") }
            }
            Err(e) => format!("listelenemedi '{}': {}", rel, e),
        },
        Err(e) => e,
    }
}

fn tool_grep(root: &Path, args: &Value) -> String {
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    if query.is_empty() {
        return "HATA: query gerekli".into();
    }
    let rel = args["path"].as_str().unwrap_or("");
    let start = match safe_join(root, rel) {
        Ok(p) => p,
        Err(e) => return e,
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
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(text) = std::fs::read_to_string(&p) {
                for (i, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&query) {
                        let disp = p.strip_prefix(root).unwrap_or(&p);
                        hits.push(format!("{}:{}: {}", disp.display(), i + 1, line.trim()));
                        if hits.len() >= MAX_GREP_HITS {
                            break;
                        }
                    }
                }
            }
        }
    }
    if hits.is_empty() {
        format!("eşleşme yok: '{}'", query)
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
    format!("bulunamadı: '{}'. read_file/grep_search ile dosyada arayabilirsin.", wanted)
}

/// Araç çağrısını yürütür; sonucu modele metin olarak döndürür.
pub fn execute(name: &str, args: &Value, ctx: &ToolCtx) -> String {
    match name {
        "get_code_body" => tool_get_code_body(args, ctx.code_blocks),
        "read_file" => tool_read_file(ctx.root, args),
        "list_dir" => tool_list_dir(ctx.root, args),
        "grep_search" => tool_grep(ctx.root, args),
        other => format!("bilinmeyen araç: {}", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(root: &'a Path, blocks: &'a [(String, String, String)]) -> ToolCtx<'a> {
        ToolCtx { root, code_blocks: blocks }
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
        assert!(out.contains("Güvenlik") || out.contains("okunamadı"), "çıkış reddedilmeli: {}", out);
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
        let blocks = vec![("b1".to_string(), "login".to_string(), "def login(): pass".to_string())];
        let tmp = std::env::temp_dir();
        let c = ctx(&tmp, &blocks);
        assert!(execute("get_code_body", &json!({"name":"login"}), &c).contains("def login"));
    }
}

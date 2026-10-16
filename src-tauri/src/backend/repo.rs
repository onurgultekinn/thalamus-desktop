// Repo map servisi: workspace diskten okunur (mtime cache'li), şemalar
// token bütçesine göre haritaya sıkıştırılır. aider'ın repo-map deseninin
// yerel uyarlaması.

use super::BackendState;
use crate::engine::repo_map::{build_repo_map, RepoFile};
use axum::{
    extract::State,
    Json,
};
use serde_json::json;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

const SKIP_DIRS: [&str; 6] = ["node_modules", "target", "dist", "__pycache__", "src_backup_before_copy", ".zcode"];
const EXTENSIONS: [&str; 5] = ["py", "ts", "tsx", "js", "rs"];
const MAX_DEPTH: usize = 6;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const DEFAULT_BUDGET: usize = 1000;
/// Uzun oturumlarda cache'in sınırsız büyümesini engeller; dolunca en eski
/// mtime'lı girdiler dışarı atılır.
const MAX_CACHE_ENTRIES: usize = 512;

type FileCache = Mutex<std::collections::HashMap<String, (SystemTime, String)>>;

/// `.thalamusignore` / `.aiderignore` (gitignore sözdizimi alt kümesi).
/// Repo map'e girmeyecek yolları hariç tutar.
fn load_ignore(root: &Path) -> Vec<String> {
    for name in [".thalamusignore", ".aiderignore"] {
        if let Ok(text) = std::fs::read_to_string(root.join(name)) {
            return text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .collect();
        }
    }
    Vec::new()
}

/// Basit glob eşleştirme: `dir/*` → önek, `*.ext` → sonek, diğer → alt dize.
fn is_ignored(rel: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        if p.starts_with('*') {
            p.strip_prefix('*').is_some_and(|suffix| rel.ends_with(suffix))
        } else if p.ends_with('*') {
            p.strip_suffix('*').is_some_and(|prefix| rel.starts_with(prefix))
        } else {
            rel.contains(p.as_str())
        }
    })
}

fn walk(
    dir: &Path,
    root: &Path,
    depth: usize,
    cache: &FileCache,
    ignore: &[String],
    out: &mut Vec<RepoFile>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&path, root, depth + 1, cache, ignore, out);
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if !ignore.is_empty() && is_ignored(&rel, ignore) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let key = path.to_string_lossy().to_string();
            let code = {
                let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
                match c.get(&key) {
                    Some((t, code)) if *t == mtime => code.clone(),
                    _ => {
                        let code = std::fs::read_to_string(&path).unwrap_or_default();
                        if c.len() >= MAX_CACHE_ENTRIES && !c.contains_key(&key) {
                            let mut entries_by_age: Vec<(String, SystemTime)> = c
                                .iter()
                                .map(|(k, (t, _))| (k.clone(), *t))
                                .collect();
                            entries_by_age.sort_by_key(|(_, t)| *t);
                            let evict_count = c.len() - MAX_CACHE_ENTRIES + 1;
                            for (k, _) in entries_by_age.into_iter().take(evict_count) {
                                c.remove(&k);
                            }
                        }
                        c.insert(key.clone(), (mtime, code.clone()));
                        code
                    }
                }
            };
            if code.is_empty() {
                continue;
            }
            out.push(RepoFile { name: rel, code });
        }
    }
}

#[derive(serde::Deserialize, Default)]
pub struct RepoMapRequest {
    #[serde(default)]
    pub budget: Option<usize>,
    #[serde(default)]
    pub focus: Option<String>,
}

pub async fn repo_map(
    State(state): State<BackendState>,
    Json(req): Json<RepoMapRequest>,
) -> Json<serde_json::Value> {
    let root = state.workspace_root.read().unwrap_or_else(|e| e.into_inner()).clone();
    let budget = req.budget.unwrap_or(DEFAULT_BUDGET);
    let focus = req.focus;
    let bpe = state.bpe.clone();
    let cache = state.repo_cache.clone();

    let result = tokio::task::spawn_blocking(move || {
        let root_path = Path::new(&root);
        let ignore = load_ignore(root_path);
        let mut files: Vec<RepoFile> = Vec::new();
        walk(root_path, root_path, 0, &cache, &ignore, &mut files);
        build_repo_map(&files, &bpe, budget, focus.as_deref())
    })
    .await
    .unwrap_or_else(|e| {
        crate::engine::repo_map::RepoMapResult {
            map: format!("repo map hatası: {}", e),
            tokens: 0,
            included: 0,
            total: 0,
        }
    });

    Json(json!({
        "map": result.map,
        "tokens": result.tokens,
        "included": result.included,
        "total": result.total,
    }))
}

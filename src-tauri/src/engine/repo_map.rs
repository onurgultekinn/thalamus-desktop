// Repo map — aider'dan ilham: çok-dosyalı depoda şemaların token-bütçeli,
// önem-sıralı haritası. (aider: tree-sitter etiketleri + PageRank; burada
// şema çıkarıcımız + referans-sayımı sıralaması. PageRank sonraki adım.)
//
// Sıralama mantığı:
//   - bir tanım başka dosyada referans ediliyorsa → tanımın sahibi dosya puan alır
//   - `focus` (aktif dosya) ve onun referans ettiği dosyalar ekstra puan alır
//   - bütçeye göre greedy doldurma; sığmayan dosyalar "(bütçe dışı)" notuyla işaretlenir

use crate::engine::schema::{extract_schema_for, render_schema, schema_definition_names};
use std::collections::HashMap;
use tiktoken_rs::CoreBPE;

pub struct RepoFile {
    pub name: String,
    pub code: String,
    /// Dosyanın son değişiklik zamanı (şema cache anahtarı). Test/örnek
    /// yollarında None olabilir → cache kullanılmaz.
    pub mtime: Option<std::time::SystemTime>,
}

pub struct RepoMapResult {
    pub map: String,
    pub tokens: usize,
    pub included: usize,
    pub total: usize,
}

/// Dosya başına (şema tanım adları) — sahiplik ve bütçe notları için.
fn definition_names_of(file: &str, code: &str) -> Vec<String> {
    crate::engine::schema::extract_schema_for(file, code)
        .map(|s| crate::engine::schema::schema_definition_names(&s))
        .unwrap_or_default()
}

pub fn build_repo_map(
    files: &[RepoFile],
    bpe: &CoreBPE,
    budget: usize,
    focus: Option<&str>,
) -> RepoMapResult {
    // 1) Şemalar + tanım sahipliği — uzantı-duyarlı çıkarıcı: .py girinti,
    //    TS/JS/Rust/C-tarzı brace, Markdown/YAML/JSON dış hat.
    let mut schemas: HashMap<String, Option<String>> = HashMap::new();
    let mut def_owner: HashMap<String, String> = HashMap::new();
    for f in files {
        let rendered = extract_schema_for(&f.name, &f.code).map(|s| {
            for name in schema_definition_names(&s) {
                def_owner.entry(name).or_insert_with(|| f.name.clone());
            }
            // @C başlık satırını at (harita başına bir kez yeter)
            let body = render_schema(&s);
            match body.find('\n') {
                Some(i) => body[i + 1..].to_string(),
                None => body,
            }
        });
        schemas.insert(f.name.clone(), rendered);
    }

    // 2) Önem puanı: başka dosyada referans edilen tanımlar + focus yakınlığı
    let mut score: HashMap<String, usize> =
        files.iter().map(|f| (f.name.clone(), 0usize)).collect();
    for f in files {
        for (def_name, owner) in &def_owner {
            if *owner != f.name && f.code.contains(def_name.as_str()) {
                *score.entry(owner.clone()).or_insert(0) += 1;
            }
        }
    }
    if let Some(focus) = focus {
        *score.entry(focus.to_string()).or_insert(0) += 50;
        if let Some(f) = files.iter().find(|f| f.name == focus) {
            for (def_name, owner) in &def_owner {
                if *owner != *focus && f.code.contains(def_name.as_str()) {
                    *score.entry(owner.clone()).or_insert(0) += 20;
                }
            }
        }
    }

    // 3) Skora göre sırala, bütçeye greedy doldur
    let mut order: Vec<&String> = files.iter().map(|f| &f.name).collect();
    order.sort_by(|a, b| {
        let sa = score.get(*a).copied().unwrap_or(0);
        let sb = score.get(*b).copied().unwrap_or(0);
        sb.cmp(&sa).then_with(|| a.cmp(b))
    });

    let mut map = String::new();
    let mut used = 0usize;
    let mut included = 0usize;
    for name in &order {
        let f = files.iter().find(|f| &f.name == *name).unwrap();
        let candidate = match schemas.get(name.as_str()) {
            Some(Some(schema_body)) => format!("## {}\n{}\n", name, schema_body),
            _ => format!("## {} (şema desteklenmiyor)\n", name),
        };
        let tok = count(bpe, &candidate);
        if used + tok <= budget {
            map.push_str(&candidate);
            used += tok;
            included += 1;
        } else {
            // Bütçe dışı dosyalar da LLM'in görüş alanında kalmalı:
            // varlığını bilmeden get_code_body isteyemez. Not koşulsuz eklenir.
            let note = format!(
                "## {} — out of budget ({} definitions; requestable via get_code_body)\n",
                name,
                definition_names_of(name, &f.code).len()
            );
            map.push_str(&note);
            used += count(bpe, &note);
        }
    }

    RepoMapResult {
        map,
        tokens: used,
        included,
        total: files.len(),
    }
}

fn count(bpe: &CoreBPE, text: &str) -> usize {
    bpe.encode_with_special_tokens(text).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bpe() -> tiktoken_rs::CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn referenced_files_rank_higher_and_budget_is_respected() {
        let files = vec![
            RepoFile {
                name: "notes.py".into(),
                code: "x = 1\n".into(),
                mtime: None,
            },
            RepoFile {
                name: "utils.py".into(),
                code: "def validate_token(token):\n    return token.startswith('tok_')\n".into(),
                mtime: None,
            },
            RepoFile {
                name: "api.py".into(),
                code: "def dispatch(h):\n    if not validate_token(h):\n        raise ValueError\n    return h\n".into(),
                mtime: None,
            },
        ];
        let b = bpe();
        let r = build_repo_map(&files, &b, 2000, Some("api.py"));
        assert_eq!(r.total, 3);
        assert!(r.map.contains("validate_token"));
        // utils.py hem referans ediliyor hem focus'un kullandığı şey → önde
        let i_utils = r.map.find("## utils.py").unwrap();
        let i_notes = r.map.find("## notes.py").unwrap();
        assert!(i_utils < i_notes, "referans edilen dosya önde olmalı");
    }

    #[test]
    fn tiny_budget_marks_files_out_of_budget() {
        let files = vec![
            RepoFile {
                name: "a.py".into(),
                code: "def f1():\n    pass\n\ndef f2():\n    pass\n\ndef f3():\n    pass\n".into(),
                mtime: None,
            },
            RepoFile {
                name: "b.py".into(),
                code: "def g1():\n    pass\n".into(),
                mtime: None,
            },
        ];
        let b = bpe();
        let r = build_repo_map(&files, &b, 60, None);
        assert!(r.included < r.total, "küçük bütçede hepsi sığmamalı");
        assert!(r.map.contains("out of budget"));
    }
}

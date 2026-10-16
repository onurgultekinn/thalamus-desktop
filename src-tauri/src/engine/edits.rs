// Aider tarzı SEARCH/REPLACE düzenleme motoru.
//
// LLM yanıtlarındaki düzenlemeleri ayrıştırır ve kod gövdelerine uygular:
//
//   dosya.py
//   <<<<<<< SEARCH
//   (mevcut kodun birebir kopyası)
//   =======
//   (yeni kod)
//   >>>>>>> REPLACE
//
// Sözleşme: SEARCH mevcut kodda birebir bulunmalıdır (yeni satır toleransıyla).
// Bulunamazsa blok `ok:false` olarak raporlanır — sessizce atlanmaz, LLM'e
// geri beslenebilir.

#[derive(Debug, Clone, PartialEq)]
pub struct EditBlock {
    pub file: Option<String>,
    pub search: String,
    pub replace: String,
}

#[derive(Debug, Clone)]
pub struct EditResult {
    pub file: String,
    pub ok: bool,
    pub message: String,
    pub new_code: String,
}

const SEARCH_MARKER: &str = "<<<<<<<";
const DIVIDER_MARKER: &str = "=======";
const REPLACE_MARKER: &str = ">>>>>>>";

fn marker_kind(line: &str) -> Option<&'static str> {
    let t = line.trim();
    if t.starts_with(SEARCH_MARKER) && t.contains("SEARCH") {
        Some("search")
    } else if t.starts_with(DIVIDER_MARKER) && t.trim() == DIVIDER_MARKER {
        Some("divider")
    } else if t.starts_with(REPLACE_MARKER) && t.contains("REPLACE") {
        Some("replace")
    } else {
        None
    }
}

/// LLM yanıtındaki tüm SEARCH/REPLACE bloklarını ayrıştırır.
pub fn parse_edit_blocks(content: &str) -> Vec<EditBlock> {
    let mut blocks = Vec::new();
    let mut file: Option<String> = None;
    let mut phase: Option<&'static str> = None;
    let mut search = String::new();
    let mut replace = String::new();

    for line in content.lines() {
        let line = line.trim_end_matches('\r');
        match (phase, marker_kind(line)) {
            (None, Some("search")) => {
                phase = Some("search");
                search.clear();
                replace.clear();
            }
            (Some("search"), Some("divider")) => {
                phase = Some("replace");
            }
            (Some("replace"), Some("replace")) => {
                blocks.push(EditBlock {
                    file: file.take(),
                    search: search
                        .trim_start_matches('\n')
                        .trim_end_matches('\n')
                        .to_string(),
                    replace: replace
                        .trim_start_matches('\n')
                        .trim_end_matches('\n')
                        .to_string(),
                });
                phase = None;
            }
            (Some("search"), _) => {
                search.push_str(line);
                search.push('\n');
            }
            (Some("replace"), _) => {
                replace.push_str(line);
                replace.push('\n');
            }
            (None, _) => {
                // Blok öncesi satır: dosya adı adayı (yol benzeri ve marker değil).
                let t = line.trim();
                if !t.is_empty() && (t.contains('/') || t.contains('.') || t.contains('\\')) {
                    file = Some(t.to_string());
                } else if !t.is_empty() {
                    file = None;
                }
            }
            (Some(_), _) => {
                // Bilinmeyen marker kombinasyonu — bölüm içeriği olarak ekle.
                match phase {
                    Some("search") => {
                        search.push_str(line);
                        search.push('\n');
                    }
                    Some("replace") => {
                        replace.push_str(line);
                        replace.push('\n');
                    }
                    _ => {}
                }
            }
        }
    }
    blocks
}

/// SEARCH metnini kodda bulur ve REPLACE ile değiştirir.
/// Birebir eşleşme yoksa satır sonu toleransıyla dener.
pub fn apply_search_replace(code: &str, search: &str, replace: &str) -> Result<String, String> {
    if search.is_empty() {
        return Err("SEARCH boş olamaz.".into());
    }
    if code.contains(search) {
        return Ok(code.replacen(search, replace, 1));
    }
    // Yeni satır toleransı: SEARCH'i \n ile bitirip dene / etmeden dene.
    for candidate in [format!("{}\n", search), search.trim_end().to_string()] {
        if code.contains(&candidate) {
            let rep = if replace.is_empty() {
                replace.to_string()
            } else if candidate.ends_with('\n') && !replace.ends_with('\n') {
                format!("{}\n", replace)
            } else {
                replace.to_string()
            };
            return Ok(code.replacen(&candidate, &rep, 1));
        }
    }
    Err("SEARCH metni kodda bulunamadı (birebir kopya bekleniyor).".into())
}

/// Blokları dosya gövdelerine uygular. Her blok için sonuç raporlanır.
pub fn apply_blocks(
    bodies: &[(String, String, String)], // (id, name, code)
    blocks: &[EditBlock],
) -> Vec<EditResult> {
    let mut results = Vec::new();
    let mut working: Vec<(String, String)> = bodies
        .iter()
        .map(|(_id, name, code)| (name.clone(), code.clone()))
        .collect();

    for block in blocks {
        let target = block
            .file
            .as_ref()
            .map(|f| {
                working
                    .iter()
                    .position(|(name, _)| name == f || name.ends_with(f) || f.ends_with(name))
            })
            .unwrap_or_else(|| {
                // blokta dosya yoksa tek gövde varsa ona uygula
                if working.len() == 1 {
                    Some(0)
                } else {
                    None
                }
            });

        match target {
            Some(idx) => {
                let (name, code) = (working[idx].0.clone(), working[idx].1.clone());
                match apply_search_replace(&code, &block.search, &block.replace) {
                    Ok(new_code) => {
                        working[idx].1 = new_code.clone();
                        results.push(EditResult {
                            file: name,
                            ok: true,
                            message: "uygulandı".into(),
                            new_code,
                        });
                    }
                    Err(e) => results.push(EditResult {
                        file: name,
                        ok: false,
                        message: e,
                        new_code: code,
                    }),
                }
            }
            None => results.push(EditResult {
                file: block.file.clone().unwrap_or_else(|| "?".into()),
                ok: false,
                message: "dosya eşleşmedi".into(),
                new_code: String::new(),
            }),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_blocks_with_filenames() {
        let content = "İki dosyada da düzeltme yaptım.\n\
            a.py\n\
            <<<<<<< SEARCH\n\
            x = 1\n\
            =======\n\
            x = 2\n\
            >>>>>>> REPLACE\n\
            \n\
            b.py\n\
            <<<<<<< SEARCH\n\
            y = \"eski\"\n\
            =======\n\
            y = \"yeni\"\n\
            >>>>>>> REPLACE\n";
        let blocks = parse_edit_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].file.as_deref(), Some("a.py"));
        assert_eq!(blocks[0].search, "x = 1");
        assert_eq!(blocks[0].replace, "x = 2");
        assert_eq!(blocks[1].file.as_deref(), Some("b.py"));
        assert_eq!(blocks[1].replace, "y = \"yeni\"");
    }

    #[test]
    fn applies_search_replace_and_reports_misses() {
        let code = "def f():\n    return 1\n";
        let ok = apply_search_replace(code, "return 1", "return 42").unwrap();
        assert_eq!(ok, "def f():\n    return 42\n");

        let blocks = vec![EditBlock {
            file: Some("f.py".into()),
            search: "yok böyle bir satır".into(),
            replace: String::new(),
        }];
        let results = apply_blocks(&[("id".into(), "f.py".into(), code.into())], &blocks);
        assert!(!results[0].ok);
        assert!(results[0].message.contains("bulunamadı"));
    }

    #[test]
    fn newline_tolerance_works() {
        let code = "a = 1\nb = 2\n";
        let out = apply_search_replace(code, "a = 1", "# baş\na = 1").unwrap();
        assert!(out.starts_with("# baş\n"));
    }
}

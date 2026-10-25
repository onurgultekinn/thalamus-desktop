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

/// Satır bazlı esnek eşleştirme (son çare). `strict_ws=true` → satır sonları
/// (boşluk/\r) yok sayılır; `false` → baştaki boşluk da (tab/space) yok
/// sayılır. Dosyanın EOL stili (\r\n | \n) korunur; SEARCH'in baş/sondaki
/// boş satırları eşleşme dışı bırakılır.
fn apply_line_flexible(code: &str, search: &str, replace: &str, strict_ws: bool) -> Option<String> {
    let eol = if code.contains("\r\n") { "\r\n" } else { "\n" };
    let norm = |l: &str| -> String {
        let l = l.strip_suffix('\r').unwrap_or(l);
        if strict_ws { l.trim_end().to_string() } else { l.trim().to_string() }
    };
    // SEARCH imzası: baş/son boş satırlar atılır (model fazladan boş satır
    // bırakabilir; bu satırlar eşleşmeye girmesin).
    let mut search_sig: Vec<String> = search.lines().map(norm).collect();
    while search_sig.first().map(|s| s.is_empty()).unwrap_or(false) {
        search_sig.remove(0);
    }
    while search_sig.last().map(|s| s.is_empty()).unwrap_or(false) {
        search_sig.pop();
    }
    if search_sig.is_empty() {
        return None;
    }
    let code_lines: Vec<&str> = code.split('\n').collect();
    let n = search_sig.len();
    if code_lines.len() < n {
        return None;
    }
    // Son satır dosya sonu_newline'suz olabilir; pencere onu da kapsayabilir.
    for start in 0..=(code_lines.len() - n) {
        let window_matches = (0..n).all(|k| norm(code_lines[start + k]) == search_sig[k]);
        if window_matches {
            let replace_lines: Vec<&str> = replace
                .lines()
                .map(|l| l.strip_suffix('\r').unwrap_or(l))
                .collect();
            let mut out = String::new();
            for l in &code_lines[..start] {
                out.push_str(l);
                out.push('\n');
            }
            if !replace_lines.is_empty() {
                out.push_str(&replace_lines.join(eol));
            }
            // Pencerenin bittiği yerden devam; kalan satırlar arasına EOL ekle.
            let after = &code_lines[start + n..];
            if !after.is_empty() {
                out.push_str(eol);
                out.push_str(&after.join("\n"));
            }
            return Some(out);
        }
    }
    None
}

/// SEARCH metnini kodda bulur ve REPLACE ile değiştirir.
/// Merdiven: birebir → satır sonu toleransı → satır-esnek (son boşluk) →
/// satır-esnek (tam trim). Windows \r\n dosyalarına \n SEARCH ve hafif
/// girinti farkları artık düzenleme düşürmez (aider ekolü).
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
    // Esnek katmanlar: önce yalnız satır sonu boşlukları, sonra tam trim.
    if let Some(out) = apply_line_flexible(code, search, replace, true) {
        return Ok(out);
    }
    if let Some(out) = apply_line_flexible(code, search, replace, false) {
        return Ok(out);
    }
    // Başarısızlık ipucu: SEARCH'in ilk dolu satırını kodda ara; bulunursa
    // GERÇEK satırları göster — model tek denemede birebir kopya çıkarabilsin.
    let hint = search
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .and_then(|first| code.lines().position(|l| l.trim() == first))
        .map(|idx| {
            let lines: Vec<&str> = code.lines().skip(idx.saturating_sub(1)).take(5).collect();
            format!(
                " İpucu: ilk satırına benzeyen bölge ~satır {} civarı:\n{}",
                idx + 1,
                lines.join("\n")
            )
        })
        .unwrap_or_default();
    Err(format!(
        "SEARCH metni kodda bulunamadı (birebir kopya bekleniyor).{}",
        hint
    ))
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
    fn crlf_file_accepts_lf_search_and_keeps_eol() {
        let code = "fn a() {
    return 1;
}
fn b() {}
";
        let out = apply_search_replace(code, "fn a() {
    return 1;
}", "fn a() {
    return 2;
}")
            .expect("LF SEARCH, CRLF dosya eşleşmeli");
        assert!(out.contains("return 2;"));
        assert!(out.contains("
"), "dosyanın EOL stili korunmalı");
        assert!(out.contains("fn b() {}"), "geri kalan satırlar durmalı");
    }

    #[test]
    fn trailing_whitespace_mismatch_still_matches() {
        let code = "let x = 1;   
let y = 2;
";
        let out = apply_search_replace(code, "let x = 1;", "let x = 10;")
            .expect("satır sonu boşluk farkı eşleşmeli");
        assert!(out.contains("let x = 10;"));
        assert!(out.contains("let y = 2;"));
    }

    #[test]
    fn indent_mismatch_matches_as_last_resort() {
        let code = "def f():
	return 1
";
        // Model tab yerine 4 boşluk yazdı — tam trim katmanı yakalar.
        let out = apply_search_replace(code, "def f():
    return 1", "def f():
	return 2")
            .expect("girinti farkı son çarede eşleşmeli");
        assert!(out.contains("return 2"));
    }

    #[test]
    fn leading_blank_lines_in_search_are_ignored() {
        let code = "a
b
c
";
        let out = apply_search_replace(code, "

b
c

", "X")
            .expect("SEARCH'in boş baş/son satırları atılmalı");
        assert_eq!(out, "a\nX\n");
    }

    #[test]
    fn no_match_still_errors() {
        assert!(apply_search_replace("a
b
", "zzz", "x").is_err());
    }


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

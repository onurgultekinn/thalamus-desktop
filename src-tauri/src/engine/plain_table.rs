// Yönlendirmesiz düz tablo (H33) — ÜRETİM modülü.
//
// XML/SQL gibi tekrar eden kayıtları tek bir okunur şema satırı + saf TSV
// gövdesine çevirir. Satır içinde yuva/takma ad YOKTUR; model tabloyu olduğu
// gibi okur. Geri çözüm kural tabanlıdır ve `compress` içinde birebir
// doğrulanır — doğrulanmayan hiçbir çıktı döndürülmez.
//
// Anlama kapısı: TRIALS-018 (43 eşleştirilmiş soru, yerel 7B, 3 tekrar):
// ham %100 / tablo %100. Token: XML %65-77, SQL %26-37.

/// Dönüşümün kaynak biçimi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlainKind {
    Xml,
    Sql,
    Ini,
    Toml,
    Yaml,
}

impl PlainKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PlainKind::Xml => "xml",
            PlainKind::Sql => "sql",
            PlainKind::Ini => "ini",
            PlainKind::Toml => "toml",
            PlainKind::Yaml => "yaml",
        }
    }
}

/// `[profile_00]` + `key = value` blokları → tek şema satırı + TSV.
///
/// Bölüm adı bir KOLON olur; anahtarlar yalnız şemada bir kez yazılır.
/// Yalnız aynı anahtar sırasını ve aynı ayırıcı biçimini kullanan, en az 4
/// bölümlük bloklar dönüştürülür; geri çözüm birebir doğrulanır.
pub fn ini_encode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut changed = false;
    while i < lines.len() {
        let t = lines[i].trim();
        if !(t.starts_with('[') && t.ends_with(']') && !t.starts_with("[[")) {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let mut k = i + 1;
        let mut first_keys: Vec<String> = Vec::new();
        let mut sep_spaced = false;
        let mut keys_ok = true;
        while k < lines.len() {
            let lt = lines[k].trim();
            if lt.is_empty() || (lt.starts_with('[') && lt.ends_with(']')) {
                break;
            }
            let Some(eq) = lt.find('=') else {
                keys_ok = false;
                break;
            };
            let key = lt[..eq].trim().to_string();
            let val = lt[eq + 1..].trim();
            if key.is_empty() || val.contains('\t') {
                keys_ok = false;
                break;
            }
            if first_keys.is_empty() {
                sep_spaced = eq > 0 && lt.len() - eq - 1 > 0;
            }
            first_keys.push(key);
            k += 1;
        }
        if !keys_ok || first_keys.len() < 2 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }

        struct Block {
            name: String,
            vals: Vec<String>,
        }
        let mut blocks: Vec<Block> = Vec::new();
        let mut m = i;
        let mut gap: Option<usize> = None;
        loop {
            let before_blanks = m;
            let mut blanks = 0usize;
            while m < lines.len() && lines[m].trim().is_empty() {
                blanks += 1;
                m += 1;
            }
            let Some(header) = lines.get(m).map(|l| l.trim()) else {
                m = before_blanks;
                break;
            };
            if !(header.starts_with('[') && header.ends_with(']') && !header.starts_with("[[")) {
                m = before_blanks;
                break;
            }
            if blocks.is_empty() {
                // ilk bölümden önce sayılan boşluk bölümler arası değildir
            } else {
                match gap {
                    None => gap = Some(blanks),
                    Some(g) if g != blanks => {
                        m = before_blanks;
                        break;
                    }
                    _ => {}
                }
            }
            let name = header[1..header.len() - 1].trim();
            if name.is_empty() || name.contains('\t') {
                m = before_blanks;
                break;
            }
            let mut vals: Vec<String> = Vec::new();
            let mut kk = m + 1;
            let mut ok = true;
            while kk < lines.len() {
                let lt = lines[kk].trim();
                if lt.is_empty() || (lt.starts_with('[') && lt.ends_with(']')) {
                    break;
                }
                let Some(eq) = lt.find('=') else {
                    ok = false;
                    break;
                };
                let key = lt[..eq].trim();
                if key != first_keys[vals.len().min(first_keys.len() - 1)] {
                    ok = false;
                    break;
                }
                vals.push(lt[eq + 1..].trim().to_string());
                kk += 1;
            }
            if !ok || vals.len() != first_keys.len() {
                m = before_blanks;
                break;
            }
            blocks.push(Block {
                name: name.to_string(),
                vals,
            });
            m = kk;
        }
        if blocks.len() < 4 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let type_of = |vals: &[String]| -> &'static str {
            if vals.iter().all(|v| !v.is_empty() && v.parse::<i64>().is_ok()) {
                "int"
            } else if vals.iter().all(|v| matches!(v.as_str(), "true" | "false")) {
                "bool"
            } else {
                "str"
            }
        };
        let mut cols: Vec<String> = vec!["@name(str)".to_string()];
        for (idx, key) in first_keys.iter().enumerate() {
            let vals: Vec<String> = blocks.iter().map(|b| b.vals[idx].clone()).collect();
            cols.push(format!("{}({})", key, type_of(&vals)));
        }
        out.push(format!(
            "#ini section {} | sep: {} | gap: {}",
            cols.join(", "),
            if sep_spaced { "spaced" } else { "tight" },
            gap.unwrap_or(0)
        ));
        for b in &blocks {
            let mut row = vec![b.name.clone()];
            row.extend(b.vals.iter().cloned());
            out.push(row.join("\t"));
        }
        changed = true;
        i = m;
    }
    if !changed {
        return None;
    }
    Some(out.join("\n"))
}

pub fn ini_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("#ini section ") else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let (cols_s, meta) = rest.split_once(" | sep: ")?;
        let (sep_s, gap_s) = meta.split_once(" | gap: ")?;
        let sep = if sep_s.trim() == "spaced" { " = " } else { "=" };
        let gap: usize = gap_s.trim().parse().ok()?;
        let cols: Vec<&str> = cols_s.split(", ").collect();
        let names: Vec<&str> = cols
            .iter()
            .map(|c| c.split_once('(').map(|(n, _)| n).unwrap_or(c))
            .collect();
        if names.first() != Some(&"@name") || names.len() < 2 {
            return None;
        }
        let ncols = names.len();
        i += 1;
        let mut nrows = 0usize;
        while i < lines.len() {
            let cells: Vec<&str> = lines[i].split('\t').collect();
            if cells.len() != ncols {
                break;
            }
            if nrows > 0 {
                for _ in 0..gap {
                    out.push(String::new());
                }
            }
            nrows += 1;
            out.push(format!("[{}]", cells[0]));
            for (k, v) in names[1..].iter().zip(cells[1..].iter()) {
                out.push(format!("{}{}{}", k, sep, v));
            }
            i += 1;
        }
        if nrows == 0 {
            return None;
        }
    }
    Some(out.join("\n"))
}

/// `[[dependency.0]]` + `key = value` blokları → şema + TSV.
/// TOML dizi-tabloları XML/SQL/INI ile aynı kurala uyar: anahtarlar bir kez,
/// bölüm indeksi bir kolon, değerler ham (tırnaklar korunur).
pub fn toml_encode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut changed = false;
    while i < lines.len() {
        let t = lines[i].trim();
        if !(t.starts_with("[[") && t.ends_with("]]")) {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let inner = &t[2..t.len() - 2];
        let Some((prefix, _)) = inner.rsplit_once('.') else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let mut k = i + 1;
        let mut first_keys: Vec<String> = Vec::new();
        let mut ok = true;
        while k < lines.len() {
            let lt = lines[k].trim();
            if lt.is_empty() || lt.starts_with('[') {
                break;
            }
            let Some(eq) = lt.find('=') else {
                ok = false;
                break;
            };
            let key = lt[..eq].trim().to_string();
            if key.is_empty() || lt[eq + 1..].contains('\t') {
                ok = false;
                break;
            }
            first_keys.push(key);
            k += 1;
        }
        if !ok || first_keys.len() < 2 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }

        struct Block {
            idx: usize,
            vals: Vec<String>,
        }
        let mut blocks: Vec<Block> = Vec::new();
        let mut m = i;
        let mut gap: Option<usize> = None;
        loop {
            let before_blanks = m;
            let mut blanks = 0usize;
            while m < lines.len() && lines[m].trim().is_empty() {
                blanks += 1;
                m += 1;
            }
            let Some(header) = lines.get(m).map(|l| l.trim()) else {
                m = before_blanks;
                break;
            };
            if !(header.starts_with("[[") && header.ends_with("]]")) {
                m = before_blanks;
                break;
            }
            let hinner = &header[2..header.len() - 2];
            let Some((hprefix, hidx)) = hinner.rsplit_once('.') else {
                m = before_blanks;
                break;
            };
            if hprefix != prefix {
                m = before_blanks;
                break;
            }
            let Ok(idx) = hidx.parse::<usize>() else {
                m = before_blanks;
                break;
            };
            if !blocks.is_empty() {
                match gap {
                    None => gap = Some(blanks),
                    Some(g) if g != blanks => {
                        m = before_blanks;
                        break;
                    }
                    _ => {}
                }
            }
            let mut vals: Vec<String> = Vec::new();
            let mut kk = m + 1;
            let mut ok = true;
            while kk < lines.len() {
                let lt = lines[kk].trim();
                if lt.is_empty() || lt.starts_with('[') {
                    break;
                }
                let Some(eq) = lt.find('=') else {
                    ok = false;
                    break;
                };
                if lt[..eq].trim() != first_keys[vals.len().min(first_keys.len() - 1)] {
                    ok = false;
                    break;
                }
                vals.push(lt[eq + 1..].trim().to_string());
                kk += 1;
            }
            if !ok || vals.len() != first_keys.len() {
                m = before_blanks;
                break;
            }
            blocks.push(Block { idx, vals });
            m = kk;
        }
        if blocks.len() < 4 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let type_of = |v: &str| -> &'static str {
            if !v.is_empty() && v.parse::<i64>().is_ok() {
                "int"
            } else if matches!(v, "true" | "false") {
                "bool"
            } else {
                "str"
            }
        };
        let mut cols: Vec<String> = vec!["@index(int)".to_string()];
        for (ci, key) in first_keys.iter().enumerate() {
            let kinds: Vec<&str> = blocks.iter().map(|b| type_of(&b.vals[ci])).collect();
            let kind = if kinds.iter().all(|k| *k == "int") {
                "int"
            } else if kinds.iter().all(|k| *k == "bool") {
                "bool"
            } else {
                "str"
            };
            cols.push(format!("{}({})", key, kind));
        }
        out.push(format!(
            "#toml [[{}]] {} | gap: {}",
            prefix,
            cols.join(", "),
            gap.unwrap_or(0)
        ));
        for b in &blocks {
            let mut row = vec![b.idx.to_string()];
            row.extend(b.vals.iter().cloned());
            out.push(row.join("\t"));
        }
        changed = true;
        i = m;
    }
    if !changed {
        return None;
    }
    Some(out.join("\n"))
}

pub fn toml_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("#toml [[") else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let (prefix, meta) = rest.split_once("]] ")?;
        let (cols_s, gap_s) = meta.split_once(" | gap: ")?;
        let gap: usize = gap_s.trim().parse().ok()?;
        let cols: Vec<&str> = cols_s.split(", ").collect();
        let names: Vec<&str> = cols
            .iter()
            .map(|c| c.split_once('(').map(|(n, _)| n).unwrap_or(c))
            .collect();
        if names.first() != Some(&"@index") || names.len() < 2 {
            return None;
        }
        let ncols = names.len();
        i += 1;
        let mut nrows = 0usize;
        while i < lines.len() {
            let cells: Vec<&str> = lines[i].split('\t').collect();
            if cells.len() != ncols {
                break;
            }
            if nrows > 0 {
                for _ in 0..gap {
                    out.push(String::new());
                }
            }
            nrows += 1;
            out.push(format!("[[{}.{}]]", prefix, cells[0]));
            for (k, v) in names[1..].iter().zip(cells[1..].iter()) {
                out.push(format!("{} = {}", k, v));
            }
            i += 1;
        }
        if nrows == 0 {
            return None;
        }
    }
    Some(out.join("\n"))
}

/// Düz YAML liste (`- key: value` + devam satırları) → şema + TSV.
/// Yalnız tek seviyeli, aynı anahtar sırasına sahip, en az 4 kayıtlık listeler
/// dönüştürülür. Değerler ham korunur (tırnaklar dahil).
pub fn yaml_encode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut changed = false;
    while i < lines.len() {
        let Some((base_indent, first_key, first_val)) = parse_yaml_entry_head(lines[i]) else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let child_indent = base_indent + 2;
        // İlk kaydın tüm alanları
        let mut keys = vec![first_key];
        let mut vals = vec![first_val];
        let mut k = i + 1;
        while k < lines.len() {
            let Some((ind, key, val)) = parse_yaml_kv(lines[k]) else { break };
            if ind != child_indent {
                break;
            }
            keys.push(key);
            vals.push(val);
            k += 1;
        }
        if keys.len() < 2 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }

        struct Entry {
            vals: Vec<String>,
        }
        let mut entries: Vec<Entry> = Vec::new();
        let mut m = i;
        let mut gap: Option<usize> = None;
        loop {
            let before_blanks = m;
            let mut blanks = 0usize;
            while m < lines.len() && lines[m].trim().is_empty() {
                blanks += 1;
                m += 1;
            }
            let Some((ind, key, val)) = lines.get(m).copied().and_then(parse_yaml_entry_head) else {
                m = before_blanks;
                break;
            };
            if ind != base_indent || key != keys[0] {
                m = before_blanks;
                break;
            }
            if !entries.is_empty() {
                match gap {
                    None => gap = Some(blanks),
                    Some(g) if g != blanks => {
                        m = before_blanks;
                        break;
                    }
                    _ => {}
                }
            }
            let mut evals = vec![val];
            let mut ok = true;
            let mut kk = m + 1;
            while kk < lines.len() {
                let Some((ci, ck, cv)) = parse_yaml_kv(lines[kk]) else { break };
                if ci != child_indent {
                    break;
                }
                if evals.len() >= keys.len() || ck != keys[evals.len()] {
                    ok = false;
                    break;
                }
                evals.push(cv);
                kk += 1;
            }
            if !ok || evals.len() != keys.len() {
                m = before_blanks;
                break;
            }
            entries.push(Entry { vals: evals });
            m = kk;
        }
        if entries.len() < 4 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let type_of = |v: &str| -> &'static str {
            if !v.is_empty() && v.parse::<i64>().is_ok() {
                "int"
            } else if matches!(v, "true" | "false") {
                "bool"
            } else {
                "str"
            }
        };
        let mut cols: Vec<String> = Vec::new();
        for (ci, key) in keys.iter().enumerate() {
            let kinds: Vec<&str> = entries.iter().map(|e| type_of(&e.vals[ci])).collect();
            let kind = if kinds.iter().all(|k2| *k2 == "int") {
                "int"
            } else if kinds.iter().all(|k2| *k2 == "bool") {
                "bool"
            } else {
                "str"
            };
            cols.push(format!("{}({})", key, kind));
        }
        out.push(format!(
            "#yaml list {} | indent: {} | gap: {}",
            cols.join(", "),
            base_indent,
            gap.unwrap_or(0)
        ));
        for e in &entries {
            out.push(e.vals.join("\t"));
        }
        changed = true;
        i = m;
    }
    if !changed {
        return None;
    }
    Some(out.join("\n"))
}

/// `  - key: value` → (girinti, anahtar, değer)
fn parse_yaml_entry_head(line: &str) -> Option<(usize, String, String)> {
    let ind = line.len() - line.trim_start().len();
    let t = line.trim_start();
    let rest = t.strip_prefix("- ")?;
    let (key, val) = split_yaml_kv(rest)?;
    Some((ind, key, val))
}

/// `  key: value` → (girinti, anahtar, değer)
fn parse_yaml_kv(line: &str) -> Option<(usize, String, String)> {
    let ind = line.len() - line.trim_start().len();
    let t = line.trim_start();
    if t.starts_with('-') {
        return None;
    }
    let (key, val) = split_yaml_kv(t)?;
    Some((ind, key, val))
}

fn split_yaml_kv(s: &str) -> Option<(String, String)> {
    let (key, val) = s.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || key.contains('\t') || key.contains(' ') {
        return None;
    }
    let val = val.trim();
    if val.is_empty() || val.contains('\t') {
        return None;
    }
    Some((key.to_string(), val.to_string()))
}

pub fn yaml_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("#yaml list ") else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let (cols_s, meta) = rest.split_once(" | indent: ")?;
        let (ind_s, gap_s) = meta.split_once(" | gap: ")?;
        let indent: usize = ind_s.trim().parse().ok()?;
        let gap: usize = gap_s.trim().parse().ok()?;
        let cols: Vec<&str> = cols_s.split(", ").collect();
        let names: Vec<&str> = cols
            .iter()
            .map(|c| c.split_once('(').map(|(n, _)| n).unwrap_or(c))
            .collect();
        if names.len() < 2 {
            return None;
        }
        let ncols = names.len();
        let pad = " ".repeat(indent);
        i += 1;
        let mut nrows = 0usize;
        while i < lines.len() {
            let cells: Vec<&str> = lines[i].split('\t').collect();
            if cells.len() != ncols {
                break;
            }
            if nrows > 0 {
                for _ in 0..gap {
                    out.push(String::new());
                }
            }
            nrows += 1;
            out.push(format!("{}- {}: {}", pad, names[0], cells[0]));
            for (k, v) in names[1..].iter().zip(cells[1..].iter()) {
                out.push(format!("{}  {}: {}", pad, k, v));
            }
            i += 1;
        }
        if nrows == 0 {
            return None;
        }
    }
    Some(out.join("\n"))
}

/// Kayıpsız doğrulanmış en küçük düz-tablo temsilini döndürür.
///
/// Tokenizer bilmez; iki aday arasından baytça küçüğünü seçer. Karar motoru
/// gerçek token kazancını yine kendisi ölçer. Kayıpsızlık burada kanıtlanır.
pub fn compress(text: &str) -> Option<(String, PlainKind)> {
    let mut best: Option<(usize, String, PlainKind)> = None;
    type CodecFn = fn(&str) -> Option<String>;
    let candidates: [(PlainKind, CodecFn, CodecFn); 5] = [
        (PlainKind::Xml, xml_plain_encode, xml_plain_decode),
        (PlainKind::Sql, sql_plain_encode, sql_plain_decode),
        (PlainKind::Ini, ini_encode, ini_decode),
        (PlainKind::Toml, toml_encode, toml_decode),
        (PlainKind::Yaml, yaml_encode, yaml_decode),
    ];
    for (kind, enc, dec) in candidates {
        let Some(out) = enc(text) else { continue };
        if dec(&out).as_deref() != Some(text) {
            continue;
        }
        if best.as_ref().map_or(true, |(len, _, _)| out.len() < *len) {
            best = Some((out.len(), out, kind));
        }
    }
    best.map(|(_, out, kind)| (out, kind))
}

/// Düz tablo temsilini orijinal metne geri çevirir (doğrulama/telemetri için).
pub fn decompress(text: &str) -> Option<String> {
    let has_xml = text.lines().any(|l| l.starts_with("#xml <"));
    let has_sql = text.lines().any(|l| l.starts_with("#sql "));
    match (has_xml, has_sql) {
        (true, false) => xml_plain_decode(text),
        (false, true) => sql_plain_decode(text),
        (false, false) if text.lines().any(|l| l.starts_with("#ini section ")) => {
            ini_decode(text)
        }
        (false, false) if text.lines().any(|l| l.starts_with("#toml [[")) => {
            toml_decode(text)
        }
        (false, false) if text.lines().any(|l| l.starts_with("#yaml list ")) => {
            yaml_decode(text)
        }
        _ => None,
    }
}


/// `<item id="0" enabled="true">` → (tag, [(ad, değer)], kapanış var mı)
fn parse_xml_open(line: &str) -> Option<(String, Vec<(String, String)>)> {
    let t = line.trim_start();
    if !t.starts_with('<') || t.starts_with("</") || t.starts_with("<?") || t.starts_with("<!") {
        return None;
    }
    let end = t.find('>')?;
    let inner = &t[1..end];
    if inner.ends_with('/') || inner.trim().is_empty() {
        return None;
    }
    let mut parts = inner.split_whitespace();
    let tag = parts.next()?.to_string();
    if tag.contains('=') {
        return None;
    }
    let mut attrs = Vec::new();
    let rest = inner[tag.len()..].trim();
    if !rest.is_empty() {
        let mut i = 0usize;
        let bytes: Vec<char> = rest.chars().collect();
        while i < bytes.len() {
            while i < bytes.len() && bytes[i].is_whitespace() {
                i += 1;
            }
            let name_start = i;
            while i < bytes.len() && bytes[i] != '=' && !bytes[i].is_whitespace() {
                i += 1;
            }
            if i == name_start {
                break;
            }
            let name: String = bytes[name_start..i].iter().collect();
            while i < bytes.len() && bytes[i].is_whitespace() {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != '=' {
                return None;
            }
            i += 1;
            while i < bytes.len() && bytes[i].is_whitespace() {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != '"' {
                return None;
            }
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != '"' {
                i += 1;
            }
            if i >= bytes.len() {
                return None;
            }
            let value: String = bytes[val_start..i].iter().collect();
            i += 1;
            attrs.push((name, value));
        }
    }
    Some((tag, attrs))
}

/// Tek satırlık `<child>değer</child>` → (ad, değer)
fn parse_xml_child(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    if !t.starts_with('<') || t.starts_with("</") {
        return None;
    }
    let open_end = t.find('>')?;
    let tag = &t[1..open_end];
    if tag.is_empty() || tag.contains(' ') || tag.contains('/') {
        return None;
    }
    let close = format!("</{}>", tag);
    if !t.ends_with(&close) {
        return None;
    }
    let value = &t[open_end + 1..t.len() - close.len()];
    if value.contains('<') || value.contains('\t') {
        return None;
    }
    Some((tag.to_string(), value.to_string()))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

pub fn xml_plain_encode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut changed = false;
    while i < lines.len() {
        let Some((tag, attrs)) = parse_xml_open(lines[i]) else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let block_indent = indent_of(lines[i]);
        let close = format!("</{}>", tag);
        // Blok sonu
        let mut j = i + 1;
        while j < lines.len() && lines[j].trim() != close {
            j += 1;
        }
        if j >= lines.len() {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        // Çocuklar tek satırlık olmalı; şema ilk bloktan çıkarılır.
        let mut children: Vec<(String, String)> = Vec::new();
        let mut child_indent = None;
        let mut ok = true;
        for line in &lines[i + 1..j] {
            if line.trim().is_empty() {
                continue;
            }
            match parse_xml_child(line) {
                Some((n, v)) => {
                    if child_indent.is_none() {
                        child_indent = Some(indent_of(line));
                    }
                    children.push((n, v));
                }
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok || children.is_empty() || child_indent.is_none() {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        // Aynı yapıdaki ARDIŞIK blokları topla (sıra korunur).
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut blocks = 0usize;
        let mut k = i;
        while k < lines.len() {
            let Some((t2, a2)) = parse_xml_open(lines[k]) else { break };
            if t2 != tag
                || a2.len() != attrs.len()
                || a2.iter().zip(attrs.iter()).any(|(x, y)| x.0 != y.0)
            {
                break;
            }
            let c2 = format!("</{}>", tag);
            let mut m = k + 1;
            while m < lines.len() && lines[m].trim() != c2 {
                m += 1;
            }
            if m >= lines.len() {
                break;
            }
            let mut vals: Vec<String> = a2.iter().map(|(_, v)| v.clone()).collect();
            let mut ch_names: Vec<String> = Vec::new();
            let mut bad = false;
            for line in &lines[k + 1..m] {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_xml_child(line) {
                    Some((n, v)) => {
                        ch_names.push(n);
                        vals.push(v);
                    }
                    None => {
                        bad = true;
                        break;
                    }
                }
            }
            let expect: Vec<String> = children.iter().map(|(n, _)| n.clone()).collect();
            if bad || ch_names != expect || vals.iter().any(|v| v.contains('\t')) {
                break;
            }
            rows.push(vals);
            blocks += 1;
            k = m + 1;
        }
        if blocks < 4 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let attr_names: Vec<&str> = attrs.iter().map(|(n, _)| n.as_str()).collect();
        let child_names: Vec<&str> = children.iter().map(|(n, _)| n.as_str()).collect();
        // Doğal dilde şema: "attrs=id,role" modelde sütun eşlemesini bozuyordu
        // (TRIALS-018: min id 0 yerine 1). "attrs: id role | children: ..."
        // hem insan hem model için okunur, ayrıştırması da basit.
        // "@" öneki: adın DEĞER değil KOLON olduğunu model için açık kılar.
        // "(int)" tipi: "en büyük id" sorusunda model metin sütununa kayıyordu
        // (TRIALS-018: id yerine P-049). Tip, kolonun sayı olduğunu söyler.
        let col_type = |k: usize| -> &'static str {
            let vals: Vec<&str> = rows.iter().map(|r| r[k].as_str()).collect();
            if vals.iter().all(|v| !v.is_empty() && v.parse::<i64>().is_ok()) {
                "int"
            } else if vals.iter().all(|v| matches!(*v, "true" | "false")) {
                "bool"
            } else {
                "str"
            }
        };
        let attrs_join = if attr_names.is_empty() {
            "-".to_string()
        } else {
            attr_names
                .iter()
                .enumerate()
                .map(|(k, n)| format!("@{}({})", n, col_type(k)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let children_join = child_names
            .iter()
            .enumerate()
            .map(|(k, n)| format!("{}({})", n, col_type(attr_names.len() + k)))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!(
            "#xml <{}> attrs: {} | children: {} | indent: {} {}",
            tag,
            attrs_join,
            children_join,
            block_indent,
            child_indent.unwrap_or(block_indent + 2)
        ));
        for r in &rows {
            out.push(r.join("\t"));
        }
        changed = true;
        i = k;
    }
    if !changed {
        return None;
    }
    Some(out.join("\n"))
}

pub fn xml_plain_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("#xml <") else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let (tag, meta) = rest.split_once("> attrs: ")?;
        let (attrs_s, meta) = meta.split_once(" | children: ")?;
        let (children_s, indent_s) = meta.split_once(" | indent: ")?;
        let (bi, ci) = indent_s.split_once(' ')?;
        let block_indent: usize = bi.parse().ok()?;
        let child_indent: usize = ci.parse().ok()?;
        let attr_names: Vec<&str> = if attrs_s == "-" {
            Vec::new()
        } else {
            attrs_s
                .split(", ")
                .map(|n| n.strip_prefix('@').unwrap_or(n))
                .map(|n| n.split_once('(').map(|(base, _)| base).unwrap_or(n))
                .collect()
        };
        let child_names: Vec<&str> = children_s
            .split(", ")
            .map(|n| n.split_once('(').map(|(base, _)| base).unwrap_or(n))
            .collect();
        let cols = attr_names.len() + child_names.len();
        let pad_b = " ".repeat(block_indent);
        let pad_c = " ".repeat(child_indent);
        i += 1;
        while i < lines.len() {
            let line = lines[i];
            if line.starts_with("#xml ") {
                break;
            }
            let cells: Vec<&str> = line.split('\t').collect();
            if cells.len() != cols {
                break;
            }
            let attrs: Vec<String> = attr_names
                .iter()
                .zip(cells.iter())
                .map(|(n, v)| format!("{}=\"{}\"", n, v))
                .collect();
            let open = if attrs.is_empty() {
                format!("{}<{}>", pad_b, tag)
            } else {
                format!("{}<{} {}>", pad_b, tag, attrs.join(" "))
            };
            out.push(open);
            for (n, v) in child_names.iter().zip(cells[attr_names.len()..].iter()) {
                out.push(format!("{}<{}>{}</{}>", pad_c, n, v, n));
            }
            out.push(format!("{}</{}>", pad_b, tag));
            i += 1;
        }
    }
    Some(out.join("\n"))
}

/// SQL hücrelerini tırnak/parentez farkındalığıyla böler.
pub fn split_sql_cells(s: &str) -> Option<Vec<String>> {
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut depth = 0i32;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if in_quote {
            cur.push(c);
            if c == '\'' {
                if i + 1 < chars.len() && chars[i + 1] == '\'' {
                    cur.push('\'');
                    i += 1;
                } else {
                    in_quote = false;
                }
            }
        } else if c == '\'' {
            in_quote = true;
            cur.push(c);
        } else if c == '(' {
            depth += 1;
            cur.push(c);
        } else if c == ')' {
            depth -= 1;
            cur.push(c);
        } else if c == ',' && depth == 0 {
            cells.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(c);
        }
        i += 1;
    }
    if in_quote || depth != 0 {
        return None;
    }
    cells.push(cur.trim().to_string());
    Some(cells)
}

pub fn sql_plain_encode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut changed = false;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        let upper = trimmed.to_ascii_uppercase();
        if !upper.starts_with("INSERT INTO ") || !upper.ends_with("VALUES") {
            out.push(line.to_string());
            i += 1;
            continue;
        }
        let head = trimmed[..trimmed.len() - "VALUES".len()].trim();
        let rest = &head["INSERT INTO ".len()..];
        let Some((table, cols_raw)) = rest.split_once(" (") else {
            out.push(line.to_string());
            i += 1;
            continue;
        };
        let Some(cols) = cols_raw.strip_suffix(')') else {
            out.push(line.to_string());
            i += 1;
            continue;
        };
        // Gövde: her satır bir demet; son satır ';' ile biter.
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut k = i + 1;
        let mut terminated = false;
        while k < lines.len() {
            let t = lines[k].trim();
            let t = t.strip_suffix(';').unwrap_or(t);
            let t = t.strip_suffix(',').unwrap_or(t);
            if !t.starts_with('(') || !t.ends_with(')') {
                break;
            }
            let inner = &t[1..t.len() - 1];
            let Some(cells) = split_sql_cells(inner) else { break };
            if cells.len() != cols.split(',').count() || cells.iter().any(|c| c.contains('\t')) {
                break;
            }
            rows.push(cells);
            if lines[k].trim_end().ends_with(';') {
                terminated = true;
                k += 1;
                break;
            }
            k += 1;
        }
        if rows.len() < 4 || !terminated {
            out.push(line.to_string());
            i += 1;
            continue;
        }
        // Sütun tipleri: s=tırnaklı metin, b=boolean, i=tam sayı, -=ham.
        // Tırnak ve true/false yazımı TABLOYA taşınmaz; şema satırı geri getirir.
        let ncols = cols.split(',').count();
        let mut types = String::with_capacity(ncols);
        for c in 0..ncols {
            let cell = |r: &Vec<String>| r[c].clone();
            let all_quoted = rows.iter().all(|r| {
                let v = cell(r);
                v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'')
                    && !v[1..v.len() - 1].contains('\'')
            });
            let all_bool = rows.iter().all(|r| matches!(cell(r).as_str(), "true" | "false"));
            let all_int = rows.iter().all(|r| {
                let v = cell(r);
                !v.is_empty() && v.chars().all(|ch| ch.is_ascii_digit() || ch == '-')
            });
            types.push(if all_quoted {
                's'
            } else if all_bool {
                'b'
            } else if all_int {
                'i'
            } else {
                '-'
            });
        }
        out.push(format!("#sql {} ({}) types={}", table, cols, types));
        for r in &rows {
            let cells: Vec<String> = r
                .iter()
                .zip(types.chars())
                .map(|(v, t)| match t {
                    's' => v[1..v.len() - 1].to_string(),
                    'b' => if v == "true" { "t".into() } else { "f".into() },
                    _ => v.clone(),
                })
                .collect();
            out.push(cells.join("\t"));
        }
        changed = true;
        i = k;
    }
    if !changed {
        return None;
    }
    Some(out.join("\n"))
}

pub fn sql_plain_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("#sql ") else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        let (table, tail) = rest.split_once(" (")?;
        let (cols, types) = tail.split_once(") types=")?;
        let ncols = cols.split(',').count();
        if types.chars().count() != ncols {
            return None;
        }
        out.push(format!("INSERT INTO {} ({}) VALUES", table, cols));
        i += 1;
        let mut nrows = 0usize;
        while i < lines.len() {
            let cells: Vec<&str> = lines[i].split('\t').collect();
            if cells.len() != ncols {
                break;
            }
            nrows += 1;
            let suffix = if i + 1 < lines.len() {
                let next_is_row = lines[i + 1].split('\t').count() == ncols
                    && !lines[i + 1].starts_with("#sql ");
                if next_is_row { "," } else { ";" }
            } else {
                ";"
            };
            let rendered: Vec<String> = cells
                .iter()
                .zip(types.chars())
                .map(|(v, t)| match t {
                    's' => format!("'{}'", v),
                    'b' => if *v == "t" { "true".into() } else { "false".into() },
                    _ => (*v).to_string(),
                })
                .collect();
            out.push(format!("({}){}", rendered.join(", "), suffix));
            i += 1;
        }
        if nrows == 0 {
            return None;
        }
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xml_doc() -> String {
        let mut s = String::from("<services>
");
        for i in 0..8 {
            s.push_str(&format!(
                "  <item id=\"{}\" enabled=\"true\">
    <name>svc-{:02}</name>
    <port>{}</port>
  </item>
",
                i,
                i,
                8000 + i
            ));
        }
        s.push_str("</services>
");
        s
    }

    fn sql_doc() -> String {
        let mut s = String::from("INSERT INTO users (id, email, status) VALUES
");
        for i in 0..8 {
            let sep = if i == 7 { ";" } else { "," };
            s.push_str(&format!(
                "({}, 'u{}@example.com', '{}'){}
",
                i,
                i,
                if i % 2 == 0 { "active" } else { "trial" },
                sep
            ));
        }
        s
    }

    #[test]
    fn xml_round_trips() {
        let doc = xml_doc();
        let out = xml_plain_encode(&doc).expect("xml adayı");
        assert!(out.contains("#xml <item> attrs: @id(int), @enabled(bool)"));
        assert_eq!(xml_plain_decode(&out).unwrap(), doc);
    }

    #[test]
    fn sql_round_trips() {
        let doc = sql_doc();
        let out = sql_plain_encode(&doc).expect("sql adayı");
        assert!(out.contains("types=iss"));
        assert_eq!(sql_plain_decode(&out).unwrap(), doc);
    }

    #[test]
    fn compress_verifies_and_rejects_prose() {
        let (out, kind) = compress(&xml_doc()).expect("dönüşmeli");
        assert_eq!(kind, PlainKind::Xml);
        assert_eq!(decompress(&out).unwrap(), xml_doc());
        assert!(compress("Bu bir düz metindir, tablo yok.").is_none());
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::*;

    fn nl() -> char {
        '\n'
    }

    fn ini_doc() -> String {
        let n = nl();
        let mut s = String::new();
        for i in 0..8 {
            s.push_str(&format!("[profile_{:02}]{n}host = db-{:02}.internal{n}port = 5432{n}sslmode = require{n}{n}", i, i));
        }
        s
    }

    fn toml_doc() -> String {
        let n = nl();
        let mut s = String::new();
        for i in 0..8 {
            s.push_str(&format!(
                "[[dependency.{}]]{n}name = \"crate-{:02}\"{n}version = \"1.4\"{n}optional = false{n}{n}",
                i, i
            ));
        }
        s
    }

    fn yaml_doc() -> String {
        let n = nl();
        let mut s = String::from("workers:");
        s.push(n);
        for i in 0..8 {
            s.push_str(&format!(
                "  - id: {}{n}    name: worker-{:03}{n}    replicas: {}{n}    active: {}{n}",
                i,
                i,
                1 + i % 4,
                if i % 2 == 0 { "true" } else { "false" }
            ));
        }
        s
    }

    #[test]
    fn ini_round_trips() {
        let doc = ini_doc();
        let out = ini_encode(&doc).expect("ini adayi");
        assert!(out.contains("#ini section @name(str)"));
        assert_eq!(ini_decode(&out).unwrap(), doc);
        assert!(compress(&doc).is_some());
    }

    #[test]
    fn toml_round_trips() {
        let doc = toml_doc();
        let out = toml_encode(&doc).expect("toml adayi");
        assert!(out.contains("#toml [[dependency]]"));
        assert_eq!(toml_decode(&out).unwrap(), doc);
    }

    #[test]
    fn yaml_round_trips() {
        let doc = yaml_doc();
        let out = yaml_encode(&doc).expect("yaml adayi");
        assert!(out.contains("#yaml list"));
        assert_eq!(yaml_decode(&out).unwrap(), doc);
    }

    #[test]
    fn adapters_reject_non_uniform_input() {
        // Anahtar sirasi bozuk → donusum yok (ham kalir).
        let doc = "[a]\nx = 1\ny = 2\n\n[b]\ny = 2\nx = 1\n\n[c]\nx = 1\ny = 2\n\n[d]\nx = 1\ny = 2\n";
        assert!(ini_encode(doc).is_none() || ini_decode(&ini_encode(doc).unwrap()).as_deref() != Some(doc));
    }
}

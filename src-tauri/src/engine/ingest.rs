// Yapısal metin ingest katmanı: JSON dışı ama tanımlı gramerli formatları
// (JSONL, CSV/TSV, logfmt, markdown tablo) serde_json::Value dizilerine
// çevirir → mevcut kayıpsız @T motoruna beslenir.
//
// Sözleşme (JSON kademesiyle aynı): ayrıştırma Value düzeyinde yapılır ve
// sıkıştırma sonrası round-trip bu Value ile doğrulanır. Yani veri kayıpsızdır;
// yalnızca gösterim biçimi JSON'a normalleşir. Ayrıştırılamayan her şey
// passthrough kalır (hata-güvenli).
//
// Kayıpsızlık detayı: sayıya benzeyen hücreler yalnızca kanonik geri dönüş
// yapıyorsa (ör. "42") sayıya çevrilir; "007", "1.50" gibi biçimli değerler
// string olarak korunur (değer kaybı yok).

use serde_json::{Map, Value};

pub struct Ingested {
    pub format: &'static str,
    pub value: Value,
}

const MIN_LINES: usize = 3;

pub fn try_ingest(lines: &[&str]) -> Option<Ingested> {
    if lines.len() < MIN_LINES {
        return None;
    }
    try_jsonl(lines)
        .or_else(|| try_md_table(lines))
        .or_else(|| try_delimited(lines))
        .or_else(|| try_logfmt(lines))
}

/// "42" → 42, "007"/"1.50" → string (biçim korunur).
fn num(s: &str) -> Value {
    let t = s.trim();
    if let Ok(n) = t.parse::<i64>() {
        if n.to_string() == t {
            return Value::Number(n.into());
        }
    }
    if let Ok(f) = t.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            if n.to_string() == t {
                return Value::Number(n);
            }
        }
    }
    match t {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => Value::String(t.to_string()),
    }
}

// --- JSONL / NDJSON ---------------------------------------------------------

fn try_jsonl(lines: &[&str]) -> Option<Ingested> {
    let mut items = Vec::with_capacity(lines.len());
    for line in lines {
        let t = line.trim();
        if t.is_empty() {
            return None;
        }
        let v: Value = serde_json::from_str(t).ok()?;
        if !v.is_object() {
            return None;
        }
        items.push(v);
    }
    Some(Ingested {
        format: "jsonl",
        value: Value::Array(items),
    })
}

// --- logfmt -----------------------------------------------------------------

fn parse_logfmt_line(line: &str) -> Option<Vec<(String, Value)>> {
    let bytes = line.as_bytes();
    let mut pairs = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let key_start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.' || bytes[i] == b'-')
        {
            i += 1;
        }
        if i == key_start || i >= bytes.len() || bytes[i] != b'=' {
            return None;
        }
        let key = line[key_start..i].to_string();
        i += 1;
        let val: String = if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let vs = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            if i >= bytes.len() {
                return None;
            }
            let v = line[vs..i].to_string();
            i += 1;
            v
        } else {
            let vs = i;
            while i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
                i += 1;
            }
            line[vs..i].to_string()
        };
        pairs.push((key, num(&val)));
    }
    if pairs.len() >= 2 {
        Some(pairs)
    } else {
        None
    }
}

fn try_logfmt(lines: &[&str]) -> Option<Ingested> {
    let first = parse_logfmt_line(lines[0])?;
    let keys: Vec<String> = first.iter().map(|(k, _)| k.clone()).collect();

    let mut items = Vec::with_capacity(lines.len());
    for line in lines {
        let pairs = parse_logfmt_line(line)?;
        if pairs.len() != keys.len()
            || pairs.iter().zip(&keys).any(|((k, _), ek)| k != ek)
        {
            return None; // kolon düzeni bozuldu → güvenli vazgeç
        }
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert(k, v);
        }
        items.push(Value::Object(m));
    }
    Some(Ingested {
        format: "logfmt",
        value: Value::Array(items),
    })
}

// --- CSV / TSV / boru-ayraçlı ----------------------------------------------

fn split_delim(line: &str, delim: char) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cur.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' && cur.is_empty() {
            in_quotes = true;
        } else if c == delim {
            fields.push(cur);
            cur = String::new();
        } else {
            cur.push(c);
        }
    }
    if in_quotes {
        return None;
    }
    fields.push(cur);
    Some(fields)
}

fn try_delimited(lines: &[&str]) -> Option<Ingested> {
    for delim in [',', '\t', ';'] {
        let Some(header) = split_delim(lines[0], delim) else {
            continue;
        };
        if header.len() < 2 {
            continue;
        }
        let mut rows = vec![header.clone()];
        let mut all_ok = true;
        for line in &lines[1..] {
            match split_delim(line, delim) {
                Some(f) if f.len() == header.len() => rows.push(f),
                _ => {
                    all_ok = false;
                    break;
                }
            }
        }
        if all_ok && rows.len() >= MIN_LINES {
            let items: Vec<Value> = rows[1..]
                .iter()
                .map(|row| {
                    let mut m = Map::new();
                    for (h, v) in header.iter().zip(row) {
                        m.insert(h.trim().to_string(), num(v));
                    }
                    Value::Object(m)
                })
                .collect();
            return Some(Ingested {
                format: "csv",
                value: Value::Array(items),
            });
        }
    }
    None
}

// --- Markdown tablo ---------------------------------------------------------

fn md_cells(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    t.split('|').map(|c| c.trim().to_string()).collect()
}

fn is_separator(cells: &[String]) -> bool {
    cells.iter().all(|c| {
        !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':' || ch == ' ')
    })
}

fn try_md_table(lines: &[&str]) -> Option<Ingested> {
    let header = md_cells(lines[0]);
    if header.len() < 2 || lines.len() < 4 {
        return None;
    }
    let sep = md_cells(lines[1]);
    if sep.len() != header.len() || !is_separator(&sep) {
        return None;
    }
    let mut items = Vec::new();
    for line in &lines[2..] {
        let cells = md_cells(line);
        if cells.len() != header.len() {
            return None;
        }
        let mut m = Map::new();
        for (h, v) in header.iter().zip(&cells) {
            m.insert(h.clone(), num(v));
        }
        items.push(Value::Object(m));
    }
    Some(Ingested {
        format: "md-table",
        value: Value::Array(items),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_block_parses() {
        let lines = vec![
            r#"{"id":1,"type":"t"}"#,
            r#"{"id":2,"type":"t"}"#,
            r#"{"id":3,"type":"t"}"#,
        ];
        let ing = try_ingest(&lines).unwrap();
        assert_eq!(ing.format, "jsonl");
        assert_eq!(ing.value.as_array().unwrap().len(), 3);
    }

    #[test]
    fn csv_with_quotes_parses() {
        let lines = vec![
            "id,name,note",
            "1,\"Say, Ali\",ok",
            "2,\"X \"\"Y\"\"\",warn",
            "3,last,fail",
        ];
        let ing = try_ingest(&lines).unwrap();
        assert_eq!(ing.format, "csv");
        let row0 = &ing.value.as_array().unwrap()[0];
        assert_eq!(row0["name"], "Say, Ali");
        assert_eq!(row0["id"], 1);
    }

    #[test]
    fn logfmt_uniform_keys_parse() {
        let lines = vec![
            "ts=2024-01-01T10:00:01Z level=info service=api msg=\"ok\"",
            "ts=2024-01-01T10:00:02Z level=info service=api msg=\"slow\"",
            "ts=2024-01-01T10:00:03Z level=error service=api msg=\"bad\"",
        ];
        let ing = try_ingest(&lines).unwrap();
        assert_eq!(ing.format, "logfmt");
        assert_eq!(ing.value.as_array().unwrap()[0]["level"], "info");
        assert_eq!(ing.value.as_array().unwrap()[2]["level"], "error");
    }

    #[test]
    fn markdown_table_parses() {
        let lines = vec![
            "| id | city |",
            "|---|---|",
            "| 1 | Ankara |",
            "| 2 | İzmir |",
        ];
        let ing = try_ingest(&lines).unwrap();
        assert_eq!(ing.format, "md-table");
        assert_eq!(ing.value.as_array().unwrap()[1]["city"], "İzmir");
    }

    #[test]
    fn formatted_numbers_stay_strings() {
        let lines = vec!["code,qty", "007,1", "042,2", "009,3"];
        let ing = try_ingest(&lines).unwrap();
        let rows = ing.value.as_array().unwrap();
        assert_eq!(rows[0]["code"], "007"); // biçimli sayı string kalır
        assert_eq!(rows[0]["qty"], 1);
    }

    #[test]
    fn garbage_lines_are_rejected() {
        let lines = vec!["selam", "nedir", "nasılsın"];
        assert!(try_ingest(&lines).is_none());
    }
}

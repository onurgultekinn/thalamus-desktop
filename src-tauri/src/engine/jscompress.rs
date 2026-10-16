// Kayıpsız TSV/sözlük tabanlı JSON sıkıştırıcı.
// Orijinal `tlm_engine::compressor_json` davranışının seri (rayon'suz) portudur.
use crate::engine::sanitize_json_string;
use serde_json::{Map, Value};
use std::collections::HashMap;

pub struct JsonCompressor;

impl JsonCompressor {
    pub const DELIMITER: char = '\t';

    pub fn compress(raw_json: &str, _is_giant: bool) -> Result<String, &'static str> {
        let sanitized = sanitize_json_string(raw_json);
        let parsed: Value = serde_json::from_str(&sanitized).map_err(|_| "Geçersiz JSON")?;

        match &parsed {
            Value::Array(items) => {
                if items.is_empty() {
                    return Ok(raw_json.to_string());
                }

                let rows: Vec<&Map<String, Value>> =
                    items.iter().filter_map(|item| item.as_object()).collect();

                if rows.is_empty() {
                    return Ok(raw_json.to_string());
                }

                let row_len = rows.len();

                // 1. Tüm Başlıkları Topla
                let mut all_keys: Vec<String> = Vec::with_capacity(16);
                for obj in &rows {
                    for key in obj.keys() {
                        if !all_keys.contains(key) {
                            all_keys.push(key.clone());
                        }
                    }
                }
                all_keys.sort_unstable();

                // 2. Sabit Kolon Tespiti (Constant Column Folding: >= 3 satır ve tüm satırlarda aynı değer)
                let mut constant_columns: HashMap<String, Value> = HashMap::new();
                let mut dynamic_headers: Vec<String> = Vec::with_capacity(all_keys.len());

                if row_len >= 3 {
                    for key in &all_keys {
                        let mut is_constant = true;
                        let first_val = rows[0].get(key);

                        if first_val.is_none() {
                            is_constant = false;
                        } else {
                            for obj in &rows[1..] {
                                if obj.get(key) != first_val {
                                    is_constant = false;
                                    break;
                                }
                            }
                        }

                        if is_constant {
                            if let Some(val) = first_val {
                                constant_columns.insert(key.clone(), val.clone());
                            }
                        } else {
                            dynamic_headers.push(key.clone());
                        }
                    }
                } else {
                    dynamic_headers = all_keys;
                }

                let headers = dynamic_headers;

                // 3. Dinamik Kolonlarda Sözlük & Önek Tespiti
                let mut col_dictionaries: Vec<Option<Vec<String>>> = vec![None; headers.len()];
                let mut col_prefixes: Vec<Option<String>> = vec![None; headers.len()];

                if row_len >= 3 && !headers.is_empty() {
                    for (col_idx, h) in headers.iter().enumerate() {
                        // Sözlük yalnızca kolondaki TÜM değerler string ise güvenlidir:
                        // sözlük indisleri rakam olduğu için sayısal hücrelerle çakışır
                        // (ör. indis "1" ⇄ gerçek sayı 1). Karışık tipli kolonlarda
                        // sözlük atlanır; prefix/raw ile devam edilir (decode güvenli).
                        let has_non_string = rows
                            .iter()
                            .any(|obj| matches!(obj.get(h), Some(v) if !v.is_string()));

                        let mut val_counts: HashMap<&str, usize> = HashMap::new();
                        let mut str_vals: Vec<&str> = Vec::new();

                        for obj in &rows {
                            if let Some(Value::String(s)) = obj.get(h) {
                                if !s.contains('\t') && !s.contains('\n') {
                                    *val_counts.entry(s.as_str()).or_insert(0) += 1;
                                    str_vals.push(s.as_str());
                                }
                            }
                        }

                        if !has_non_string
                            && !val_counts.is_empty()
                            && val_counts.len() <= 10
                            && str_vals.len() >= 3
                        {
                            let max_freq = val_counts.values().copied().max().unwrap_or(0);
                            if max_freq >= 2 {
                                let mut dict_items: Vec<String> =
                                    val_counts.keys().map(|&s| s.to_string()).collect();
                                dict_items.sort();
                                col_dictionaries[col_idx] = Some(dict_items);
                                continue;
                            }
                        }

                        if str_vals.len() >= 3 && col_dictionaries[col_idx].is_none() {
                            if let Some(prefix) = Self::detect_common_prefix(&str_vals) {
                                if prefix.len() >= 3 {
                                    col_prefixes[col_idx] = Some(prefix);
                                }
                            }
                        }
                    }
                }

                // 4. Şema Başlığı İnşası (@T(const=val...)\nhead1\thead2\n)
                let mut full_output = String::with_capacity(raw_json.len() + 32);
                full_output.push_str("@T");

                if !constant_columns.is_empty() {
                    full_output.push('(');
                    let mut const_keys: Vec<&String> = constant_columns.keys().collect();
                    const_keys.sort();
                    for (idx, &ck) in const_keys.iter().enumerate() {
                        if idx > 0 {
                            full_output.push(';');
                        }
                        full_output.push_str(ck);
                        full_output.push('=');
                        Self::write_cell(&constant_columns[ck], None, None, &mut full_output);
                    }
                    full_output.push(')');
                }
                full_output.push('\n');

                if !headers.is_empty() {
                    for (i, h) in headers.iter().enumerate() {
                        if i > 0 {
                            full_output.push(Self::DELIMITER);
                        }
                        full_output.push_str(h);

                        if let Some(dict) = &col_dictionaries[i] {
                            full_output.push('(');
                            for (d_idx, d_val) in dict.iter().enumerate() {
                                if d_idx > 0 {
                                    full_output.push(';');
                                }
                                full_output.push_str(&format!("{}={}", d_idx, d_val));
                            }
                            full_output.push(')');
                        } else if let Some(pfix) = &col_prefixes[i] {
                            full_output.push('[');
                            full_output.push_str(pfix);
                            full_output.push(']');
                        }
                    }
                    full_output.push('\n');
                }

                let enable_ditto = row_len >= 4;

                // 5. Satır Kodlama (seri — çıktı paralel sürümle birebir aynıdır)
                if !headers.is_empty() {
                    let mut prev_row: Vec<String> = vec![String::new(); headers.len()];
                    for (i, obj) in rows.iter().enumerate() {
                        Self::write_row(
                            obj,
                            &headers,
                            &col_dictionaries,
                            &col_prefixes,
                            enable_ditto,
                            &mut prev_row,
                            &mut full_output,
                        );
                        if i + 1 < rows.len() {
                            full_output.push('\n');
                        }
                    }
                } else {
                    // Yalnızca sabit kolonlardan oluşan veri için satır sayısı kadar boş satır
                    for i in 0..row_len {
                        if i + 1 < row_len {
                            full_output.push('\n');
                        }
                    }
                }

                // 6. Kayıpsızlık Doğrulaması
                if let Ok(decompressed_val) = Self::decompress(&full_output) {
                    if decompressed_val != parsed {
                        return Err("Kayıpsızlık doğrulaması başarısız.");
                    }
                } else {
                    return Err("Decompress işlemi başarısız.");
                }

                Ok(full_output)
            }

            Value::Object(obj) => {
                if obj.len() < 2 {
                    return Ok(raw_json.to_string());
                }

                let mut full_output = String::with_capacity(raw_json.len() + 16);
                full_output.push_str("@T\nk\tv\n");

                let mut iter = obj.iter().peekable();
                while let Some((k, v)) = iter.next() {
                    full_output.push_str(k);
                    full_output.push(Self::DELIMITER);
                    Self::write_cell(v, None, None, &mut full_output);
                    if iter.peek().is_some() {
                        full_output.push('\n');
                    }
                }

                if let Ok(decompressed_val) = Self::decompress(&full_output) {
                    if decompressed_val != parsed {
                        return Err("Obje kayıpsızlık doğrulaması başarısız.");
                    }
                } else {
                    return Err("Obje decompress hatası.");
                }

                Ok(full_output)
            }

            _ => Ok(raw_json.to_string()),
        }
    }

    pub fn decompress(tlm_str: &str) -> Result<Value, &'static str> {
        let mut lines = tlm_str.lines();
        let tag_line = lines.next().ok_or("Eksik format etiketi")?;

        if !tag_line.starts_with("@T") {
            return Err("Geçersiz @T formatı");
        }

        // Sabit kolonları çözümle
        let mut constant_columns: HashMap<String, Value> = HashMap::new();
        if let Some(open_idx) = tag_line.find('(') {
            if tag_line.ends_with(')') {
                let const_str = &tag_line[open_idx + 1..tag_line.len() - 1];
                for pair in const_str.split(';') {
                    if let Some((k, v)) = pair.split_once('=') {
                        let parsed_v = Self::decode_cell(v, None, None);
                        constant_columns.insert(k.to_string(), parsed_v);
                    }
                }
            }
        }

        let header_line = match lines.next() {
            Some(line) => line,
            None => {
                if !constant_columns.is_empty() {
                    return Ok(Value::Array(vec![Value::Object(
                        constant_columns.into_iter().collect(),
                    )]));
                }
                return Err("Eksik başlık satırı");
            }
        };

        let header_parts: Vec<&str> = header_line.split(Self::DELIMITER).collect();

        if header_parts.len() == 2 && header_parts[0] == "k" && header_parts[1] == "v" {
            let mut root_map = Map::new();
            for line in lines {
                if let Some((k, v)) = line.split_once(Self::DELIMITER) {
                    let parsed_val = Self::decode_cell(v, None, None);
                    root_map.insert(k.to_string(), parsed_val);
                }
            }
            return Ok(Value::Object(root_map));
        }

        let mut headers: Vec<String> = Vec::with_capacity(header_parts.len());
        let mut col_dictionaries: Vec<Option<HashMap<String, String>>> =
            Vec::with_capacity(header_parts.len());
        let mut col_prefixes: Vec<Option<String>> = Vec::with_capacity(header_parts.len());

        for hp in header_parts {
            if let Some(open_idx) = hp.find('(') {
                if hp.ends_with(')') {
                    let h_name = &hp[..open_idx];
                    let dict_str = &hp[open_idx + 1..hp.len() - 1];
                    let mut dict_map = HashMap::new();
                    for pair in dict_str.split(';') {
                        if let Some((k, v)) = pair.split_once('=') {
                            dict_map.insert(k.to_string(), v.to_string());
                        }
                    }
                    headers.push(h_name.to_string());
                    col_dictionaries.push(Some(dict_map));
                    col_prefixes.push(None);
                    continue;
                }
            } else if let Some(open_idx) = hp.find('[') {
                if hp.ends_with(']') {
                    let h_name = &hp[..open_idx];
                    let prefix = &hp[open_idx + 1..hp.len() - 1];
                    headers.push(h_name.to_string());
                    col_dictionaries.push(None);
                    col_prefixes.push(Some(prefix.to_string()));
                    continue;
                }
            }
            headers.push(hp.to_string());
            col_dictionaries.push(None);
            col_prefixes.push(None);
        }

        let mut items = Vec::new();
        let mut prev_decoded_row: Vec<Option<Value>> = vec![None; headers.len()];

        for line in lines {
            let parts: Vec<&str> = line.split(Self::DELIMITER).collect();
            let mut obj_map = Map::with_capacity(headers.len() + constant_columns.len());

            // Sabit kolonları ekle
            for (ck, cv) in &constant_columns {
                obj_map.insert(ck.clone(), cv.clone());
            }

            for (col_idx, header) in headers.iter().enumerate() {
                if let Some(&cell) = parts.get(col_idx) {
                    if cell == "^" {
                        if let Some(Some(val)) = prev_decoded_row.get(col_idx) {
                            obj_map.insert(header.clone(), val.clone());
                        }
                    } else if !cell.is_empty() {
                        let parsed_val = Self::decode_cell(
                            cell,
                            col_dictionaries.get(col_idx).and_then(|o| o.as_ref()),
                            col_prefixes.get(col_idx).and_then(|o| o.as_deref()),
                        );
                        prev_decoded_row[col_idx] = Some(parsed_val.clone());
                        obj_map.insert(header.clone(), parsed_val);
                    } else {
                        prev_decoded_row[col_idx] = None;
                    }
                }
            }
            items.push(Value::Object(obj_map));
        }

        Ok(Value::Array(items))
    }

    #[inline(always)]
    fn detect_common_prefix(strs: &[&str]) -> Option<String> {
        if strs.len() < 2 {
            return None;
        }
        let first = strs[0];
        let mut prefix_len = 0;

        for (idx, ch) in first.chars().enumerate() {
            if strs.iter().all(|s| s.chars().nth(idx) == Some(ch)) {
                prefix_len += ch.len_utf8();
            } else {
                break;
            }
        }

        if prefix_len >= 2 {
            Some(first[..prefix_len].to_string())
        } else {
            None
        }
    }

    #[inline(always)]
    fn write_row(
        obj: &Map<String, Value>,
        headers: &[String],
        col_dicts: &[Option<Vec<String>>],
        col_prefixes: &[Option<String>],
        enable_ditto: bool,
        prev_row: &mut [String],
        buf: &mut String,
    ) {
        for (i, h) in headers.iter().enumerate() {
            if i > 0 {
                buf.push(Self::DELIMITER);
            }
            if let Some(val) = obj.get(h) {
                let mut current_cell = String::new();
                Self::write_cell(
                    val,
                    col_dicts[i].as_deref(),
                    col_prefixes[i].as_deref(),
                    &mut current_cell,
                );

                if enable_ditto
                    && !prev_row[i].is_empty()
                    && prev_row[i] == current_cell
                    && current_cell.len() > 1
                {
                    buf.push('^');
                } else {
                    buf.push_str(&current_cell);
                    prev_row[i] = current_cell;
                }
            } else {
                prev_row[i].clear();
            }
        }
    }

    #[inline(always)]
    fn write_cell(val: &Value, dict: Option<&[String]>, prefix: Option<&str>, buf: &mut String) {
        match val {
            Value::Null => buf.push('~'),
            Value::Bool(true) => buf.push_str("true"),
            Value::Bool(false) => buf.push_str("false"),
            Value::Number(n) => {
                use std::fmt::Write;
                let _ = write!(buf, "{}", n);
            }
            Value::String(s) => {
                if let Some(d) = dict {
                    if let Some(pos) = d.iter().position(|item| item == s) {
                        use std::fmt::Write;
                        let _ = write!(buf, "{}", pos);
                        return;
                    }
                }

                let actual_str = if let Some(pfx) = prefix {
                    s.strip_prefix(pfx).unwrap_or(s)
                } else {
                    s.as_str()
                };

                if actual_str.is_empty() {
                    buf.push_str("\"\"");
                } else if actual_str == "^"
                    || actual_str == "~"
                    || actual_str == "true"
                    || actual_str == "false"
                    || actual_str.parse::<f64>().is_ok()
                    || actual_str.starts_with('"')
                    || actual_str.contains('\t')
                    || actual_str.contains('\n')
                    || actual_str.contains('\r')
                {
                    buf.push('"');
                    Self::escape_str(actual_str, buf);
                    buf.push('"');
                } else {
                    buf.push_str(actual_str);
                }
            }
            Value::Array(_) | Value::Object(_) => {
                buf.push_str("\\j");
                let serialized = serde_json::to_string(val).unwrap_or_default();
                for c in serialized.chars() {
                    if c == '\t' {
                        buf.push_str("\\t");
                    } else {
                        buf.push(c);
                    }
                }
            }
        }
    }

    #[inline(always)]
    fn escape_str(s: &str, buf: &mut String) {
        for c in s.chars() {
            match c {
                '\\' => buf.push_str("\\\\"),
                '"' => buf.push_str("\\\""),
                '\t' => buf.push_str("\\t"),
                '\n' => buf.push_str("\\n"),
                '\r' => buf.push_str("\\r"),
                other => buf.push(other),
            }
        }
    }

    #[inline(always)]
    fn decode_cell(
        cell: &str,
        dict: Option<&HashMap<String, String>>,
        prefix: Option<&str>,
    ) -> Value {
        if cell == "~" {
            return Value::Null;
        }
        if cell == "true" {
            return Value::Bool(true);
        }
        if cell == "false" {
            return Value::Bool(false);
        }
        if cell == "\"\"" {
            // Boş string: yazarken prefix çıkarılıp "" bırakılıyordu.
            let res = prefix.unwrap_or("").to_string();
            return Value::String(res);
        }

        if let Some(d) = dict {
            if let Some(mapped_val) = d.get(cell) {
                return Value::String(mapped_val.clone());
            }
        }

        let is_quoted = cell.starts_with('"') && cell.ends_with('"') && cell.len() >= 2;
        let base_str = if is_quoted {
            let inner = &cell[1..cell.len() - 1];
            let mut unescaped = String::with_capacity(inner.len());
            let mut chars = inner.chars().peekable();

            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('t') => unescaped.push('\t'),
                        Some('n') => unescaped.push('\n'),
                        Some('r') => unescaped.push('\r'),
                        Some('"') => unescaped.push('"'),
                        Some('\\') => unescaped.push('\\'),
                        Some(other) => {
                            unescaped.push('\\');
                            unescaped.push(other);
                        }
                        None => unescaped.push('\\'),
                    }
                } else {
                    unescaped.push(c);
                }
            }
            unescaped
        } else {
            cell.to_string()
        };

        let is_nested_json = !is_quoted && cell.starts_with("\\j");
        let is_number_like = !is_quoted
            && (cell.parse::<i64>().is_ok()
                || cell.parse::<u64>().is_ok()
                || cell.parse::<f64>().is_ok());

        // Prefix yalnızca düz string hücrelere uygulanır; sayı/`\j`/null/bool
        // yazarken asla prefikse tabi değildir (karışık tipli kolonlar).
        if let Some(pfx) = prefix {
            if !is_number_like && !is_nested_json {
                return Value::String(format!("{}{}", pfx, base_str));
            }
        }

        if is_nested_json {
            let restored = cell.strip_prefix("\\j").unwrap_or("").replace("\\t", "\t");
            if let Ok(val) = serde_json::from_str::<Value>(&restored) {
                return val;
            }
        }

        if !is_quoted {
            if let Ok(num) = cell.parse::<i64>() {
                return Value::Number(num.into());
            }
            if let Ok(num) = cell.parse::<u64>() {
                return Value::Number(num.into());
            }
            if let Ok(num) = cell.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(num) {
                    return Value::Number(n);
                }
            }
        }

        Value::String(base_str)
    }
}

// Kod şema çıkarıcı — katmanlı ifşanın 1. katmanı.
//
// Kod bloğunun yalnızca tanım imzalarını (def/class/async def) ve satır
// aralıklarını çıkarır. LLM şemadan yapıyı görür; gövde gerekiyorsa
// `get_code_body` aracıyla ister (backend/ai.rs döngüsü). Orijinal kod asla
// kaybolmaz — editörde/localde durur, "görev için kayıpsız" sözleşme.
//
// İlk sürüm: Python (girinti tabanlı). Tree-sitter ile dil genelleştirme planlı.

#[derive(Debug, Clone)]
pub struct SchemaEntry {
    pub signature: String,
    pub start: usize, // 1 tabanlı satır
    pub end: usize,   // 1 tabanlı, dahil
    pub body_tokens: usize,
    /// Bu tanımın gövdesinde çağrılan/referans edilen DİĞER tanımlar —
    /// LLM'in "görmediği" bağımlılıkları görmesini sağlar.
    pub calls: Vec<String>,
    /// Kısa gövdeler şemaya tam olarak gömülür (kör nokta engelleme).
    pub inlined_body: Option<String>,
    pub children: Vec<SchemaEntry>,
}

#[derive(Debug, Clone)]
pub struct CodeSchema {
    pub language: &'static str,
    pub total_lines: usize,
    pub entries: Vec<SchemaEntry>,
}

pub fn extract_schema(code: &str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let total_lines = lines.len();

    // (girinti, imza, başlangıç satırı)
    let mut defs: Vec<(usize, String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("def ") || t.starts_with("async def ") || t.starts_with("class ") {
            defs.push((line.len() - t.len(), t.trim_end().to_string(), i + 1));
        }
    }
    if defs.is_empty() {
        return None;
    }

    // Her tanımın bitişi: aynı/girintisi küçük bir sonraki tanımın satırı - 1.
    let mut spans: Vec<(usize, String, usize, usize)> = Vec::new();
    for (idx, (indent, sig, start)) in defs.iter().enumerate() {
        let end = defs[idx + 1..]
            .iter()
            .find(|(ind, _, _)| ind <= indent)
            .map(|(_, _, s)| s - 1)
            .unwrap_or(total_lines);
        spans.push((*indent, sig.clone(), *start, end));
    }

    // Tanım adları + çağrı analizi: her gövdede DİĞER tanımların adı geçiyor mu?
    let def_name = |sig: &str| -> String {
        let t = sig
            .trim_start_matches("async ")
            .trim_start_matches("def ")
            .trim_start_matches("class ");
        t.split('(').next().unwrap_or(t).trim().to_string()
    };
    let names: std::collections::HashSet<String> =
        spans.iter().map(|(_, sig, _, _)| def_name(sig)).collect();

    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let calls_of = |body: &str, own: &str| -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        let chars: Vec<char> = body.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
                let start = i;
                while i < chars.len() && is_word(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if names.contains(&word) && word != own && !found.contains(&word) {
                    found.push(word);
                }
            } else {
                i += 1;
            }
        }
        found
    };

    // Yuvalama: girinti yığınına göre ağaç kur + gövde analizi.
    const SMALL_BODY_CHARS: usize = 240; // ~60 token — kısa gövdeler şemaya gömülür
    let mut roots: Vec<SchemaEntry> = Vec::new();
    let mut stack: Vec<(usize, SchemaEntry)> = Vec::new();
    for (indent, sig, start, end) in spans {
        let own = def_name(&sig);
        let body_text: String = lines[start..end].join("\n");
        let inlined = if body_text.chars().count() <= SMALL_BODY_CHARS {
            Some(body_text.clone())
        } else {
            None
        };
        let entry = SchemaEntry {
            signature: sig.clone(),
            start,
            end,
            body_tokens: body_text.len() / 4, // yaklaşık token
            calls: calls_of(&body_text, &own),
            inlined_body: inlined,
            children: Vec::new(),
        };
        while let Some((top_indent, _)) = stack.last() {
            if *top_indent < indent {
                break;
            }
            let (_, popped) = stack.pop().unwrap();
            if let Some(parent) = stack.last_mut() {
                parent.1.children.push(popped);
            } else {
                roots.push(popped);
            }
        }
        stack.push((indent, entry));
    }
    while let Some((_, popped)) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.1.children.push(popped);
        } else {
            roots.push(popped);
        }
    }

    Some(CodeSchema {
        language: "python",
        total_lines,
        entries: roots,
    })
}

/// LLM'e gönderilen kompakt şema metni.
pub fn render_schema(schema: &CodeSchema) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "@C {} ({} satır) — gövde için get_code_body(\"ad\") çağır; şüphedeysen çağır (fetch ucuzdur)\n",
        schema.language, schema.total_lines
    ));
    fn write_entries(out: &mut String, entries: &[SchemaEntry], depth: usize) {
        for e in entries {
            out.push_str(&format!(
                "{}{}  #L{}-L{} (~{} tok)",
                "  ".repeat(depth),
                e.signature,
                e.start,
                e.end,
                e.body_tokens
            ));
            if !e.calls.is_empty() {
                out.push_str(&format!(" → çağırır: {}", e.calls.join(", ")));
            }
            out.push('\n');
            if let Some(body) = &e.inlined_body {
                for line in body.lines() {
                    out.push_str(&format!("{}  {}\n", "  ".repeat(depth), line));
                }
            }
            write_entries(out, &e.children, depth + 1);
        }
    }
    write_entries(&mut out, &schema.entries, 0);
    out.truncate(out.trim_end().len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::code_shrink::count;
    use crate::engine::code_shrink::SAMPLE;

    #[test]
    fn schema_extracts_all_definitions() {
        let schema = extract_schema(SAMPLE).unwrap();
        // 1 sınıf + 4 metot (SAMPLE'da 4 def: __init__, load_configuration,
        // dispatch_request, dispatch_request_again)
        let count = schema.entries.iter().map(|e| 1 + e.children.len()).sum::<usize>();
        assert!(count >= 5, "tüm tanımlar çıkarılmalı, çıkan: {}", count);
    }

    #[test]
    fn schema_scales_with_signatures_not_bodies() {
        // Gerçek kazanım ölçeği: gövdeler büyüdükçe şemanın payı düşer.
        let b = tiktoken_rs::cl100k_base().unwrap();
        for rep in [1usize, 5, 10] {
            let big = SAMPLE.repeat(rep);
            let full = count(&b, &big);
            let schema = extract_schema(&big).unwrap();
            let schema_tok = count(&b, &render_schema(&schema));
            println!(
                "kod ~{:>5} token → şema {:>4} token (şema payı %{:.1}) → 1 gövde istenirse kalan tasarruf ≈ %{:.0}",
                full,
                schema_tok,
                100.0 * schema_tok as f64 / full as f64,
                100.0 * (1.0 - (schema_tok as f64 + 55.0) / full as f64)
            );
        }
    }

    #[test]
    fn calls_edges_are_visible_and_small_bodies_inlined() {
        let code = r#"def validate_token(token):
    return token.startswith("tok_")

def dispatch_request(handler):
    token = handler.token
    if not validate_token(token):
        raise PermissionError("bad")
    return handler.run()
"#;
        let schema = extract_schema(code).unwrap();
        let rendered = render_schema(&schema);
        assert!(
            rendered.contains("çağırır: validate_token"),
            "çağrı bağı görünmeli:\n{}",
            rendered
        );
        assert!(
            rendered.contains("return token.startswith"),
            "küçük gövde şemaya gömülmeli:\n{}",
            rendered
        );
    }

    #[test]
    fn schema_is_small_and_lossless_for_task() {
        let b = tiktoken_rs::cl100k_base().unwrap();
        let schema = extract_schema(SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        let full = count(&b, SAMPLE);
        let schema_tok = count(&b, &rendered);
        println!("tam kod : {} token", full);
        println!("şema    : {} token (%{:.0}) → tasarruf %{:.0}",
            schema_tok,
            100.0 * schema_tok as f64 / full as f64,
            100.0 * (1.0 - schema_tok as f64 / full as f64));
        println!("--- şema ---\n{}", rendered);
        assert!(schema_tok < full);
    }
}

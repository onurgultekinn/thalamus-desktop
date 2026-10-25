// Kod şema çıkarıcı — katmanlı ifşanın 1. katmanı.
//
// Kod bloğunun yalnızca tanım imzalarını ve satır aralıklarını çıkarır.
// LLM şemadan yapıyı görür; gövde gerekiyorsa `get_code_body` aracıyla ister
// (backend/ai.rs döngüsü). Orijinal kod asla kaybolmaz — editörde/localde
// durur, "gövde yerine şema" sözleşmesi.
//
// Python: girinti tabanlı. JS/TS/TSX ve Rust: küme parantezi derinliği
// tabanlı (dize/yorum içindeki parantezler kabaca tolere edilir; şema bir
// ipucu katmanıdır, birebir ayrıştırıcı değildir).

#[derive(Debug, Clone)]
pub struct SchemaEntry {
    /// Tanımın kısa adı (repo map skorlaması ve get_code_body eşlemesi için).
    pub name: String,
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

/// Ham tanım: (seviye, ad, imza, başlangıç, bitiş). Seviye Python'da girinti,
/// süslü dillerde tanımın açılış parantezindeki ÜST derinliktir.
type RawDef = (usize, String, String, usize, usize);

/// Dosya adına göre dil seçer ve uygun çıkarıcıyı çağırır.
/// Desteklenmeyen uzantılarda None → çağıran tam gövdeye döner.
pub fn extract_schema_for(file: &str, code: &str) -> Option<CodeSchema> {
    let f = file.replace('\\', "/");
    let base = f.rsplit('/').next().unwrap_or("").to_lowercase();
    let ext = base.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "py" | "pyi" => extract_schema(code),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
            extract_brace_schema(code, "typescript")
        }
        "rs" => extract_brace_schema(code, "rust"),
        // C-tarzı aile: aynı brace motoru, C-tarzı tanım kalıpları.
        "java" => extract_brace_schema(code, "java"),
        "cs" => extract_brace_schema(code, "csharp"),
        "c" | "h" => extract_brace_schema(code, "c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => extract_brace_schema(code, "cpp"),
        "go" => extract_brace_schema(code, "go"),
        "swift" => extract_brace_schema(code, "swift"),
        "kt" | "kts" => extract_brace_schema(code, "kotlin"),
        "dart" => extract_brace_schema(code, "dart"),
        "php" => extract_brace_schema(code, "php"),
        // Betik: satır tabanlı fonksiyon iskeleti.
        "sh" | "bash" | "zsh" => extract_shell_schema(code),
        // Belgeler: başlık/bölüm iskeleti — tüm gövde yerine dış hat.
        "md" | "markdown" => extract_markdown_schema(code),
        "json" | "jsonc" => extract_json_schema(code),
        "yaml" | "yml" => extract_kv_schema(code, "yaml"),
        "toml" | "ini" | "cfg" | "conf" => extract_kv_schema(code, ext),
        _ => None,
    }
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
    let def_name = |sig: &str| -> String {
        let t = sig
            .trim_start_matches("async ")
            .trim_start_matches("def ")
            .trim_start_matches("class ");
        t.split('(').next().unwrap_or(t).trim().to_string()
    };
    let mut spans: Vec<RawDef> = Vec::new();
    for (idx, (indent, sig, start)) in defs.iter().enumerate() {
        let end = defs[idx + 1..]
            .iter()
            .find(|(ind, _, _)| ind <= indent)
            .map(|(_, _, s)| s - 1)
            .unwrap_or(total_lines);
        spans.push((*indent, def_name(sig), sig.clone(), *start, end));
    }

    Some(build_schema("python", total_lines, &lines, spans))
}

/// Süslü-parantez dilleri (TS/JS/TSX, Rust). Derinlik satır satır izlenir;
/// tanım satırı = açılış parantezinden önce imza kalıbına uyan satır.
pub fn extract_brace_schema(code: &str, language: &'static str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let total_lines = lines.len();
    // Satır başı/başı derinlikleri (naif { } sayımı).
    let mut depth = 0i64;
    let mut start_depth: Vec<i64> = Vec::with_capacity(lines.len());
    let mut end_depth: Vec<i64> = Vec::with_capacity(lines.len());
    for line in &lines {
        start_depth.push(depth);
        for c in line.chars() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
        }
        end_depth.push(depth);
    }
    if start_depth.is_empty() {
        return None;
    }

    let mut spans: Vec<RawDef> = Vec::new();
    let mut pending: Vec<(i64, String, String, usize)> = Vec::new(); // kapanmamış tanımlar
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        // Tanım kalıbı: yalnız satır BİR tanım başlatıyorsa (çok satırlı imza
        // kaçabilir — kabul edilebilir; şema ipucudur).
        let parent = start_depth[i];
        if let Some((name, sig)) = brace_def_name(t, language, parent > 0) {
            pending.push((parent, name, sig, i + 1));
        }
        // Bu satırda kapanan tanımları bitir.
        while let Some((p, _, _, _)) = pending.last() {
            if end_depth[i] <= *p {
                let (p, name, sig, start) = pending.pop().unwrap();
                spans.push((p.max(0) as usize, name, sig, start, i + 1));
            } else {
                break;
            }
        }
    }
    // Dosya sonunda hâlâ açık kalanlar.
    for (p, name, sig, start) in pending {
        spans.push((p.max(0) as usize, name, sig, start, total_lines));
    }
    if spans.is_empty() {
        return None;
    }
    // Ağaç kurulumu BAŞLANGIÇ sırası ister; pop'lar kapanış sırası üretir.
    spans.sort_by_key(|(_, _, _, start, _)| *start);
    Some(build_schema(language, total_lines, &lines, spans))
}

/// Süslü dil tanım satırı kalıpları. `nested=true` → sınıf içi metot da kabul.
/// Dönen: (ad, imza). Kontrol akışı anahtar kelimeleri hariçtir.
fn brace_def_name(t: &str, language: &'static str, nested: bool) -> Option<(String, String)> {
    if t.is_empty() || t.starts_with("//") || t.starts_with("*") || t.starts_with("/*") {
        return None;
    }
    // imza = `{` ve sonrası atılmış hali.
    let head = t.split('{').next().unwrap_or(t).trim();
    if head.is_empty() {
        return None;
    }
    let ts = language == "typescript";

    // Görünürlük/niteleyici öneklerini soy; sıra bağımsız tekrarlı.
    // TS'te const/let/var TANIM başlığıdır (soyulmaz); C-tarzı niteleyiciler
    // yalnız o ailede soyulur.
    let mut core = head.trim();
    let mut pres: Vec<&str> = vec![
        "export ", "default ", "declare ", "abstract ", "pub ", "pub(crate) ",
        "crate ", "async ", "unsafe ", "extern ",
    ];
    if !ts {
        pres.extend([
            "static ", "final ", "override ", "virtual ", "public ", "private ",
            "protected ", "internal ", "sealed ", "inline ", "constexpr ",
            "synchronized ", "transient ", "volatile ", "partial ", "open ",
            "suspend ", "reified ", "required ", "init ", "nonisolated ",
        ]);
    }
    if language == "rust" {
        pres.push("const ");
    }
    loop {
        let mut changed = false;
        for pre in &pres {
            if let Some(r) = core.strip_prefix(pre) {
                core = r.trim_start();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let sig = t.to_string();
    let is_kw = |w: &str| {
        matches!(
            w,
            "if" | "for" | "while" | "switch" | "catch" | "do" | "else" | "try"
                | "return" | "match" | "loop" | "unsafe" | "await" | "yield" | "new"
                | "delete" | "throw" | "typeof" | "case" | "use" | "using" | "lock"
                | "with" | "foreach" | "elseif" | "guard" | "defer" | "go" | "select"
                | "chan" | "map" | "func" | "package" | "import" | "val" | "var"
                | "let" | "echo" | "print" | "if let" | "while let"
        ) || w == "default"
    };
    let first_ident = |s: &str| -> Option<String> {
        let mut out = String::new();
        for c in s.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' {
                out.push(c);
            } else if out.is_empty() && c.is_ascii_whitespace() {
                continue;
            } else {
                break;
            }
        }
        if out.is_empty() { None } else { Some(out) }
    };

    // function/fn/fun/func NAME( — dile göre anahtar kelime.
    let fn_kw = match language {
        "typescript" | "php" => "function",
        "rust" => "fn",
        "go" => "func",
        "kotlin" => "fun",
        _ => "fn",
    };
    if let Some(r) = core.strip_prefix(fn_kw) {
        let mut r = r.trim_start().to_string();
        // Go metot alıcısı: func (s *Server) Start( → alıcıyı atla.
        if r.starts_with('(') {
            let mut depth = 0i32;
            for (i, c) in r.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            r = r[i + 1..].trim_start().to_string();
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(name) = first_ident(&r) {
            if !is_kw(&name) {
                return Some((name, sig));
            }
        }
    }
    // Tip/tanımlayıcı blokları: dile göre anahtar kelime seti.
    if ts {
        for kw in ["class", "interface", "enum"] {
            if let Some(r) = core.strip_prefix(kw) {
                if let Some(name) = first_ident(r) {
                    if !is_kw(&name) && name != "extends" {
                        return Some((name, sig));
                    }
                }
            }
        }
        if let Some(r) = core.strip_prefix("type ") {
            if let Some(name) = first_ident(r) {
                if !is_kw(&name) {
                    return Some((name, sig));
                }
            }
        }
        // const/let/var fonksiyon-değerli tanımlar.
        for kw in ["const ", "let ", "var "] {
            if let Some(r) = core.strip_prefix(kw) {
                if let Some(name) = first_ident(r) {
                    if is_kw(&name) {
                        return None;
                    }
                    let rest = r.trim_start_matches(|c: char| c.is_ascii_whitespace());
                    let rest = &rest[name.len()..];
                    if rest.contains("=>") || rest.contains("= function") || rest.contains("=(")
                        || rest.contains("= (") || rest.contains("=async")
                    {
                        return Some((name, sig));
                    }
                }
            }
        }
        // Sınıf içi metot: [async|get|set] NAME( — yalnız nested.
        if nested {
            let mut probe = core;
            for pre in ["async ", "get ", "set ", "static ", "public ", "private ", "protected ", "readonly "] {
                if let Some(r) = probe.strip_prefix(pre) {
                    probe = r.trim_start();
                }
            }
            // Metot açılışı aynı satırda '{' ile biter; 'foo(x);' gibi
            // ifade satırları bu şartla elenir.
            if t.trim_end().ends_with('{') {
                if let Some(name) = first_ident(probe) {
                    let after = probe[probe.find(&name).map(|i| i + name.len()).unwrap_or(0)..]
                        .trim_start();
                    if !is_kw(&name) && after.starts_with('(') {
                        return Some((name, sig));
                    }
                }
            }
        }
    } else if language == "rust" {
        for kw in ["struct", "enum", "trait", "mod", "union"] {
            if let Some(r) = core.strip_prefix(kw) {
                if let Some(name) = first_ident(r) {
                    if !is_kw(&name) {
                        return Some((name, sig));
                    }
                }
            }
        }
        if core.starts_with("impl") {
            let name: String = core.chars().take(60).collect();
            return Some((name, sig));
        }
        if let Some(r) = core.strip_prefix("macro_rules!") {
            if let Some(name) = first_ident(r.trim_start()) {
                return Some((name, sig));
            }
        }
        // impl/fn içindeki `fn` zaten yukarıda; metot da fn ile eşleşir.
    } else {
        // C-tarzı aile (Java, C#, C/C++, Go, Swift, Kotlin, Dart, PHP):
        // tip blokları + "dönüş_tipi ad(" desenli fonksiyonlar.
        for kw in [
            "class", "struct", "interface", "enum", "trait", "record", "namespace",
            "object", "mixin", "extension", "protocol", "union", "typealias",
        ] {
            if let Some(r) = core.strip_prefix(kw) {
                if r.starts_with(' ') {
                    if let Some(name) = first_ident(r) {
                        if !is_kw(&name) {
                            return Some((name, sig));
                        }
                    }
                }
            }
        }
        // Go/Swift tip bildirimi: type Server struct {
        if let Some(r) = core.strip_prefix("type ") {
            if let Some(name) = first_ident(r) {
                if !is_kw(&name) {
                    return Some((name, sig));
                }
            }
        }
        // C-tarzı fonksiyon/metot: '(' öncesi SON tanımlayıcı = ad.
        // Satır bir blok AÇMALI ('{' içermeli) ve '{' ya da '}' ile bitmeli
        // (tek satır `void f() {}` dahil; `foo(x);` ifadeleri elenir).
        let opened = head != t;
        let ends_ok = {
            let te = t.trim_end();
            te.ends_with('{') || te.ends_with('}')
        };
        if opened && ends_ok {
            if let Some(p) = core.find('(') {
                let before = &core[..p];
                if let Some(name) = before
                    .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                    .find(|s| !s.is_empty())
                {
                    let name = name.to_string();
                    let first = name.chars().next().unwrap_or('0');
                    if !name.is_empty() && !first.is_ascii_digit() && !is_kw(&name) {
                        return Some((name, sig));
                    }
                }
            }
        }
    }
    None
}

// ── Belge/veri biçimleri: dış hat (outline) çıkarıcıları ────────────────────
//
// Kod dillerinden farklı olarak burada "tanım" yoktur; başlık/bölüm/anahtar
// satırları iskelet taşısıdır. Çağrı kenarı analizi anlamsız olduğundan
// `calls` boş kalır; kısa bölümler yine gömülür (kör nokta engelleme).

/// Ortak iskelet kurucu: (seviye, imza, başlangıç) işaretçilerinden ağaç.
fn build_outline(
    language: &'static str,
    total_lines: usize,
    lines: &[&str],
    markers: Vec<(usize, String, usize)>,
) -> Option<CodeSchema> {
    if markers.is_empty() {
        return None;
    }
    const SMALL_BODY_CHARS: usize = 240;
    // Sonraki işaretçinin başlangıcı döngü ÖNCESİ toplanır (move çakışması).
    let next_starts: Vec<usize> = markers
        .iter()
        .skip(1)
        .map(|(_, _, s)| *s)
        .chain(std::iter::once(total_lines + 1))
        .collect();
    let mut roots: Vec<SchemaEntry> = Vec::new();
    let mut stack: Vec<(usize, SchemaEntry)> = Vec::new();
    for (idx, (level, sig, start)) in markers.into_iter().enumerate() {
        let end = next_starts[idx].saturating_sub(1);
        let body_text: String = lines[(start - 1)..end.min(lines.len())].join("\n");
        let inlined = if body_text.chars().count() <= SMALL_BODY_CHARS {
            Some(body_text.clone())
        } else {
            None
        };
        let short_name: String = sig
            .trim_start_matches(|c: char| c == '#' || c == '[')
            .trim()
            .chars()
            .take(60)
            .collect();
        let entry = SchemaEntry {
            name: short_name,
            signature: sig,
            start,
            end,
            body_tokens: body_text.len() / 4,
            calls: Vec::new(),
            inlined_body: inlined,
            children: Vec::new(),
        };
        while let Some((top_level, _)) = stack.last() {
            if *top_level < level {
                break;
            }
            let (_, popped) = stack.pop().unwrap();
            if let Some(parent) = stack.last_mut() {
                parent.1.children.push(popped);
            } else {
                roots.push(popped);
            }
        }
        stack.push((level, entry));
    }
    while let Some((_, popped)) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.1.children.push(popped);
        } else {
            roots.push(popped);
        }
    }
    Some(CodeSchema {
        language,
        total_lines,
        entries: roots,
    })
}

/// Markdown: başlık iskeleti. Kod çitleri (```) içindeki '#' başlık SAYILMAZ.
pub fn extract_markdown_schema(code: &str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let mut markers: Vec<(usize, String, usize)> = Vec::new();
    let mut in_fence = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if t.starts_with('#') {
            let level = t.chars().take_while(|&c| c == '#').count().min(6);
            if t.chars().nth(level) == Some(' ') {
                markers.push((level, t.trim_end().to_string(), i + 1));
            }
        }
    }
    build_outline("markdown", lines.len(), &lines, markers)
}

/// YAML/TOML/INI: bölüm iskeleti. YAML = üst düzey `anahtar:` satırları
/// (girinti ≤ 2), TOML/INI = `[bölüm]` başlıkları.
pub fn extract_kv_schema(code: &str, ext: &str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let mut markers: Vec<(usize, String, usize)> = Vec::new();
    let toml_like = matches!(ext, "toml" | "ini" | "cfg" | "conf");
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with(';') {
            continue;
        }
        if toml_like {
            if t.starts_with('[') && t.ends_with(']') {
                markers.push((1, t.to_string(), i + 1));
            }
        } else if !line.starts_with(' ') && !line.starts_with('\t') {
            // Üst düzey anahtar: `ad:` — iki noktadan sonra değer/blok/boşluk.
            // Girintili alt anahtarlar iskelete girmez (patlamasın).
            if let Some(colon) = t.find(':') {
                let key = &t[..colon];
                let after = &t[colon + 1..];
                if !key.is_empty()
                    && key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
                    && (after.is_empty() || after.starts_with(' '))
                {
                    markers.push((1, t.trim_end().to_string(), i + 1));
                }
            }
        }
    }
    let lang: &'static str = if toml_like { "toml" } else { "yaml" };
    build_outline(lang, lines.len(), &lines, markers)
}

/// JSON: süslü derinliği 1 ve 2'deki anahtarlar. Değerler yerine anahtar
/// iskeleti + satır aralığı; dizi uzunlukları imzada not edilir.
pub fn extract_json_schema(code: &str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let mut markers: Vec<(usize, String, usize)> = Vec::new();
    let mut depth = 0i64;
    let mut in_str = false;
    let mut esc = false;
    for (i, line) in lines.iter().enumerate() {
        let start_depth = depth;
        for c in line.chars() {
            if esc {
                esc = false;
                continue;
            }
            match c {
                '\\' if in_str => esc = true,
                '"' => in_str = !in_str,
                '{' | '[' if !in_str => depth += 1,
                '}' | ']' if !in_str => depth -= 1,
                _ => {}
            }
        }
        // Bu satırda açılan ve anahtar içeren derinlik: start_depth+1.
        let key_depth = if start_depth < depth { start_depth + 1 } else { start_depth };
        if (1..=2).contains(&key_depth) {
            let t = line.trim();
            // Anahtar satırı '"' ile BAŞLAR; dizi elemanları '{' ile — onlar
            // iskelete girmez (anonimdir).
            if t.starts_with('"') {
            if let Some(colon) = t.find("\":") {
                let key_start = t.find('"').unwrap_or(0);
                let key = &t[key_start + 1..colon];
                if !key.is_empty() && !key.contains('"') {
                    let note = if t[colon..].trim_start_matches(|c: char| c != '[').starts_with("[")
                        && t.trim_end().ends_with('[')
                    {
                        " [array]"
                    } else {
                        ""
                    };
                    markers.push((
                        key_depth.min(2) as usize,
                        format!("\"{}\":{}", key, note),
                        i + 1,
                    ));
                }
            }
            }
        }
    }
    build_outline("json", lines.len(), &lines, markers)
}

/// Kabuk betikleri: `function ad`, `ad() {`, `ad ()` satırları; blok =
/// sonraki fonksiyona (veya dosya sonuna) kadar. Girinti ayracı yoktur.
pub fn extract_shell_schema(code: &str) -> Option<CodeSchema> {
    let lines: Vec<&str> = code.split('\n').collect();
    let mut markers: Vec<(usize, String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if t == "}" || t.starts_with("};") {
            continue;
        }
        if let Some(r) = t.strip_prefix("function ") {
            let name: String = r
                .chars()
                .take_while(|c: &char| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !name.is_empty() {
                markers.push((1, t.trim_end().to_string(), i + 1));
            }
        } else {
            // ad() { veya ad () { — parantez öncesi tam tanımlayıcı ve
            // kapanıştan sonra '{' (veya satır sonu) gelmeli.
            if t.contains('(') && t.contains(')') {
                let before_paren = t.split('(').next().unwrap_or("").trim_end();
                let name: String = before_paren
                    .chars()
                    .take_while(|c: &char| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .collect();
                let after = t.split(')').nth(1).unwrap_or("").trim();
                if !name.is_empty()
                    && name == before_paren
                    && !name.chars().next().unwrap().is_ascii_digit()
                    && (after.starts_with('{') || after.is_empty())
                {
                    markers.push((1, t.trim_end().to_string(), i + 1));
                }
            }
        }
    }
    build_outline("shell", lines.len(), &lines, markers)
}
fn build_schema(
    language: &'static str,
    total_lines: usize,
    lines: &[&str],
    spans: Vec<RawDef>,
) -> CodeSchema {
    let names: std::collections::HashSet<String> =
        spans.iter().map(|(_, name, _, _, _)| name.clone()).collect();

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

    const SMALL_BODY_CHARS: usize = 240; // ~60 token — kısa gövdeler şemaya gömülür
    let mut roots: Vec<SchemaEntry> = Vec::new();
    let mut stack: Vec<(usize, SchemaEntry)> = Vec::new();
    for (level, own, sig, start, end) in spans {
        let body_text: String = lines[(start - 1)..end.min(lines.len())].join("\n");
        let inlined = if body_text.chars().count() <= SMALL_BODY_CHARS {
            Some(body_text.clone())
        } else {
            None
        };
        let entry = SchemaEntry {
            name: own.clone(),
            signature: sig.clone(),
            start,
            end,
            body_tokens: body_text.len() / 4, // yaklaşık token
            calls: calls_of(&body_text, &own),
            inlined_body: inlined,
            children: Vec::new(),
        };
        while let Some((top_level, _)) = stack.last() {
            if *top_level < level {
                break;
            }
            let (_, popped) = stack.pop().unwrap();
            if let Some(parent) = stack.last_mut() {
                parent.1.children.push(popped);
            } else {
                roots.push(popped);
            }
        }
        stack.push((level, entry));
    }
    while let Some((_, popped)) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.1.children.push(popped);
        } else {
            roots.push(popped);
        }
    }

    CodeSchema {
        language,
        total_lines,
        entries: roots,
    }
}

/// Şemadaki tüm tanım adlarını (yuvalanmış çocuklar dahil) toplar —
/// repo map önem skorlaması ve bütçe notları için.
pub fn schema_definition_names(schema: &CodeSchema) -> Vec<String> {
    fn walk(e: &SchemaEntry, out: &mut Vec<String>) {
        out.push(e.name.clone());
        for c in &e.children {
            walk(c, out);
        }
    }
    let mut out = Vec::new();
    for e in &schema.entries {
        walk(e, &mut out);
    }
    out
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
                out.push_str(&format!(" → calls: {}", e.calls.join(", ")));
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
        let count = schema
            .entries
            .iter()
            .map(|e| 1 + e.children.len())
            .sum::<usize>();
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
            rendered.contains("calls: validate_token"),
            "çağrı bağı görünmeli:\n{}",
            rendered
        );
        assert!(
            rendered.contains("return token.startswith"),
            "küçük gövde şemaya gömülmeli:\n{}",
            rendered
        );
    }

    const TSX_SAMPLE: &str = r#"import React from 'react';

interface Props {
  title: string;
  count: number;
}

export function formatTitle(t: string) {
  return t.trim();
}

export const clamp = (n: number, lo: number, hi: number) => {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
};

export default class Counter extends React.Component<Props> {
  state = { n: 0 };

  handleClick() {
    this.setState({ n: clamp(this.state.n + 1, 0, 10) });
    formatTitle(this.props.title);
  }

  render() {
    const label = formatTitle(this.props.title);
    return <button onClick={() => this.handleClick()}>{label} {this.state.n}</button>;
  }
}

export type Mode = 'a' | 'b';

export function BigPanel(props: Props) {
  const lines = [
    'BIG_BODY_MARKER_LINE_1', 'BIG_BODY_MARKER_LINE_2', 'BIG_BODY_MARKER_LINE_3',
    'BIG_BODY_MARKER_LINE_4', 'BIG_BODY_MARKER_LINE_5', 'BIG_BODY_MARKER_LINE_6',
    'BIG_BODY_MARKER_LINE_7', 'BIG_BODY_MARKER_LINE_8', 'BIG_BODY_MARKER_LINE_9',
  ];
  return (
    <div>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}
"#;

    const RUST_SAMPLE: &str = r#"use std::fmt;

pub fn pad(n: usize) -> String {
    let mut out = String::new();
    for _ in 0..n {
        out.push_str("X");
    }
    out
}

pub struct Engine {
    name: String,
}

impl Engine {
    pub fn new(name: String) -> Self {
        Engine { name }
    }

    pub async fn run(&self) -> usize {
        self.helper()
    }

    fn helper(&self) -> usize {
        42
    }
}

pub enum Kind {
    Fast,
    Slow,
}

pub fn make(kind: Kind) -> Engine {
    Engine::new("x".into())
}

pub fn long_report(e: &Engine) -> String {
    let mut out = String::new();
    out.push_str("BIG_RUST_MARKER_1");
    out.push_str("BIG_RUST_MARKER_2");
    out.push_str("BIG_RUST_MARKER_3");
    out.push_str("BIG_RUST_MARKER_4");
    out.push_str("BIG_RUST_MARKER_5");
    out.push_str("BIG_RUST_MARKER_6");
    out.push_str("BIG_RUST_MARKER_7");
    out.push_str("BIG_RUST_MARKER_8");
    out
}
"#;

    #[test]
    fn tsx_schema_extracts_definitions_not_bodies() {
        let schema = extract_schema_for("Counter.tsx", TSX_SAMPLE).unwrap();
        assert_eq!(schema.language, "typescript");
        let rendered = render_schema(&schema);
        for want in ["Props", "formatTitle", "clamp", "Counter", "Mode", "handleClick", "render"] {
            assert!(rendered.contains(want), "şemada {} olmalı:
{}", want, rendered);
        }
        // BÜYÜK gövdeler şemaya girmemeli; küçükler bilinçli olarak gömülür.
        assert!(!rendered.contains("BIG_BODY_MARKER"), "büyük gövde sızdı");
        assert!(rendered.contains("clamp"), "küçük gövde gömülmeli");
        // Çağrı kenarı: handleClick → clamp.
        let counter = schema.entries.iter().find(|e| e.signature.contains("class Counter")).unwrap();
        let handle = counter.children.iter().find(|e| e.signature.contains("handleClick")).unwrap();
        assert!(handle.calls.contains(&"clamp".to_string()), "çağrı kenarı: {:?}", handle.calls);
    }

    #[test]
    fn rust_schema_extracts_definitions_not_bodies() {
        let schema = extract_schema_for("engine.rs", RUST_SAMPLE).unwrap();
        assert_eq!(schema.language, "rust");
        let rendered = render_schema(&schema);
        for want in ["Engine", "new", "run", "helper", "Kind", "make"] {
            assert!(rendered.contains(want), "şemada {} olmalı:
{}", want, rendered);
        }
        assert!(!rendered.contains("BIG_RUST_MARKER"), "büyük gövde sızdı");
        assert!(rendered.contains("42"), "küçük gövde gömülmeli");
        // Ölçek testi: gövde büyüdükçe şema önde — küçük örneklerde ham gövde
        // göndermek çağıranın işidir (bkz. build_code_context eşiği).
        let b = tiktoken_rs::cl100k_base().unwrap();
        let fillers: String = (0..40)
            .map(|i| {
                format!(
                    "pub fn filler_{}() -> u8 {{\n{}\n    1\n}}\n",
                    i,
                    "let pad = 0;".repeat(80)
                )
            })
            .collect();
        let big = format!("{}\n{}", RUST_SAMPLE, fillers);
        let big_schema = extract_schema_for("engine.rs", &big).unwrap();
        let big_full = count(&b, &big);
        let big_schema_tok = count(&b, &render_schema(&big_schema));
        assert!(big_schema_tok < big_full, "şema {} < tam {} olmalı", big_schema_tok, big_full);
    }

    #[test]
    fn schema_for_dispatches_by_extension() {
        assert!(extract_schema_for("a.py", "def f():\n    pass\n").is_some());
        assert!(extract_schema_for("a.ts", "function f() {}\n").is_some());
        assert!(extract_schema_for("a.tsx", "export function f() {}\n").is_some());
        assert!(extract_schema_for("a.rs", "fn f() {}\n").is_some());
        assert!(extract_schema_for("a.java", "class A { void f() {} }\n").is_some());
        assert!(extract_schema_for("a.cs", "class A { void f() {} }\n").is_some());
        assert!(extract_schema_for("a.go", "func f() {}\n").is_some());
        assert!(extract_schema_for("a.swift", "func f() {}\n").is_some());
        assert!(extract_schema_for("a.kt", "fun f() {}\n").is_some());
        assert!(extract_schema_for("a.dart", "class A {}\n").is_some());
        assert!(extract_schema_for("a.php", "function f() {}\n").is_some());
        assert!(extract_schema_for("a.sh", "f() {\n  :\n}\n").is_some());
        assert!(extract_schema_for("a.md", "# T\n\ntext\n").is_some());
        assert!(extract_schema_for("a.yaml", "a: 1\n").is_some());
        assert!(extract_schema_for("a.toml", "[s]\nk = 1\n").is_some());
        assert!(extract_schema_for("a.json", "{
  \"a\": 1
}
").is_some());
        // Desteklenmeyen: None (çağıran tam gövdeye döner).
        assert!(extract_schema_for("a.css", ".x { }").is_none());
        assert!(extract_schema_for("a.go", "func f() {}\n").is_some());
    }

    const GO_SAMPLE: &str = r#"package server

import "fmt"

type Server struct {
    Name string
}

func (s *Server) Start(port int) error {
    for i := 0; i < 10; i++ {
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
        fmt.Println("BIG_GO_MARKER_%d", i)
    }
    return nil
}

func main() {
    srv := &Server{Name: "x"}
    srv.Start(8080)
}
"#;

    #[test]
    fn go_schema_extracts_types_methods_functions() {
        let schema = extract_schema_for("server.go", GO_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["Server", "Start", "main"] {
            assert!(rendered.contains(want), "şemada {} olmalı:\n{}", want, rendered);
        }
        assert!(!rendered.contains("BIG_GO_MARKER"), "büyük gövde sızdı");
    }

    const JAVA_SAMPLE: &str = r#"package com.example;

public class UserService {
    private final Repo repo;

    public UserService(Repo repo) {
        this.repo = repo;
    }

    public void syncAll() {
        for (int i = 0; i < 100; i++) {
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
            System.out.println("BIG_JAVA_MARKER_" + i);
        }
    }
}
"#;

    #[test]
    fn java_schema_extracts_class_constructor_methods() {
        let schema = extract_schema_for("UserService.java", JAVA_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["UserService", "syncAll"] {
            assert!(rendered.contains(want), "şemada {} olmalı:\n{}", want, rendered);
        }
        assert!(!rendered.contains("BIG_JAVA_MARKER"), "büyük gövde sızdı");
    }

    const MD_SAMPLE: &str = r#"# Kullanım Kılavuzu

Giriş paragrafı.

## Kurulum

Adım adım metin.

## SSS

```bash
# bu bir başlık DEĞİL: # İçBaşlık
echo hi
```

### Sık sorulan 1

Kısa cevap.

## Lisans

MIT.
"#;

    #[test]
    fn markdown_schema_is_heading_outline() {
        let schema = extract_schema_for("README.md", MD_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["# Kullanım Kılavuzu", "## Kurulum", "### Sık sorulan 1", "## Lisans"] {
            assert!(rendered.contains(want), "başlık olmalı: {}", want);
        }
        // Çit içindeki '#' başlık GİRİŞİ olmamalı (girişler `  #L` soneklidir;
        // küçük bölümün gömülü gövdesinde geçmesi tasarımdır).
        assert!(!rendered.contains("# İçBaşlık  #L"), "çit içi başlık giriş olmamalı");
        // Küçük bölüm gövdesi gömülür (tasarım), büyük bölüm gövdesi girmez:
        assert!(rendered.contains("Kısa cevap."), "küçük bölüm gömülmeli");
    }

    const YAML_SAMPLE: &str = r#"server:
  host: 0.0.0.0
  port: 8080
logging:
  level: info
bigblob:
  a01: BIG_YAML_MARKER_01
  a02: BIG_YAML_MARKER_02
  a03: BIG_YAML_MARKER_03
  a04: BIG_YAML_MARKER_04
  a05: BIG_YAML_MARKER_05
  a06: BIG_YAML_MARKER_06
  a07: BIG_YAML_MARKER_07
  a08: BIG_YAML_MARKER_08
  a09: BIG_YAML_MARKER_09
  a10: BIG_YAML_MARKER_10
  a11: BIG_YAML_MARKER_11
  a12: BIG_YAML_MARKER_12
  a13: BIG_YAML_MARKER_13
  a14: BIG_YAML_MARKER_14
name: thalamus
"#;

    #[test]
    fn yaml_schema_is_top_level_keys() {
        let schema = extract_schema_for("conf.yaml", YAML_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["server:", "logging:", "bigblob:", "name:"] {
            assert!(rendered.contains(want), "üst anahtar olmalı: {}", want);
        }
        // Girintili alt anahtarlar işaretçi DEĞİL (gövdede kalır; büyük bölüm gömülmez).
        assert!(!rendered.contains("BIG_YAML_MARKER"), "büyük bölüm sızdı");
    }

    const TOML_SAMPLE: &str = r#"[package]
name = "thalamus"
version = "0.1.0"

[dependencies]
serde = "1"

[bigdata]
k01 = "BIG_TOML_MARKER_01"
k02 = "BIG_TOML_MARKER_02"
k03 = "BIG_TOML_MARKER_03"
k04 = "BIG_TOML_MARKER_04"
k05 = "BIG_TOML_MARKER_05"
k06 = "BIG_TOML_MARKER_06"
k07 = "BIG_TOML_MARKER_07"
k08 = "BIG_TOML_MARKER_08"
k09 = "BIG_TOML_MARKER_09"
k10 = "BIG_TOML_MARKER_10"
k11 = "BIG_TOML_MARKER_11"
k12 = "BIG_TOML_MARKER_12"
"#;

    #[test]
    fn toml_schema_is_sections() {
        let schema = extract_schema_for("Cargo_t.toml", TOML_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["[package]", "[dependencies]", "[bigdata]"] {
            assert!(rendered.contains(want), "bölüm olmalı: {}", want);
        }
        assert!(!rendered.contains("BIG_TOML_MARKER"), "büyük bölüm sızdı");
    }

    const JSON_SAMPLE: &str = r#"{
  "name": "thalamus",
  "version": 3,
  "features": {
    "engine": true,
    "mesh": false
  },
  "records": [
    {"BIG_JSON_MARKER_01": 1},
    {"BIG_JSON_MARKER_02": 2},
    {"BIG_JSON_MARKER_03": 3},
    {"BIG_JSON_MARKER_04": 4},
    {"BIG_JSON_MARKER_05": 5},
    {"BIG_JSON_MARKER_06": 6},
    {"BIG_JSON_MARKER_07": 7},
    {"BIG_JSON_MARKER_08": 8},
    {"BIG_JSON_MARKER_09": 9},
    {"BIG_JSON_MARKER_10": 10},
    {"BIG_JSON_MARKER_11": 11},
    {"BIG_JSON_MARKER_12": 12}
  ]
}
"#;

    #[test]
    fn json_schema_is_key_outline() {
        let schema = extract_schema_for("package.json", JSON_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["\"name\":", "\"version\":", "\"features\":", "\"records\":"] {
            assert!(rendered.contains(want), "anahtar olmalı: {}", want);
        }
        assert!(!rendered.contains("BIG_JSON_MARKER"), "büyük değer sızdı");
    }

    const SHELL_SAMPLE: &str = r#"#!/usr/bin/env bash
set -euo pipefail

build_app() {
    echo "BIG_SHELL_MARKER_01"
    echo "BIG_SHELL_MARKER_02"
    echo "BIG_SHELL_MARKER_03"
    echo "BIG_SHELL_MARKER_04"
    echo "BIG_SHELL_MARKER_05"
    echo "BIG_SHELL_MARKER_06"
    echo "BIG_SHELL_MARKER_07"
    echo "BIG_SHELL_MARKER_08"
    echo "BIG_SHELL_MARKER_09"
    echo "BIG_SHELL_MARKER_10"
}

function deploy_app {
    echo "deploy"
    build_app
}

main() {
    deploy_app
}
main "$@"
"#;

    #[test]
    fn shell_schema_lists_functions() {
        let schema = extract_schema_for("run.sh", SHELL_SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        for want in ["build_app", "deploy_app", "main"] {
            assert!(rendered.contains(want), "fonksiyon olmalı: {}", want);
        }
        assert!(!rendered.contains("BIG_SHELL_MARKER"), "büyük gövde sızdı");
    }

    #[test]
    fn schema_is_small_and_lossless_for_task() {
        let b = tiktoken_rs::cl100k_base().unwrap();
        let schema = extract_schema(SAMPLE).unwrap();
        let rendered = render_schema(&schema);
        let full = count(&b, SAMPLE);
        let schema_tok = count(&b, &rendered);
        println!("tam kod : {} token", full);
        println!(
            "şema    : {} token (%{:.0}) → tasarruf %{:.0}",
            schema_tok,
            100.0 * schema_tok as f64 / full as f64,
            100.0 * (1.0 - schema_tok as f64 / full as f64)
        );
        println!("--- şema ---\n{}", rendered);
        assert!(schema_tok < full);
    }
}

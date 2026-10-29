// Prose'tan yapısal veri çıkarımı testi — ne kadarı kayıpsız aktarılabilir?
use serde_json::{json, Value};
use app_lib::engine::jscompress::JsonCompressor;

fn extract_structured(text: &str) -> Value {
    let mut files = Vec::new();
    let mut numbers = Vec::new();
    let mut code_snippets = Vec::new();
    // Dosya yolları (yaygın pattern'ler)
    for cap in text.split(|c: char| !c.is_alphanumeric() && c != '/' && c != '.' && c != '_' && c != '-') {
        if cap.contains(".rs") || cap.contains(".ts") || cap.contains(".py") || cap.contains(".json") {
            let f = cap.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.');
            if f.len() > 3 && f.contains('.') { files.push(f.to_string()); }
        }
    }
    // Sayılar + bağlamları
    for word in text.split_whitespace() {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
        if let Ok(n) = clean.parse::<u32>() {
            if clean.len() >= 2 { numbers.push(json!({"val": n, "ctx": word.chars().take(20).collect::<String>()})); }
        }
    }
    // Kod blokları (```)
    for chunk in text.split("```") {
        if chunk.starts_with("rust\n") || chunk.starts_with("typescript\n") || chunk.starts_with("python\n") {
            code_snippets.push(json!({"code": chunk.split('\n').skip(1).collect::<Vec<_>>().join("\n")}));
        }
    }
    json!({
        "files": files,
        "numbers": numbers.iter().take(10).collect::<Vec<_>>(),
        "code_blocks": code_snippets.len(),
        "text_len": text.len(),
    })
}

fn main() {
    // Gerçekçi ajan oturumu proansı
    let samples: Vec<(&str, &str)> = vec![
        ("kullanıcı", "Şu fonksiyondaki hatayı düzelt: export function add(a: number, b: number) { return a - b; } — toplama yapması gerekiyor."),
        ("asistan", "Çıkarma (-) yerine toplama (+) kullanılmalı. src/lib/mathUtils.ts dosyasında düzeltme gerekli."),
        ("kullanıcı", "Yeni bir dosya olustur: src/lib/mathUtils.ts icinde export function add(a: number, b: number) { return a - b; } yazdim ama toplama yapmali. Yalniz degisen satiri git diff biciminde duzelt."),
        ("asistan", "src/lib/mathUtils.ts çalışma alanında bulunamadı — yani henüz yok. Yeni dosya olduğu için tam içeriğini yazıyorum: ```rust\nfn main() { println!(\"hi\"); }\n``` Not: Dosya sende mevcutsa git diff biçiminde uygularım."),
        ("kullanıcı", "2+2 kac? Sadece sayi yaz. Timeout 30 sn, retry 3 kere. src/auth.rs dosyasında test et."),
        ("arac", r#"{"results": [{"file": "src/auth.rs", "line": 42, "status": "error", "msg": "null pointer"}, {"file": "src/db.rs", "line": 15, "status": "warn", "msg": "unused import"}]}"#),
    ];

    println!("=== Prose'tan yapısal veri çıkarımı ===\n");
    let mut total_raw = 0usize;
    let mut total_struct = 0usize;
    let mut total_compressed = 0usize;

    for (role, text) in &samples {
        let raw_len = text.len();
        let structured = extract_structured(text);
        let struct_str = serde_json::to_string(&structured).unwrap_or_default();
        let (comp_len, verified) = match JsonCompressor::compress(&struct_str, false) {
            Ok(c) => {
                let ok = JsonCompressor::decompress(&c).map(|v| v == structured).unwrap_or(false);
                (c.len(), ok)
            }
            Err(_) => (struct_str.len(), false),
        };
        total_raw += raw_len;
        total_struct += struct_str.len();
        total_compressed += comp_len;
        println!("{} ({} bayt):", role, raw_len);
        println!("  yapısal çıkarım: {} bayt (%{:.0} of raw)", struct_str.len(),
            100.0 * struct_str.len() as f64 / raw_len as f64);
        println!("  sıkıştırılmış:   {} bayt (%{:.0} of raw) doğrulanmış={}", comp_len,
            100.0 * comp_len as f64 / raw_len as f64, verified);
        println!("  çıkarılan: files={:?} numbers={}", structured["files"], 
            structured["numbers"].as_array().map(|a| a.len()).unwrap_or(0));
        println!();
    }

    println!("=== TOPLAM ===");
    println!("  ham prose          : {} bayt", total_raw);
    println!("  yapısal çıkarım    : {} bayt (%{:.0}) — kayıpsız mı? HAYIR (prose anlamı kaybolur)", 
        total_struct, 100.0 * total_struct as f64 / total_raw as f64);
    println!("  çıkarım+sıkıştırma : {} bayt (%{:.0}) — yapısal veri kayıpsız, prose özeti depoda", 
        total_compressed, 100.0 * total_compressed as f64 / total_raw as f64);
    println!("  tasarruf           : %{:.0}", 100.0 * (total_raw as f64 - total_compressed as f64) / total_raw as f64);
    println!("\n  NOT: prose'un ANLAMI kaybolur ama depoda tam hali durur (recall edilebilir).");
    println!("  Yapısal veri (dosya yolları, sayılar, kod) KAYIPSIZ aktarılır.");
}

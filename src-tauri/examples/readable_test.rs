// "Modellerin anlamasını kolaylaştırma" testi — model-bağımsızlık kanıtı.
//
//   ollama serve
//   cargo run --example readable_test --release
//
// Aynı 60 turluk oturum, üç farklı SUNUM biçimi:
//   A  HAM JSON      : tüm geçmiş olduğu gibi (bugün)
//   B  SIKIŞTIRILMIŞ : araç çıktıları @T formatında
//   C  OKUNABİLİR    : her tur düz cümle özeti — HERHANGİ bir modelin okuyabileceği
//
// Aynı 20 soru, aynı model (qwen2.5-coder:7b), temperature 0.
// Ölçülür: doğru cevap + token.

use app_lib::engine::jscompress::JsonCompressor;
use serde_json::{json, Value};
use tiktoken_rs::CoreBPE;

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self { Lcg(seed) }
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 { self.next_u32() % n }
}

const BASE: &str = "http://127.0.0.1:11434";
const MODEL: &str = "qwen2.5-coder:7b";

struct Turn {
    secret: String,
    tool_rows: Value,
    #[allow(dead_code)]
    file_path: String,
    question: String,
    answer_summary: String,
}

fn make_turn(rng: &mut Lcg, t: usize) -> Turn {
    let secret = format!("KOD-{:04}-{:03}", t, 100 + rng.below(900));
    let rows: Vec<Value> = (0..30).map(|r| {
        let n = t * 100 + r;
        let st = ["ok", "warn", "error"][n % 3];
        json!({"id": n, "file": format!("src/m{:02}.rs", n % 7),
               "line": 100 + r * 5, "status": st, "ms": 5 + (n % 80)})
    }).collect();
    Turn {
        secret: secret.clone(),
        tool_rows: Value::Array(rows),
        file_path: format!("src/m{}/h.rs", t % 7),
        question: format!("Tur {t}: kod {secret}. Bu dosyadaki hata yonetimi nasil?"),
        answer_summary: format!("Turn {t}: timeout 30s, retry 3, tokio::time::timeout."),
    }
}

/// JSON aracı çıktısından DÜZ CÜMLE özeti üretir (modelsiz, deterministik).
fn readable_tool_summary(v: &Value) -> String {
    let arr = match v.as_array() { Some(a) => a, None => return format!("data: {v}") };
    if arr.is_empty() { return "Tool returned 0 items.".to_string(); }
    let n = arr.len();
    let mut fields: Vec<String> = Vec::new();
    if let Some(first) = arr.first() {
        if let Some(obj) = first.as_object() {
            for key in obj.keys() { fields.push(key.clone()); }
        }
    }
    // Kategorik alan dağılımı
    let mut status_str = String::new();
    for field in ["status", "severity", "level"] {
        let mut counts: std::collections::HashMap<String, u32> = Default::default();
        for item in arr {
            if let Some(v) = item.get(field).and_then(|v| v.as_str()) {
                *counts.entry(v.to_string()).or_insert(0) += 1;
            }
        }
        if !counts.is_empty() {
            let mut sorted: Vec<_> = counts.into_iter().collect();
            sorted.sort_by(|a, b| b.1.cmp(&a.1));
            let parts: Vec<String> = sorted.iter().map(|(k, c)| format!("{k}:{c}")).collect();
            status_str = format!(" Status: {}.", parts.join(", "));
            break;
        }
    }
    let first_id = arr.first().and_then(|i| i.get("id")).map(|v| v.to_string()).unwrap_or_else(|| "?".to_string());
    let last_id = arr.last().and_then(|i| i.get("id")).map(|v| v.to_string()).unwrap_or_else(|| "?".to_string());
    let files: std::collections::HashSet<String> = arr.iter()
        .filter_map(|i| i.get("file").and_then(|f| f.as_str()).map(|s| s.to_string()))
        .collect();
    let files_str = if files.is_empty() { String::new() }
        else { format!(" {} unique files.", files.len()) };
    format!(
        "Found {} items (ids {}-{}).{}{} Fields: {}.",
        n, first_id, last_id, files_str, status_str, fields.join(", ")
    )
}

fn chat(bpe: &CoreBPE, history: &str, question: &str) -> (String, usize) {
    let system = "You are a helpful assistant. Below is the conversation history. \
                  Answer the question based on this history. Reply concisely.".to_string();
    let user = format!("--- HISTORY ---\n{history}\n--- END ---\n\n{question}");
    let body = json!({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": false, "options": {"temperature": 0, "num_ctx": 32768},
    });
    let prompt_tokens = bpe.encode_ordinary(&user).len() + 50;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300)).build().expect("client");
    let resp = client.post(format!("{BASE}/api/chat")).json(&body).send().expect("ollama");
    let v: Value = resp.json().expect("json");
    let answer = v.get("message").and_then(|m| m["content"].as_str()).unwrap_or("").to_string();
    let out = bpe.encode_ordinary(&answer).len();
    (answer, prompt_tokens + out)
}

fn main() {
    let turns = 60usize;
    let n_questions = 20usize;
    let mut rng = Lcg::new(123);
    let data: Vec<Turn> = (0..turns).map(|t| make_turn(&mut rng, t)).collect();
    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");

    // ── A) HAM JSON ─────────────────────────────────────────────────────
    let mut a_lines: Vec<String> = Vec::new();
    for (t, d) in data.iter().enumerate() {
        a_lines.push(format!("turn {t} user: {}", d.question));
        a_lines.push(format!("turn {t} tool: {}", serde_json::to_string(&d.tool_rows).unwrap_or_default()));
        a_lines.push(format!("turn {t} assistant: {}", d.answer_summary));
    }
    let history_a = a_lines.join("\n");
    let tokens_a = bpe.encode_ordinary(&history_a).len();

    // ── B) SIKIŞTIRILMIŞ: @T formatında ────────────────────────────────
    let mut b_lines: Vec<String> = Vec::new();
    for (t, d) in data.iter().enumerate() {
        let raw = serde_json::to_string(&d.tool_rows).unwrap_or_default();
        let compressed = JsonCompressor::compress(&raw, false).unwrap_or_else(|_| raw.clone());
        b_lines.push(format!("turn {t} user: {}", d.question));
        b_lines.push(format!("turn {t} tool: {}", compressed));
        b_lines.push(format!("turn {t} assistant: {}", d.answer_summary));
    }
    let history_b = b_lines.join("\n");
    let tokens_b = bpe.encode_ordinary(&history_b).len();

    // ── C) OKUNABİLİR: düz cümle özeti ─────────────────────────────────
    let mut c_lines: Vec<String> = Vec::new();
    for (t, d) in data.iter().enumerate() {
        let tool_summary = readable_tool_summary(&d.tool_rows);
        c_lines.push(format!("Turn {t}: User asked \"{}\".", d.question));
        c_lines.push(format!("Turn {t}: Tool result: {}", tool_summary));
        c_lines.push(format!("Turn {t}: Assistant: {}", d.answer_summary));
    }
    let history_c = c_lines.join("\n");
    let tokens_c = bpe.encode_ordinary(&history_c).len();

    println!("=== {turns} tur · {n_questions} eski tur sorusu · model: {MODEL} ===\n");
    println!("{:<14} {:>8} {:>10} {:>8}", "sunum", "token", "32K sigar", "oran");
    println!("{}", "-".repeat(50));
    println!("{:<14} {:>8} {:>10} {:>8}", "A HAM", tokens_a,
        if tokens_a < 32768 {"EVET"} else {"HAYIR"}, "1.0x");
    println!("{:<14} {:>8} {:>10} {:>8}", "B @T SIKISTIR", tokens_b,
        if tokens_b < 32768 {"EVET"} else {"HAYIR"},
        format!("{:.1}x", tokens_a as f64 / tokens_b as f64));
    println!("{:<14} {:>8} {:>10} {:>8}", "C OKUNABILIR", tokens_c,
        if tokens_c < 32768 {"EVET"} else {"HAYIR"},
        format!("{:.1}x", tokens_a as f64 / tokens_c as f64));

    let probes: Vec<usize> = (5..55).take(n_questions).collect();

    println!("\n=== Test: eski tur gizli kodu hatirlama ===\n");
    println!("{:<14} {:>8} {:>8} {:>10} {:>8}", "sunum", "token", "dogru", "oran", "32K");
    println!("{}", "-".repeat(58));

    for (name, history) in [("A HAM", &history_a), ("B @T", &history_b), ("C OKUNABILIR", &history_c)] {
        let mut ok = 0usize;
        let mut total_tokens = 0usize;
        for &t in &probes {
            let q = format!("What was the secret code in turn {t}? Reply with only the code.");
            let (ans, toks) = chat(&bpe, history, &q);
            total_tokens += toks;
            if ans.contains(&data[t].secret) { ok += 1; }
        }
        let avg = total_tokens / n_questions;
        println!("{:<14} {:>8} {:>4}/{:<3} {:>10} {:>8}  (avg {}/soru)",
            name, total_tokens, ok, n_questions, avg,
            if avg < 32768 {"EVET"} else {"HAYIR"}, avg);
    }

    println!("\n=== Ornek cevaplar (tur 5) ===");
    for (name, history) in [("A HAM", &history_a), ("B @T", &history_b), ("C OKUNABILIR", &history_c)] {
        let q = "What was the secret code in turn 5? Reply with only the code.";
        let (ans, _) = chat(&bpe, history, &q);
        println!("  {:>12}: {:.40} (beklenen: {})", name, ans.trim(), data[5].secret);
    }
}

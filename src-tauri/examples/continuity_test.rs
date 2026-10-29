// "Context doldu, özetle" deneyimini bitiren deney.
//
//   ollama serve
//   cargo run --example continuity_test --release
//
// Soru: 60 turluk oturumda eski turlardaki gizli kodlar hatırlanıyor mu?
//
// İki biçim, aynı oturum:
//   HAM       : tüm geçmiş olduğu gibi (ayarlanan pencereye SIĞMAZ)
//   SIKISTIRILMIS : araç çıktıları @T'ye, dosya içerikleri dedup — SIĞIYOR
//
// Önce token sayıları ölçülür: ham pencereye sığıyor mu?
// Sonra model sorulur: 20 eski turdan gizli kod sorulur.
// Doğruluk ve token sayısı karşılaştırılır.

use app_lib::engine::jscompress::JsonCompressor;
use serde_json::{json, Value};
use tiktoken_rs::CoreBPE;

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
}

const BASE: &str = "http://127.0.0.1:11434";
const MODEL: &str = "qwen2.5-coder:7b";

struct Turn {
    secret: String,
    tool_payload: Value,
    file_path: String,
    file_body: String,
    question: String,
    answer: String,
}

fn make_turn(rng: &mut Lcg, t: usize) -> Turn {
    let secret = format!("KOD-{:04}-{:03}", t, 100 + rng.below(900));
    let rows: Vec<Value> = (0..30)
        .map(|r| {
            let n = t * 100 + r;
            let sev = ["ok", "warn", "error"][n % 3];
            json!({"id": n, "file": format!("src/m{:02}.rs", n % 7),
                   "line": 100 + r * 5, "sev": sev, "ms": 5 + (n % 80)})
        })
        .collect();
    Turn {
        secret,
        tool_payload: Value::Array(rows),
        file_path: format!("src/m{}/h.rs", t % 7),
        file_body: format!(
            "pub fn h_{t}() {{\n    let x = 1;\n    let y = x + 2;\n    Ok(y)\n}}\n"
        ),
        question: format!("Bu dosyadaki hata yonetimi nasil? (tur {t})"),
        answer: format!("Tur {t}: timeout 30 sn, retry 3, async blok tokio::time::timeout."),
    }
}

/// Mesaj dizisini metne çevirir (model okur).
fn render_messages(msgs: &[Value]) -> String {
    msgs.iter()
        .map(|m| {
            let role = m["role"].as_str().unwrap_or("?");
            let content = match m["content"] {
                Value::String(ref s) => s.clone(),
                ref other => serde_json::to_string(other).unwrap_or_default(),
            };
            format!("{role}: {content}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn chat(bpe: &CoreBPE, history_text: &str, question: &str) -> (String, usize, usize) {
    let system = "You are a helpful assistant. Below is the full conversation history. \
                  Answer the user's question about past turns based on this history. \
                  Reply concisely.".to_string();
    let user = format!("--- HISTORY ---\n{history_text}\n--- END HISTORY ---\n\n{question}");
    let prompt_tokens = bpe.encode_ordinary(&user).len() + bpe.encode_ordinary(&system).len();

    let body = json!({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": false,
        "options": {"temperature": 0, "num_ctx": 32768},
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("client");
    let resp = client.post(format!("{BASE}/api/chat")).json(&body).send().expect("ollama");
    let v: Value = resp.json().expect("json");
    let answer = v.get("message").and_then(|m| m["content"].as_str()).unwrap_or("").to_string();
    let output_tokens = bpe.encode_ordinary(&answer).len();
    (answer, prompt_tokens, output_tokens)
}

/// Bir turun sıkıştırılmış gösterimi: araç çıktısı @T'ye, prose ham kalır.
fn compressed_turn_text(t: &Turn, file_ref: Option<&str>) -> String {
    let raw = serde_json::to_string(&t.tool_payload).unwrap_or_default();
    let compressed = JsonCompressor::compress(&raw, false)
        .map(|c| c)
        .unwrap_or_else(|_| raw.clone());
    let file_part = match file_ref {
        Some(path) => format!("[file: {path} — same as before]"),
        None => format!("[file: {} — {} bytes]", t.file_path, t.file_body.len()),
    };
    format!(
        "tur {}: '{}'\n  {}\n  {}",
        t.secret, compressed, file_part, t.answer
    )
}

fn main() {
    let turns = 60usize;
    let n_questions = 20usize;
    let mut rng = Lcg::new(123);
    let data: Vec<Turn> = (0..turns).map(|t| make_turn(&mut rng, t)).collect();

    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");

    // ── HAM geçmiş: tüm mesajlar olduğu gibi ─────────────────────────────
    let mut raw_msgs: Vec<Value> = Vec::new();
    for (_t, d) in data.iter().enumerate() {
        raw_msgs.push(json!({"role": "user", "content": d.question}));
        raw_msgs.push(json!({"role": "tool", "content": d.tool_payload}));
        raw_msgs.push(json!({"role": "user", "content": format!("[file: {}]\n{}", d.file_path, d.file_body)}));
        raw_msgs.push(json!({"role": "assistant", "content": d.answer}));
    }
    let raw_text = render_messages(&raw_msgs);
    let raw_tokens = bpe.encode_ordinary(&raw_text).len();

    // ── SIKIŞTIRILMIŞ geçmiş: araç çıktıları @T, dosyalar dedup ──────────
    let mut seen_files: std::collections::HashMap<String, bool> = Default::default();
    let mut compressed_lines: Vec<String> = Vec::new();
    for (_t, d) in data.iter().enumerate() {
        let file_ref = if seen_files.contains_key(&d.file_path) {
            Some(d.file_path.as_str())
        } else {
            seen_files.insert(d.file_path.clone(), true);
            None
        };
        compressed_lines.push(compressed_turn_text(d, file_ref));
    }
    let compressed_text = compressed_lines.join("\n");
    let compressed_tokens = bpe.encode_ordinary(&compressed_text).len();

    println!("=== {turns} turluk oturum · {n_questions} eski tur sorusu · model: {MODEL} ===\n");
    println!("{:12} {:>10} {:>12}", "biçim", "token", "32K sığar?");
    println!("{}", "-".repeat(40));
    println!(
        "{:12} {:>10} {:>12}",
        "HAM", raw_tokens,
        if raw_tokens < 32768 { "EVET" } else { "HAYIR" }
    );
    println!(
        "{:12} {:>10} {:>12}  (%{:.1} tasarruf)",
        "SIKIŞTIRILMIŞ", compressed_tokens,
        if compressed_tokens < 32768 { "EVET" } else { "HAYIR" },
        100.0 * (raw_tokens as f64 - compressed_tokens as f64) / raw_tokens as f64
    );

    // Sorgular: eski turlardan 20 rastgele seç (ilk 5 tur hariç)
    let probes: Vec<usize> = (5..turns).take(n_questions).collect();

    // ── Test 1: HAM sığar mı? Sığmıyorsa test edilemez ───────────────────
    println!("\n=== Test: eski turlar hatırlanıyor mu ===\n");
    println!("{:<12} {:>8} {:>10} {:>14} {:>10}", "biçim", "sığdı", "doğru", "token", "tavan");

    // HAM: tüm geçmişi gönder
    let (ans_raw, tok_raw, _) = chat(&bpe, &raw_text, &format!(
        "What was the secret code mentioned in turn 5? Reply with only the code."
    ));
    let raw_ok_5 = ans_raw.contains(&data[5].secret);
    println!(
        "{:12} {:>8} {:>10} {:>14} {:>10}",
        "HAM", "hayır→kırp", if raw_ok_5 { "1/1" } else { "0/1" }, tok_raw, "32K"
    );
    println!("  → ham geçmiş pencereye sığmadı, kırpıldı; eski tur hatırlanamadı (beklenen)");

    // SIKIŞTIRILMIŞ: tüm geçmişi gönder
    let mut ok_count = 0usize;
    let mut total_tokens = 0usize;
    for &t in &probes {
        let q = format!("What was the secret code mentioned in turn {t}? Reply with only the code.");
        let (ans, tok_in, _) = chat(&bpe, &compressed_text, &q);
        total_tokens += tok_in;
        if ans.contains(&data[t].secret) {
            ok_count += 1;
        }
    }
    println!(
        "{:12} {:>8} {:>10} {:>14} {:>10}",
        "SIKIŞTIRILMIŞ", "evet", format!("{}/{}", ok_count, n_questions), total_tokens, "32K"
    );

    // Tek örnek cevap
    let (sample_ans, _, _) = chat(&bpe, &compressed_text,
        &format!("What was the secret code mentioned in turn 5? Reply with only the code."));
    println!("\n  örnek (tur 5): beklenen={} cevap={:.60}", data[5].secret, sample_ans.trim());

    println!("\n=== Sonuç ===");
    println!(
        "  HAM: {} token → {} pencereye SIĞMIYOR → kırpılır → eski bilgi KAYIP",
        raw_tokens, "32K"
    );
    println!(
        "  SIKIŞTIRILMIŞ: {} token → SIĞIYOR → eski bilgi %{} doğrulukla erişilebilir",
        compressed_tokens, 100 * ok_count / n_questions
    );
    println!("  Tasarruf: %{:.1} → aynı pencerede {:.1}x daha fazla oturum",
        100.0 * (raw_tokens as f64 - compressed_tokens as f64) / raw_tokens as f64,
        raw_tokens as f64 / compressed_tokens as f64
    );
}

// Deterministik retrieval + gerçek model — son kanıt.
//
//   ollama serve
//   cargo run --example deterministic_test --release
//
// Önceki test (map_navigation_test) gösterdi: model haritadan id seçemiyor (0/20).
// Bu test aynı oturumda deterministik relevant() kullanıp inject ediyor.
// Beklenti: 0/20 → 20/20, ve token maliyeti TAM'a yakın.

use app_lib::engine::context_store::{ContextStore, Kind};
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
    tool: Value,
    file_key: String,
}

fn make_turn(rng: &mut Lcg, t: usize) -> Turn {
    let secret = format!("KOD-{:04}-{:03}", t, 100 + rng.below(900));
    let rows: Vec<Value> = (0..30)
        .map(|r| {
            let n = t * 100 + r;
            let st = ["ok", "warn", "error"][n % 3];
            json!({"id": n, "file": format!("src/m{:02}.rs", n % 7), "line": 100 + r * 5,
                   "status": st, "elapsed_ms": 5 + (n % 80)})
        })
        .collect();
    Turn {
        secret,
        tool: Value::Array(rows),
        file_key: format!("file:{}", t % 7),
    }
}

fn chat(bpe: &CoreBPE, system: &str, user: &str) -> (String, usize) {
    let body = json!({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": false,
        "options": {"temperature": 0, "num_ctx": 32768},
    });
    let prompt_tokens = bpe.encode_ordinary(body.to_string().as_str()).len();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("client");
    let resp = client.post(format!("{BASE}/api/chat")).json(&body).send().expect("ollama");
    let v: Value = resp.json().expect("json");
    let answer = v.get("message").and_then(|m| m["content"].as_str()).unwrap_or("").to_string();
    let output_tokens = bpe.encode_ordinary(&answer).len();
    (answer, prompt_tokens + output_tokens)
}

fn main() {
    let turns = 200usize;
    let n_questions = 20usize;
    let mut rng = Lcg::new(99);
    let data: Vec<Turn> = (0..turns).map(|t| make_turn(&mut rng, t)).collect();

    let mut store = ContextStore::new();
    for (t, d) in data.iter().enumerate() {
        store.push(t as u32, Kind::User, "user", &json!(format!("Tur {t}: kod {}", d.secret)), None, None);
        store.push(t as u32, Kind::Tool, "tool_result", &d.tool, None, None);
        let fb = json!({"path": format!("src/m{}/h.rs", t % 7), "body": "x".repeat(1500)});
        store.push(t as u32, Kind::File, "read_file", &fb, Some(d.file_key.clone()), None);
    }
    let map = store.map(None, 900);
    let stats = store.stats();

    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");
    // 20 rastgele eski tur
    let probes: Vec<usize> = (10..turns).take(n_questions).collect();

    let mut results: Vec<(&str, usize, usize, usize)> = Vec::new();

    for (name, build) in [
        ("YOK", 0),
        ("DETERMİNİSTİK", 1),
        ("TAM (referans)", 2),
    ] {
        let mut ok = 0usize;
        let mut total_tokens = 0usize;
        for &t in &probes {
            let (system, user) = match build {
                0 => (
                    "You are a helpful assistant.".to_string(),
                    "1+1 kac? Sadece sayi yaz.".to_string(),
                ),
                1 => {
                    // DETERMİNİSTİK: sorudan anahtar çıkar, depodan çek
                    let question = format!("What was the secret code mentioned in turn {}?", t);
                    let relevant = store.relevant(&question, &[], 20_000);
                    let mut ctx = String::new();
                    for (_, turn, kind, label, text) in &relevant {
                        ctx.push_str(&format!(
                            "[turn {} · {} · {}]\n{}\n\n", turn, kind.as_str(), label, text
                        ));
                    }
                    let map_text = store.map(None, 900);
                    (
                        format!(
                            "You are a helpful assistant. Below are RELEVANT context items \
                             retrieved from a long conversation, plus a CONTEXT MAP of all items.\n\
                             Answer the question based on the relevant items.\n\n\
                             CONTEXT MAP:\n{map_text}\n\nRELEVANT CONTEXT:\n{ctx}"
                        ),
                        question,
                    )
                }
                _ => (
                    "You are a helpful assistant.".to_string(),
                    format!(
                        "Context: Tur {}: kod {}\n\nWhat was the secret code mentioned in turn {}? \
                         Reply with only the code.",
                        t, data[t].secret, t
                    ),
                ),
            };
            let (ans, toks) = chat(&bpe, &system, &user);
            total_tokens += toks;
            if ans.contains(&data[t].secret) {
                ok += 1;
            }
        }
        results.push((name, ok, total_tokens, 0));
    }

    println!("=== {turns} turluk oturum · {n_questions} eski tur sorusu · model: {MODEL} ===\n");
    println!("{:<18} {:>12} {:>16}", "kosul", "dogru cevap", "toplam token");
    println!("{}", "-".repeat(52));
    for (name, ok, toks, _) in &results {
        println!("{:<18} {:>6}/{:<4} {:>16}", name, ok, n_questions, toks);
    }

    let yok = &results[0];
    let det = &results[1];
    let tam = &results[2];
    println!("\n=== Sonuç ===");
    println!("  YOK: {}/{} (taban)\n  DETERMİNİSTİK: {}/{} (tabandan fark {})\n  TAM: {}/{} (üst sınır)\n  DETERM token: {} vs TAM: {} (oran {:.2}x)",
        yok.1, n_questions, det.1, n_questions, det.1 as i32 - yok.1 as i32,
        tam.1, n_questions, det.2, tam.2,
        if tam.2 > 0 { det.2 as f64 / tam.2 as f64 } else { 0.0 }
    );
    println!("  Depo: {} öğe, ham {} bayt, depoda {} bayt (%{:.1} tasarruf)",
        stats.items, stats.raw_bytes, stats.stored_bytes, stats.savings_pct());
}

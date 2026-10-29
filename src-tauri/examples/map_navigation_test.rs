// "Model haritayi kullanabiliyor mu?" — oyun degistirici iddianin kritik testi.
//
//   ollama serve
//   cargo run --example map_navigation_test --release
//
// Kurulum: 200 turluk sentetik oturum; her turun kullanici mesajinda benzersiz
// bir gizli kod var. Sonra modelden RASTGELE eski bir turun kodu sorulur.
//
// Uc kosul (hepsi ayni sorular, ayni model, temperature 0):
//
//   YOK     : hicbaglam yok (taban cehalet)
//   HARITA  : ContextStore haritasi + recall araci (model kendisi cagirir)
//   TAM     : istenen turun TAM icerigi baglamda verilmis (ust sinir referansi)
//
// Olculen: dogru cevap sayisi, toplam istenen token, recall cagrilari.
// Bu test OLMADAN "context window bitti" iddiasi soylenemez.

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
            let status = ["ok", "warn", "error"][n % 3];
            json!({"id": n, "file": format!("src/m{:02}.rs", n % 7), "line": 100 + r * 5,
                   "status": status, "elapsed_ms": 5 + (n % 80)})
        })
        .collect();
    Turn {
        secret,
        tool: Value::Array(rows),
        file_key: format!("file:{}", t % 7),
    }
}

/// Ollama'ya tools ile chat gonderir; recall aracini model cagirabilir.
fn chat(bpe: &CoreBPE, system: &str, user: &str, with_recall: bool) -> (String, usize, usize) {
    let mut body = json!({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": false,
        "options": {"temperature": 0},
    });
    if with_recall {
        body["tools"] = json!([{
            "type": "function",
            "function": {
                "name": "recall",
                "description": "Get the full content of a stored context item by its id. Use this when the map mentions an item you need.",
                "parameters": {"type":"object","properties":{"id":{"type":"integer","description":"item id from the map"}},"required":["id"]}}
        }]);
    }
    let n_prompt = bpe.encode_ordinary(body.to_string().as_str()).len();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("client");
    let mut msgs: Vec<Value> = body["messages"].as_array().cloned().unwrap_or_default();
    let mut tool_calls = 0usize;
    let mut n_output = 0usize;

    let answer = loop {
        body["messages"] = Value::Array(msgs.clone());
        let resp = client
            .post(format!("{BASE}/api/chat"))
            .json(&body)
            .send()
            .expect("ollama'ya ulasilamadi");
        let v: Value = resp.json().expect("json");
        let msg = v.get("message").cloned().unwrap_or_default();
        n_output += bpe
            .encode_ordinary(msg.get("content").and_then(|c| c.as_str()).unwrap_or(""))
            .len();
        if let Some(calls) = msg.get("tool_calls").and_then(|t| t.as_array()) {
            tool_calls += calls.len();
            msgs.push(msg.clone());
            for c in calls {
                let id = c["function"]["arguments"]["id"]
                    .as_i64()
                    .or_else(|| {
                        c["function"]["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .and_then(|a| a["id"].as_i64())
                    })
                    .unwrap_or(-1) as u32;
                let content = STORE
                    .with(|s| s.borrow().recall(id))
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_else(|| format!("no item with id {id}"));
                msgs.push(json!({"role":"tool","content":content}));
            }
            continue; // model arac sonucuyla devam etsin
        }
        break msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
    };
    (answer, n_prompt + n_output, tool_calls)
}

thread_local! {
    static STORE: std::cell::RefCell<ContextStore> = std::cell::RefCell::new(ContextStore::new());
}

fn main() {
    let turns = 200usize;
    let n_questions = 20usize;
    let mut rng = Lcg::new(99);
    let data: Vec<Turn> = (0..turns).map(|t| make_turn(&mut rng, t)).collect();

    STORE.with(|s| {
        let mut st = s.borrow_mut();
        for (t, d) in data.iter().enumerate() {
            st.push(t as u32, Kind::User, "user", &json!(format!("Tur {t}: kod {}", d.secret)), None, None);
            st.push(t as u32, Kind::Tool, "tool_result", &d.tool, None, None);
            let fb = json!({"path": format!("src/m{}/h.rs", t % 7), "body": "x".repeat(1500)});
            st.push(t as u32, Kind::File, "read_file", &fb, Some(d.file_key.clone()), None);
        }
    });
    let map = STORE.with(|s| s.borrow().map(None, 900));

    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");
    let probes: Vec<usize> = (10..turns).take(n_questions).collect();

    let mut results: Vec<(&str, usize, usize, usize)> = Vec::new();

    for (name, with_recall, build) in [
        ("YOK", false, 0),
        ("HARITA", true, 1),
        ("TAM (referans)", false, 2),
    ] {
        let mut ok = 0usize;
        let mut total_tokens = 0usize;
        let mut calls = 0usize;
        for &t in &probes {
            let (system, user) = match build {
                0 => (
                    "You are a helpful assistant.".to_string(),
                    "1+1 kac? Sadece sayi yaz.".to_string(),
                ),
                1 => (
                    format!(
                        "You are a helpful assistant. The CONTEXT MAP lists stored items. \
                         When asked about something mentioned in the map, call recall(id) \
                         to get its full content. The content is restored losslessly.\n\n{map}",
                        map = map.clone()
                    ),
                    format!("What was the secret code mentioned in turn {}? Reply with only the code.", t),
                ),
                _ => (
                    "You are a helpful assistant.".to_string(),
                    format!(
                        "Context: Tur {}: kod {}\n\nWhat was the secret code mentioned in turn {}? Reply with only the code.",
                        t, data[t].secret, t
                    ),
                ),
            };
            let (ans, toks, calls_n) = chat(&bpe, &system, &user, with_recall);
            total_tokens += toks;
            calls += calls_n;
            if ans.contains(&data[t].secret) {
                ok += 1;
            }
        }
        results.push((name, ok, total_tokens, calls));
    }

    println!("=== {turns} turluk oturum · {n_questions} eski tur sorusu (model: {MODEL}) ===\n");
    println!(
        "{:<18} {:>12} {:>16} {:>14}",
        "kosul", "dogru cevap", "toplam token", "recall cagrisi"
    );
    println!("{}", "-".repeat(64));
    for (name, ok, toks, calls) in &results {
        println!("{:<18} {:>6}/{:<4} {:>16} {:>14}", name, ok, n_questions, toks, calls);
    }

    let yok = &results[0];
    let harita = &results[1];
    let tam = &results[2];
    println!("\n=== Yorum ===");
    println!(
        "  YOK taban: {}/{}\n  HARITA: {}/{} (tabandan fark {})\n  TAM: {}/{} (ust sinir referansi)\n  HARITA token: {} vs TAM token: {} (oran {:.2}x)",
        yok.1, n_questions,
        harita.1, n_questions, (harita.1 as i32 - yok.1 as i32),
        tam.1, n_questions,
        harita.2, tam.2,
        if tam.2 > 0 { harita.2 as f64 / tam.2 as f64 } else { 0.0 }
    );
    println!("\nDikkat: bu test modelin haritayi kullanabilme YETENEGINI olcer;\n  kayipsizlik ayrica dogrulandi (round-trip testleri).");
}

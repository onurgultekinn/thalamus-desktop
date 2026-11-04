// SUNUM TESTİ (v2) — önceki testin metodoloji hatasını düzelten sürüm.
//
//   ollama serve                       (veya OLLAMA_CONTEXT_LENGTH=32768 ollama serve)
//   cargo run --example presentation_test --release
//
// ## Neden yeniden yazıldı
//
// Eski `readable_test` üç şeyi karıştırıyordu (bkz. docs/context-window.md):
//
// 1. **İğne kullanıcı mesajındaydı.** Sıkıştırma hiçbir kullanıcı mesajına
//    dokunmaz. Yani A 0/20 → C 20/20 sonucu "özet araç çıktısını korudu"
//    demek DEĞİLDİ — "kısa bağlamda arama kolaydır" demekti.
// 2. **Uzunluk ile biçim karıştı.** B 27.420, C 6.640 token: B zaten 4×
//    büyüktü. 0/20'lik fark biçime mi uzunluğa mı ait, ayrıştırılamıyordu.
// 3. **Tek iğne biçimi.** @T'nin model tarafından okunamadığı iddiası
//    yalnız B koşusunun sonucuna dayanıyordu.
//
// ## Bu test ne yapıyor
//
// - İğne (auth anahtarı) **araç çıktısının içinde**, tek satırda duruyor.
//   40 turun yalnız BİRİNDE. Kullanıcı/asistan metinlerinde geçmiyor.
// - Aynı bilgi dört sunumla veriliyor:
//     A  HAM JSON        — araç çıktısı olduğu gibi
//     B  @T SIKIŞTIRMA   — üretimdeki JsonCompressor
//     C  OKUNABİLİR      — ÜRETİMDEKİ ContextEngine::render_readable
//     D  B = C UZUNLUK   — @T tarihinin C ile AYNI token bütçesine kırpılmış
//                          hâli (uzunluk sabit, biçim @T). Biçim/uzunluk
//                          ayrımı buradan okunur.
// - Her koşuda AYNI 12 tur sorgulanır; soru tur numarasını içerir (somut
//   tutamak — belgede "otomatik seçim çözülmedi" diye yazılı sınır).
// - Pencere yeterli: model num_ctx'i doğrulanır, yetmezse test DURUR
//   (sessiz kırpma ile yanlış sonuç üretmez).
//
// Çıktı: her koşu için doğru/yanlış + gönderilen prompt token'ı.

use app_lib::engine::context_engine::ContextEngine;
use app_lib::engine::jscompress::JsonCompressor;
use serde_json::{json, Value};
use tiktoken_rs::CoreBPE;

/// Taban adres `OLLAMA_BASE` ile değiştirilebilir: pencere ayarı farklı bir
/// örnekte test ediliyorsa (ör. `OLLAMA_CONTEXT_LENGTH=32768` ile 11435).
fn base() -> String {
    std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
}
const MODEL: &str = "qwen2.5-coder:7b";
const TURNS: usize = 40;
const PROBES: usize = 12;
/// Sunucunun gerçekten yüklediği pencere; altındaysa test anlamsız.
const NUM_CTX: u32 = 32_768;

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
}

struct Turn {
    /// Gizli anahtar — YALNIZ araç çıktısında, tek satırın `note` alanında.
    key: String,
    tool_rows: Value,
    user: String,
    assistant: String,
}

fn make_turn(rng: &mut Lcg, t: usize) -> Turn {
    let key = format!("KEY-{:04}-{:04}", t, 1000 + rng.below(9000));
    let rows: Vec<Value> = (0..30)
        .map(|r| {
            let n = t * 100 + r;
            let st = ["ok", "warn", "error"][n % 3];
            let file = format!("src/m{:02}.rs", n % 7);
            json!({
                "id": n,
                "file": file,
                "line": 100 + r * 5,
                "status": st,
                "ms": 5 + (n % 80),
                // İğne: yalnız 17. satırda. Diğer satırlar boş string.
                "note": if r == 17 { key.clone() } else { String::new() },
            })
        })
        .collect();
    Turn {
        key: key.clone(),
        tool_rows: Value::Array(rows),
        // Kullanıcı/asistan metni anahtarı İÇERMEZ (eski testin hatası).
        user: format!("Turn {t}: scan the module headers and summarise the results."),
        assistant: format!("Turn {t}: scanned 30 records; reported the status distribution."),
    }
}

fn count(bpe: &CoreBPE, s: &str) -> usize {
    bpe.encode_ordinary(s).len()
}

/// Bir sunum üretir: history metni.
///
/// `protected`: bu tur indeksleri kırpılmaz (sorgulanacak turlar korunur).
fn build_history(
    turns: &[Turn],
    bpe: &CoreBPE,
    fmt: &str,
    token_limit: Option<usize>,
    protected: &[usize],
) -> String {
    let mut lines: Vec<(usize, String)> = Vec::new();
    for (t, d) in turns.iter().enumerate() {
        let tool = match fmt {
            "raw" => serde_json::to_string(&d.tool_rows).unwrap_or_default(),
            "at" => {
                let raw = serde_json::to_string(&d.tool_rows).unwrap_or_default();
                JsonCompressor::compress(&raw, false).unwrap_or(raw)
            }
            "readable" => ContextEngine::render_readable(&d.tool_rows),
            _ => unreachable!(),
        };
        lines.push((
            t,
            format!(
                "Turn {t}: User asked \"{}\".\nTurn {t}: Tool result: {}\nTurn {t}: Assistant: {}",
                d.user, tool, d.assistant
            ),
        ));
    }
    let render = |ls: &[(usize, String)]| {
        ls.iter()
            .map(|(_, b)| b.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut out = render(&lines);
    // Uzunluk kırpma: KORUNAN turlara dokunma; en eski korumasız turu at.
    // (Önceki sürüm en eski turu koşulsuz atıyordu — sorgulanan tur tam da o
    //  olabiliyordu. D koşusunda 1/11'in nedeni buydu, biçim değil.)
    if let Some(limit) = token_limit {
        while count(bpe, &out) > limit {
            let Some(idx) = lines.iter().position(|(t, _)| !protected.contains(t)) else {
                break;
            };
            lines.remove(idx);
            out = render(&lines);
        }
    }
    out
}

fn chat(bpe: &CoreBPE, history: &str, question: &str) -> (String, usize, usize) {
    let system = "You answer questions about a conversation log. Use only the log. \
                  Separate fields are written as field=value. Reply with only the asked value.";
    let user = format!("--- LOG ---\n{history}\n--- END LOG ---\n\n{question}");
    let body = json!({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": true,
        "max_tokens": 48,
        "temperature": 0,
        "options": {"num_ctx": NUM_CTX},
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .expect("client");
    // Akış: OpenAI-uyumlu uç nokta `options` alanını yok sayar; native
    // /api/chat num_ctx'i uygular. Native kullanıyoruz ki pencere DARALTILMASIN.
    let resp = client
        .post(format!("{}/api/chat", base()))
        .json(&body)
        .send()
        .expect("ollama");
    let text = resp.text().expect("text");
    let mut answer = String::new();
    let mut prompt_tokens = 0usize;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(c) = v["message"]["content"].as_str() {
            answer.push_str(c);
        }
        if let Some(n) = v["prompt_eval_count"].as_u64() {
            prompt_tokens = n as usize;
        }
    }
    (answer, prompt_tokens, count(bpe, &user))
}

fn main() {
    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");
    let mut rng = Lcg::new(2027);
    let turns: Vec<Turn> = (0..TURNS).map(|t| make_turn(&mut rng, t)).collect();

    // ── Sunucunun gerçekten yüklediği pencereyi doğrula ──────────────────
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("client");
    let ps: Value = client
        .get(format!("{}/api/ps", base()))
        .send()
        .and_then(|r| r.json())
        .expect("ollama /api/ps — servis açık mı?");
    let loaded = ps["models"]
        .as_array()
        .and_then(|ms| ms.first())
        .and_then(|m| m["context_length"].as_u64());
    println!("=== ön koşul ===");
    println!("  model: {MODEL}  /api/ps context_length: {:?}", loaded);
    match loaded {
        Some(n) if n >= NUM_CTX as u64 => {}
        Some(n) => {
            println!(
                "  DURDURULDU: yüklü pencere {n} < {NUM_CTX}. Ollama modeli varsayılan\n  \
                 (4096) yüklemiş; bu pencerede uzun bağlam testi sessizce kırpılır.\n  \
                 Düzeltme: `OLLAMA_CONTEXT_LENGTH={NUM_CTX} ollama serve`"
            );
            return;
        }
        None => {
            println!("  DURDURULDU: model yüklü değil — önce bir istek at (ollama run {MODEL}).");
            return;
        }
    }

    // ── Sondalar ÖNCE: kırpma bu turları koruyacak ──────────────────────
    let probes: Vec<usize> = (3..=34).step_by(3).take(PROBES).collect();

    // ── Sunum boyutları ─────────────────────────────────────────────────
    let hist_a = build_history(&turns, &bpe, "raw", None, &probes);
    let hist_b = build_history(&turns, &bpe, "at", None, &probes);
    let hist_c = build_history(&turns, &bpe, "readable", None, &probes);
    let tok_c = count(&bpe, &hist_c);
    // D: @T, ama C ile AYNI token bütçesinde (uzunluk sabit, biçim @T).
    let hist_d = build_history(&turns, &bpe, "at", Some(tok_c), &probes);

    println!("\n=== sunum boyutları (token) ===");
    for (name, h) in [
        ("A HAM", &hist_a),
        ("B @T", &hist_b),
        ("C OKUNABİLİR", &hist_c),
        ("D @T=kırpılmış", &hist_d),
    ] {
        println!("  {:<14} {:>7} token", name, count(&bpe, h));
    }
    println!("  pencere        {:>7} token (num_ctx)", NUM_CTX);

    println!("\n=== eski turdaki anahtarı hatırlama (iğne ARAÇ ÇIKTISINDA) ===\n");
    println!(
        "{:<16} {:>7} {:>9} {:>7}",
        "sunum", "dogru", "prompt_tok", "sigar"
    );
    println!("{}", "-".repeat(46));

    let mut results: Vec<(&str, usize, usize, bool)> = Vec::new();
    for (name, h) in [
        ("A HAM", &hist_a),
        ("B @T", &hist_b),
        ("C OKUNABİLİR", &hist_c),
        ("D @T=kırpılmış", &hist_d),
    ] {
        let mut ok = 0usize;
        let mut max_prompt = 0usize;
        for &t in &probes {
            let q = format!(
                "In turn {t}, the tool output had one record whose \"note\" field was \
                 non-empty and started with KEY-. What was that value? Reply with only it."
            );
            let (ans, prompt_tokens, _) = chat(&bpe, h, &q);
            max_prompt = max_prompt.max(prompt_tokens);
            if ans.contains(&turns[t].key) {
                ok += 1;
            }
        }
        let fits = max_prompt < NUM_CTX as usize;
        println!(
            "{:<16} {:>4}/{:<4} {:>9} {:>7}",
            name,
            ok,
            probes.len(),
            max_prompt,
            if fits { "EVET" } else { "HAYIR" }
        );
        results.push((name, ok, probes.len(), fits));
    }

    // ── Yorum: ne kanıtlandı, ne kanıtlanmadı ───────────────────────────
    println!("\n=== yorum ===");
    let get = |n: &str| results.iter().find(|(x, ..)| *x == n).copied();
    let (_, a_ok, total, _) = get("A HAM").unwrap();
    let (_, b_ok, _, _) = get("B @T").unwrap();
    let (_, c_ok, _, _) = get("C OKUNABİLİR").unwrap();
    let (_, d_ok, _, _) = get("D @T=kırpılmış").unwrap();
    println!("  uzunluk sabitken @T vs okunabilir: D {d_ok}/{total} vs C {c_ok}/{total}");
    if d_ok < c_ok {
        println!("  → fark BİÇİME atfedilebilir (uzunluk eşit).");
    } else if d_ok == c_ok {
        println!("  → @T ile okunabilir eşit: biçim farkı yok, uzunluk belirleyiciydi.");
    } else {
        println!("  → @T daha iyi: bu veri biçiminde sıkıştırma kayıp vermiyor.");
    }
    println!("  ham JSON (A) {a_ok}/{total}, @T tam boy (B) {b_ok}/{total}");
    if a_ok < b_ok {
        println!("  → sıkıştırma yardımcı (aynı bilgi, daha az token).");
    }
    println!("\n  Kanıtlanmayan: otomatik seçim. Burada her soru tur numarası");
    println!("  içeriyor; 'önceki konuştuğumuz şey' gibi tutamaksız sorular");
    println!("  hâlâ çözülmüş değil (deterministic_test: 0/20).");
}

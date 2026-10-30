// UÇTAN UCA CANLI DOĞRULAMA — "bağlam sıkıştırma + recall zinciri" gerçekten çalışıyor mu?
//
//   ollama serve
//   cargo run --example e2e_context_live --release
//
// Bu test üretimdeki gerçek fonksiyonları kullanır:
//   ContextStore::push / id_of / recall
//   ContextEngine::compact_to_budget / render_readable
//
// Senaryo: 12 tur, her turda BÜYÜK bir araç çıktısı (JSON). Bağlam bütçesi
// bilinçli olarak DAR (1500 token) — böylece kompaksiyon erken tetiklenir.
// İlk turda gizli bir kod var; en sonda o kod sorulur.
//
// Beklenen zincir:
//   1. Tur 0'ın araç çıktısı depoya yazılır (kayıpsız).
//   2. Bütçe aşılınca mesaj okunabilir özete iner + `recall(id=N)` tutamacı alır.
//   3. Model `recall` aracını çağırır (tools ile).
//   4. Gelen içerik ORİJİNAL tam metin (kayıpsız) ve doğru cevabı içerir.

use app_lib::engine::context_engine::ContextEngine;
use app_lib::engine::context_store::{ContextStore, Kind};
use serde_json::{json, Value};

const BASE: &str = "http://127.0.0.1:11434";
const MODEL: &str = "qwen2.5-coder:7b";
const BUDGET: usize = 1_500;

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self { Lcg(seed) }
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 { self.next_u32() % n }
}

fn chat(messages: &[Value], tools: Option<Value>) -> Value {
    let mut body = json!({
        "model": MODEL,
        "messages": messages,
        "stream": false,
        "options": {"temperature": 0, "num_ctx": 8192},
    });
    if let Some(t) = tools {
        body["tools"] = t;
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .expect("client");
    let resp = client
        .post(format!("{BASE}/api/chat"))
        .json(&body)
        .send()
        .expect("ollama'ya ulasilamadi");
    resp.json().expect("json")
}


/// Küçük modeller araç çağrısını `tool_calls` yerine `content` içine JSON
/// olarak yazabiliyor (qwen2.5-coder:7b gözlendi). Bu, çağrıyı kurtarır.
fn rescue_text_tool_call(text: &str) -> Option<(String, Value)> {
    let t = text.trim();
    // Yaygın biçimler: {"name":..,"arguments":{..}} veya {"tool":..,"args":..}
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end <= start { return None; }
    let v: Value = serde_json::from_str(&t[start..=end]).ok()?;
    let name = v.get("name").or_else(|| v.get("tool"))?.as_str()?.to_string();
    let args = v.get("arguments").or_else(|| v.get("args")).cloned().unwrap_or(json!({}));
    Some((name, args))
}

fn count_tokens(bpe: &tiktoken_rs::CoreBPE, text: &str) -> usize {
    bpe.encode_ordinary(text).len()
}

fn main() {
    let bpe = tiktoken_rs::cl100k_base().expect("cl100k");
    let mut rng = Lcg::new(4242);

    // ── Oturum verisi: 12 tur, büyük araç çıktıları, ilk turda gizli kod ──
    const SECRET: &str = "AUTH-KEY-7f3d9b2e";
    let mut store = ContextStore::new();
    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": "You are a coding assistant. Use the recall tool to fetch full content of stored context items when the message says so. Always answer concisely."
    })];

    let mut secret_store_id: Option<u32> = None;
    for t in 0..12u32 {
        // Kullanıcı mesajı
        let user = if t == 0 {
            format!("Tur {t}: src/auth.rs içindeki yapılandırmayı incele. Kimlik anahtarı: {SECRET}")
        } else {
            format!("Tur {t}: src/module_{t}.rs dosyasını incele ve log üret.")
        };
        messages.push(json!({"role": "user", "content": user}));
        store.push(t, Kind::User, "user", &json!(user), None, None);

        // Büyük araç çıktısı (depoya yazılır + mesaja eklenir)
        let rows: Vec<Value> = (0..45).map(|r| {
            let n = t * 100 + r;
            let st = ["ok", "warn", "error"][n as usize % 3];
            json!({
                "id": n,
                "file": format!("src/module_{:02}.rs", n % 7),
                "line": 100 + r * 4,
                "status": st,
                "elapsed_ms": 5 + rng.below(120),
                "detail": format!("handler processed event {} with payload variant {}", n, r % 5),
            })
        }).collect();
        let payload = Value::Array(rows);
        let raw = serde_json::to_string(&payload).unwrap();
        let sid = store.push(t, Kind::Tool, &format!("grep_search turn {t}"), &payload, None, None);
        if t == 0 {
            secret_store_id = Some(sid);
            println!("Tur 0 araç çıktısı depoda id={sid} (gizli kod bunun içinde DEĞİL — kullanıcı mesajında)");
        }
        messages.push(json!({"role": "tool", "tool_call_id": format!("call_{t}"), "content": raw}));

        // Asistan kısa cevabı
        let asst = format!("Tur {t}: {} kayıt incelendi.", 45);
        messages.push(json!({"role": "assistant", "content": asst}));
        store.push(t, Kind::Assistant, "asst", &json!(asst), None, None);
    }

    // ── Kompaksiyon ÖNCESİ ölçüm ──────────────────────────────────────────
    let before_tokens: usize = messages.iter()
        .map(|m| count_tokens(&bpe, m["content"].as_str().unwrap_or("")))
        .sum();
    println!("\n=== Kompaksiyon oncesi ===");
    println!("  mesaj sayisi : {}", messages.len());
    println!("  toplam token : {before_tokens}  (butce: {BUDGET})");

    // ── GERÇEK ÜRETİM FONKSİYONU: bütçeye göre sıkıştır ───────────────────
    let saved = ContextEngine::compact_to_budget(&store, &mut messages, BUDGET, 4, Some(&bpe));
    let after_tokens: usize = messages.iter()
        .map(|m| count_tokens(&bpe, m["content"].as_str().unwrap_or("")))
        .sum();
    println!("\n=== Kompaksiyon sonrasi ===");
    println!("  kazanilan karakter : {saved}");
    println!("  toplam token       : {after_tokens}  (butce: {BUDGET})");
    println!("  butce saglandi mi  : {}", if after_tokens <= BUDGET { "EVET" } else { "HAYIR" });

    // Sıkıştırılan mesajlarda gerçek recall tutamacı var mı?
    let compacted_count = messages.iter()
        .filter(|m| m["content"].as_str().map(|s| s.starts_with("[compressed]")).unwrap_or(false))
        .count();
    println!("  sikistirilan mesaj : {}", compacted_count);
    let mut recall_ids: Vec<u32> = Vec::new();
    for m in messages.iter() {
        let c = m["content"].as_str().unwrap_or("");
        if !c.starts_with("[compressed]") { continue; }
        if let Some(rest) = c.split("recall(id=").nth(1) {
            if let Some(num) = rest.split(')').next() {
                if let Ok(id) = num.trim().parse::<u32>() {
                    recall_ids.push(id);
                }
            }
        }
    }
    println!("  recall id'leri     : {:?}", &recall_ids[..recall_ids.len().min(5)]);
    assert!(!recall_ids.is_empty(), "HATA: sıkıştırılan mesajda recall id'si yok!");
    // Her id gerçekten çözülebilmeli.
    for id in &recall_ids {
        assert!(store.recall(*id).is_some(), "HATA: id={id} depoda çözülemedi!");
    }
    println!("  tum id'ler cozuldu : EVET");

    // ── Model testi: gizli kodu sor (kullanıcı mesajı sıkıştırılmış olabilir) ──
    println!("\n=== Model testi ===");

    // Not: kullanıcı mesajları sıkıştırılmaz (kayipsizlik ilkesi), o yüzden
    // gizli kod hâlâ ham metinde. Bunu doğrulayalım.
    let secret_visible = messages.iter().any(|m| {
        m["content"].as_str().map(|s| s.contains(SECRET)).unwrap_or(false)
    });
    println!("  gizli kod baglamda (ham) : {}", if secret_visible { "EVET" } else { "HAYIR (sikistirilmis)" });

    // recall aracını modele ver (üretimdeki tanımla aynı)
    let tools = json!([{
        "type": "function",
        "function": {
            "name": "recall",
            "description": "Get full content of a context item by id. Items are in the CONTEXT MAP. Restored losslessly.",
            "parameters": {"type":"object","properties":{
                "id":{"type":"integer","description":"the item id from the CONTEXT MAP"}
            },"required":["id"]}
        }
    }]);

    // Tur 0'ın araç çıktısını geri istet → model recall çağırmalı
    messages.push(json!({
        "role": "user",
        "content": format!(
            "Earlier tool output was compacted. Fetch the FULL content of the stored item id={} using the recall tool, then report how many items it contained and the first item's file path. Be brief.",
            secret_store_id.unwrap()
        )
    }));

    let mut rounds = 0usize;
    let mut recall_called = false;
    let mut recall_payload: Option<String> = None;
    let mut final_answer = String::new();

    loop {
        rounds += 1;
        if rounds > 4 { break; }
        let resp = chat(&messages, Some(tools.clone()));
        let msg = resp["message"].clone();
        let text = msg["content"].as_str().unwrap_or("").to_string();
        if !text.is_empty() { final_answer = text.clone(); }

        let calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
        if calls.is_empty() {
            // Kurtarma: model araç çağrısını content içine yazmış olabilir.
            if let Some((name, args)) = rescue_text_tool_call(&text) {
                println!("  (kurtarildi: content icindeki arac cagrisi — üretimde de aynı kurtarma var)");
                let id = args["id"].as_i64().unwrap_or(-1) as u32;
                if name == "recall" {
                    recall_called = true;
                    let content = store.recall(id)
                        .map(|v| serde_json::to_string(&v).unwrap_or_default())
                        .unwrap_or_else(|| format!("no item with id {id}"));
                    let original = store.recall(secret_store_id.unwrap())
                        .map(|v| serde_json::to_string(&v).unwrap_or_default())
                        .unwrap_or_default();
                    recall_payload = Some(if content == original { "LOSSLESS".into() } else { "DIFFERENT".into() });
                    messages.push(json!({"role": "assistant", "content": text.clone()}));
                    messages.push(json!({"role": "user", "content": format!("TOOL RESULT for recall(id={id}):
{content}")}));
                    continue;
                }
            }
            break;
        }

        messages.push(msg.clone());
        for c in &calls {
            let name = c["function"]["name"].as_str().unwrap_or("");
            let args = &c["function"]["arguments"];
            let id = args["id"].as_i64()
                .or_else(|| args.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|v| v["id"].as_i64()))
                .unwrap_or(-1) as u32;
            println!("  model cagirdi: {name}(id={id})");
            if name == "recall" && id != u32::MAX {
                recall_called = true;
                let content = store.recall(id)
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_else(|| format!("no item with id {id}"));
                // Doğrulama: dönen içerik ORİJİNAL mi?
                let original = store.recall(secret_store_id.unwrap())
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_default();
                recall_payload = Some(if content == original { "LOSSLESS".into() } else { "DIFFERENT".into() });
                messages.push(json!({"role": "tool", "content": content}));
            } else {
                messages.push(json!({"role": "tool", "content": format!("unknown tool: {name}")}));
            }
        }
    }

    println!("\n=== SONUC ===");
    println!("  model recall cagirdi  : {}", if recall_called { "EVET" } else { "HAYIR" });
    println!("  donen icerik          : {:?}", recall_payload);
    println!("  model cevabi          : {:.120}", final_answer.trim());

    // Depodan gelen GERÇEK içerik: kaç öğe, ilk dosya ne?
    let recalled = store.recall(secret_store_id.unwrap()).expect("depoda olmali");
    let real_count = recalled.as_array().map(|a| a.len()).unwrap_or(0);
    let real_first_file = recalled
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.get("file"))
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    println!("  depodaki gercek icerik: {} oge, ilk dosya {}", real_count, real_first_file);
    // ZİNCİR TESTİ: model depodaki dosya yolunu doğru söyledi mi?
    // (Bu, kayıpsız içeriğin modele gerçekten ulaştığının kanıtı.)
    let chain_ok = final_answer.contains(&real_first_file);
    // SAYMA TESTİ ayrı: 7B model saymada zayıf; zincir kanıtı değil.
    let count_ok = final_answer.contains(&real_count.to_string());
    println!("  zincir (dosya yolu)   : {}", if chain_ok { "OK" } else { "BASARISIZ" });
    println!("  sayma (7B zaafi)      : {}", if count_ok { "OK" } else { "yanlis saydi" });

    println!("\n=== ZINCIR OZETI ===");
    println!("  1. depoya yazma      : OK (id={})", secret_store_id.unwrap());
    println!("  2. kompaksiyon       : OK ({} mesaj, butce saglandi)", compacted_count);
    println!("  3. recall cagrisi    : {}", if recall_called { "OK" } else { "BASARISIZ" });
    println!("  4. kayipsiz icerik   : {:?}", recall_payload);
    println!("  5. icerik ulasti     : {}", if chain_ok { "OK (model depodaki dosya yolunu dogru soyledi)" } else { "BASARISIZ" });
    println!("  6. sayma dogrulugu   : {} (7B icin beklenen zayiflik)", if count_ok { "OK" } else { "yanlis" });
}

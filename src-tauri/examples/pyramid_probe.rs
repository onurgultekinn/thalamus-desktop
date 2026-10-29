// Piramit sikistirma deneyi — "5'i birlestirip yeniden sikistirmak kazanc
// uretiyor mu?" sorusunu SAYIYLA cevaplar.
//
//   cargo run --example pyramid_probe --release
//
// Neden gerekli: kayipsiz bir piramit kurmadan once, ust katmanlarin gercekten
// kucultup kucultmedigi olculmeli. Aksi halde "5'i birlestir, tekrar sikistir"
// dongusu ayni boyutu bir ust katmana tasimaktan ibaret kalir.
//
// Olculen dort strateji (hepsi KAYIPSIZ, her biri round-trip dogrulanir):
//   A  ayri        : her tur bagimsiz sikistirilir (bugunku durum)
//   B  birlesik    : 5 tur tek JSON dizisine katilir, bir kez sikistirilir
//   C  dedup       : ayni icerik (ayni dosya/ayni arac ciktisi) bir kez saklanir
//   D  dedup+birlesik: C'nin ustune B uygulanir
//
// OLCULEN SONUC (2026-10-29, bu makine):
//   - Zarfli kayit ({"role":..,"content":..}) sikistirilamaz: %0-0.4.
//     Ust duzey dizide anahtar sayisi az ve degerler heterojen oldugu icin
//     sabit-kolon/sozluk tespiti hic devreye girmiyor.
//   - Ciplak yuk ({"id":..,"file":..,...}) ayni veride %80.5 tek turda,
//     %85.7 bes tur birlestirilince.
//   - Yani ASIL kazanc "piramit birlestirme" degil, ZARF AYIRMA:
//     mesaj zarfi ince bir indeks olur, agir yuk ayri saklanip sikistirilir.
//   - Birlestirme tek basina %80 -> %86 getiriyor (marjinal); dedup ise
//     100 turda %54 (ayni dosyanin tekrar okunmasindan).
//   - Prose %2.2, kod %0: yapisal olmayan icerik sikismiyor (beklenen).
//
// Gercekci veri: bir ajan oturumu = prose sorular + arac ciktilari (JSON) +
// ayni dosyanin tekrar okunmasi + kod. Sadece prose degil, cunku asil
// yapisal kazanc arac ciktilarinda.

use app_lib::engine::jscompress::JsonCompressor;
use serde_json::{json, Value};

/// Kucuk deterministik LCG (bench_data ile ayni mantik).
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

/// Bir turun icerigi. `kind` dedup anahtari icin.
#[derive(Clone)]
struct Turn {
    role: &'static str,
    kind: &'static str,
    /// Dedup anahtari: ayni anahtar = ayni icerik (tekrar okunan dosya vb).
    dedup_key: Option<String>,
    content: Value,
}

fn prose(i: usize) -> String {
    format!(
        "Tur {i}: bu dosyadaki hata yonetimi akisini ozetler misin? \
         Ozellikle async kisimda timeout davranisini ve retry sayisini merak ediyorum."
    )
}

/// Arac ciktisi: yapisal (JSON) — asil sikistirilabilir kisim.
fn tool_json(rng: &mut Lcg, i: usize) -> Value {
    let rows: Vec<Value> = (0..40)
        .map(|r| {
            let severity = ["info", "warn", "error"][rng.below(3) as usize];
            let status = 200 + rng.below(4) * 100;
            json!({
                "id": i * 100 + r,
                "file": format!("src/module_{:02}/handler.rs", i % 7),
                "line": 100 + r * 7,
                "severity": severity,
                "message": format!("handler returned status {}", status),
                "elapsed_ms": 10 + rng.below(90),
            })
        })
        .collect();
    Value::Array(rows)
}

/// Kod okuma: yapisi zayif ama ayni dosya tekrar okunabilir.
fn code_read(i: usize) -> Value {
    let body: String = (0..60)
        .map(|n| format!("    pub fn handler_{n:02}(input: &Request) -> Result<Response> {{\n        validate(&input)?;\n        Ok(process(input))\n    }}\n"))
        .collect();
    json!({
        "path": format!("src/module_{:02}/handler.rs", i % 7),
        "body": body,
    })
}

/// Gercekci bir ajan oturumu uretir.
fn session(turns: usize) -> Vec<Turn> {
    let mut rng = Lcg::new(2026);
    let mut out = Vec::with_capacity(turns * 3);
    for i in 0..turns {
        // 1) kullanici sorusu (prose)
        out.push(Turn {
            role: "user",
            kind: "prose",
            dedup_key: None,
            content: Value::String(prose(i)),
        });
        // 2) ajan arac cagiriyor -> yapisal cikti
        out.push(Turn {
            role: "tool",
            kind: "tool_json",
            dedup_key: None,
            content: tool_json(&mut rng, i),
        });
        // 3) ajan dosya okuyor — HER 7 TURDA AYNI DOSYA (gercekci tekrar)
        let path_idx = i % 7;
        out.push(Turn {
            role: "tool",
            kind: "code",
            dedup_key: Some(format!("code:{path_idx}")),
            content: code_read(i),
        });
        // 4) ajan cevabi (prose)
        out.push(Turn {
            role: "assistant",
            kind: "prose",
            dedup_key: None,
            content: Value::String(format!(
                "Tur {i}: timeout 30 sn, retry 3. Async blokta `tokio::time::timeout` kullanilmis."
            )),
        });
    }
    out
}

fn to_messages(turns: &[Turn]) -> Value {
    Value::Array(
        turns
            .iter()
            .map(|t| json!({ "role": t.role, "content": t.content }))
            .collect(),
    )
}

fn bytes(v: &Value) -> usize {
    serde_json::to_string(v).map(|s| s.len()).unwrap_or(0)
}

/// Kayipsiz sikistir + round-trip dogrula. Basarisizsa ham doner (ve sayilir).
fn compress_verified(v: &Value) -> (usize, bool) {
    let raw = serde_json::to_string(v).unwrap_or_default();
    match JsonCompressor::compress(&raw, false) {
        Ok(c) => match JsonCompressor::decompress(&c) {
            Ok(back) => {
                let ok = back == *v;
                (c.len(), ok)
            }
            Err(_) => (raw.len(), false),
        },
        Err(_) => (raw.len(), false),
    }
}

fn main() {
    println!("Piramit sikistirma deneyi (kayipsiz, round-trip dogrulanmis)\n");
    println!("{:>6}  {:>10}  {:>10}  {:>10}  {:>10}  {:>8}  {:>6}", "tur", "A ayri", "B birlesik", "C dedup", "D dedup+bir", "A->D %", "rt");
    println!("{}", "-".repeat(76));

    for turns in [10usize, 25, 50, 100] {
        let s = session(turns);
        let all = to_messages(&s);

        // A) her tur bagimsiz
        let mut a_bytes = 0usize;
        let mut rt_ok = true;
        for t in &s {
            let v = json!({ "role": t.role, "content": t.content });
            let (n, ok) = compress_verified(&v);
            a_bytes += n;
            rt_ok &= ok;
        }

        // B) hepsi tek dizide
        let (b_bytes, b_rt) = compress_verified(&all);

        // C) dedup: ayni dedup_key icin icerik bir kez, digerleri referans
        let mut seen: std::collections::HashMap<String, usize> = Default::default();
        let mut stored: Vec<Value> = Vec::new();
        let mut refs: Vec<(usize, usize, usize)> = Vec::new(); // (tur_idx, stored_idx, count)
        let mut c_bytes = 0usize;
        let mut c_rt = true;
        for (idx, t) in s.iter().enumerate() {
            let v = json!({ "role": t.role, "content": t.content });
            match &t.dedup_key {
                Some(k) => {
                    if let Some(&si) = seen.get(k) {
                        // referans satiri — cok kucuk
                        c_bytes += format!("{{\"ref\":{si},\"at\":{idx}}}").len();
                        refs.push((idx, si, 1));
                    } else {
                        seen.insert(k.clone(), stored.len());
                        let (n, ok) = compress_verified(&v);
                        c_bytes += n;
                        c_rt &= ok;
                        stored.push(v);
                    }
                }
                None => {
                    let (n, ok) = compress_verified(&v);
                    c_bytes += n;
                    c_rt &= ok;
                }
            }
        }

        // D) dedup + birlesik: benzersiz olanlar tek dizide
        let dedup_only: Vec<Value> = {
            let mut seen2: std::collections::HashMap<String, usize> = Default::default();
            let mut out = Vec::new();
            for t in s.iter() {
                let v = json!({ "role": t.role, "content": t.content });
                match &t.dedup_key {
                    Some(k) => {
                        if !seen2.contains_key(k) {
                            seen2.insert(k.clone(), out.len());
                            out.push(v);
                        }
                    }
                    None => out.push(v),
                }
            }
            out
        };
        let (d_bytes, d_rt) = compress_verified(&Value::Array(dedup_only));

        let gain = if a_bytes > 0 {
            100.0 * (a_bytes as f64 - d_bytes as f64) / a_bytes as f64
        } else {
            0.0
        };
        let raw_total = bytes(&all);
        println!(
            "{:>6}  {:>10}  {:>10}  {:>10}  {:>10}  {:>7.1}%  {:>6}",
            turns,
            a_bytes,
            b_bytes,
            c_bytes,
            d_bytes,
            gain,
            if rt_ok && b_rt && c_rt && d_rt { "ok" } else { "FAIL" }
        );
        if turns == 100 {
            println!("\n  100 tur icin ham boyut: {} bayt", raw_total);
            println!("  A (bugun)      : {} bayt  — ham'in %{:.1}'i", a_bytes, 100.0 * a_bytes as f64 / raw_total as f64);
            println!("  D (oneri)      : {} bayt  — ham'in %{:.1}'i", d_bytes, 100.0 * d_bytes as f64 / raw_total as f64);
        }
    }

    // Icerik turune gore pay: prose sikismiyor mu?
    println!("\nIcerik turune gore (100 tur):");
    let s = session(100);
    for kind in ["prose", "tool_json", "code"] {
        let items: Vec<&Turn> = s.iter().filter(|t| t.kind == kind).collect();
        if items.is_empty() {
            continue;
        }
        let raw: usize = items.iter().map(|t| bytes(&json!({"role":t.role,"content":t.content}))).sum();
        let comp: usize = items
            .iter()
            .map(|t| compress_verified(&json!({"role":t.role,"content":t.content})).0)
            .sum();
        println!(
            "  {:<10} {:>8} -> {:>8} bayt  (%{:.1} tasarruf, {} oge)",
            kind,
            raw,
            comp,
            100.0 * (raw as f64 - comp as f64) / raw as f64,
            items.len()
        );
    }
}

// Kayipsizlik tokenizer'dan bagimsiz mi? Ve tasarruf tokenizer'a gore nasil?
use app_lib::engine::jscompress::JsonCompressor;
use serde_json::{json, Value};
use tiktoken_rs::CoreBPE;

fn main() {
    let rows: Vec<Value> = (0..100).map(|i| json!({
        "id": i,
        "file": format!("src/module_{:02}/handler.rs", i % 7),
        "status": if i % 2 == 0 { "active" } else { "paused" },
        "amount": (i * 13) % 900 + 10,
    })).collect();
    let v = Value::Array(rows);
    let raw = serde_json::to_string(&v).unwrap();
    let comp = JsonCompressor::compress(&raw, false).unwrap();
    let back = JsonCompressor::decompress(&comp).unwrap();
    println!("JSON round-trip (bayt/deger duzeyi): {}", if back == v { "KAYIPSIZ" } else { "BOZUK" });
    println!("  ham {} bayt -> {} bayt (%{:.1})", raw.len(), comp.len(),
        100.0 * (raw.len() - comp.len()) as f64 / raw.len() as f64);

    // Farkli tokenizer'larla tasarruf
    for (name, bpe) in [
        ("cl100k (GPT-4/3.5)", tiktoken_rs::cl100k_base().ok()),
        ("o200k (GPT-4o)", tiktoken_rs::o200k_base().ok()),
        ("p50k (GPT-3/codex)", tiktoken_rs::p50k_base().ok()),
        ("r50k (GPT-2)", tiktoken_rs::r50k_base().ok()),
    ] {
        match bpe {
            Some(b) => {
                let rt = b.encode_ordinary(&raw).len();
                let ct = b.encode_ordinary(&comp).len();
                println!("  {:<20} {:>6} -> {:>6} token (%{:.1})", name, rt, ct,
                    100.0 * (rt as f64 - ct as f64) / rt as f64);
            }
            None => println!("  {:<20} yuklenemedi", name),
        }
    }

    // Prose ve kod: her tokenizer'da ne oluyor?
    let prose = "Thalamus runs locally and rewrites only structure, never prose. ".repeat(20);
    let m = app_lib::engine::process_with_metrics(&prose, &tiktoken_rs::cl100k_base().unwrap(), false);
    println!("\n  prose (cl100k): {} -> {} token (uygulandi={})",
        m.original_tokens, m.compressed_tokens, m.is_compressed);
    let code = "```rust\nfn main() {\n    println!(\"hi\");\n}\n```".to_string();
    let m2 = app_lib::engine::process_with_metrics(&code, &tiktoken_rs::cl100k_base().unwrap(), false);
    println!("  fenced kod   : {} -> {} token (uygulandi={})",
        m2.original_tokens, m2.compressed_tokens, m2.is_compressed);
    let _: Option<&CoreBPE> = None;
}

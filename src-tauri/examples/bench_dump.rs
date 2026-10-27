// Kalite A/B harness'i icin veri dokumu.
//
//   cargo run --example bench_dump --release
//
// Cikti: `bench/out/cases.json`. Her kayit bir veri seti icin:
//   - `raw_prompt`: ham veri (modelin bugun gorecegi hali)
//   - `compressed_prompt`: motorun GERCEKTE urettigi sikistirilmis hal,
//     cozucu talimati dahil
//   - `questions`: tur (lookup | count | max | sum), soru metni ve veriden
//     HESAPLANMIS beklenen cevap
//
// Sorularin cevabi elle yazilmaz; bench_data.rs toplayicilari tarafindan
// hesaplanir. scripts/bench-quality.mjs bu dosyayi okur.

#[path = "shared/bench_data.rs"]
mod bench_data;

use app_lib::engine::process_with_metrics;
use bench_data::{datasets, repo_root};
use serde_json::json;
use std::fs;

fn main() {
    let bpe = tiktoken_rs::cl100k_base().expect("cl100k tokenizer");
    let mut cases = Vec::new();

    for ds in datasets() {
        if ds.questions.is_empty() {
            // Kontrol setleri (duz yazi/kod) soru tasimaz.
            continue;
        }
        let m = process_with_metrics(&ds.text, &bpe, false);
        let applied = m.processed_prompt != ds.text;
        // Motor passthrough yaptiysa sikistirilmis istem ham istemle aynidir;
        // A/B farki o zaman dogal olarak sifirdir ve bu durustce belirtilir.
        let compressed_prompt = if applied {
            m.processed_prompt.clone()
        } else {
            ds.text.clone()
        };
        cases.push(json!({
            "dataset": ds.name,
            "kind": ds.kind.label(),
            "applied": applied,
            "raw_tokens": m.original_tokens,
            "compressed_tokens": m.compressed_tokens,
            "raw_prompt": ds.text,
            "compressed_prompt": compressed_prompt,
            "questions": ds.questions.iter().map(|q| json!({
                "kind": q.kind,
                "text": q.text,
                "expected": q.expected,
            })).collect::<Vec<_>>(),
        }));
    }

    let payload = json!({
        "generator": "cargo run --example bench_dump --release",
        "note": "Synthetic data only. Expected answers are computed from the generated data.",
        "cases": cases,
    });

    let out_dir = repo_root().join("bench").join("out");
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("uyari: {} olusturulamadi: {e}", out_dir.display());
        std::process::exit(1);
    }
    let target = out_dir.join("cases.json");
    let text = serde_json::to_string_pretty(&payload).expect("serialize");
    match fs::write(&target, text) {
        Ok(()) => {
            let n: usize = payload["cases"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("Yazildi: {} ({} vaka)", target.display(), n);
        }
        Err(e) => {
            eprintln!("hata: {} yazilamadi: {e}", target.display());
            std::process::exit(1);
        }
    }
}

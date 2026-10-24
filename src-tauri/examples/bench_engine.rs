// Motor olcum araci (kayipsiz hattin hizi).
//
//   cargo run --release --manifest-path src-tauri/Cargo.toml --example bench_engine
//
// Karsilastirma icin is parcacigi sayisini gecici olarak ezebilirsin:
//   TLM_ENGINE_WORKERS=1  cargo run --release ... --example bench_engine
//
// Cikti her iki durumda da ayni olmalidir; yalnizca sure degisir.

use app_lib::engine::pipeline::process_with_metrics;
use std::time::Instant;

fn build_prompt(blocks: usize, rows: usize, nonce: usize) -> String {
    let mut prompt = String::new();
    prompt.push_str(&format!(
        "Asagidaki telemetri bloklarini birlestir ve ozetle. Istek: {}\n",
        nonce
    ));
    for b in 0..blocks {
        let items: Vec<String> = (0..rows)
            .map(|i| {
                format!(
                    r#"{{"id":{},"block":{},"type":"telemetry","status":"ok","service":"api","region":"eu-central-1"}}"#,
                    b * rows + i,
                    b
                )
            })
            .collect();
        prompt.push_str(&format!("Blok {}: [{}]\n", b, items.join(",")));
        prompt.push_str("Ara not: bloklar arasinda iliski kur.\n");
    }
    prompt
}

fn run(label: &str, blocks: usize, rows: usize, iterations: usize) {
    let bpe = tiktoken_rs::cl100k_base().unwrap();

    // Isinma: is parcacigi havuzu ve BPE kurulsun.
    let warm = build_prompt(blocks, rows, 0);
    let _ = process_with_metrics(&warm, &bpe, false);

    let start = Instant::now();
    let mut last = None;
    for i in 1..=iterations {
        // Her istekte benzersiz girdi: onbellek isabeti olmadan gercek senaryo.
        let prompt = build_prompt(blocks, rows, i);
        last = Some(process_with_metrics(&prompt, &bpe, false));
    }
    let elapsed = start.elapsed();
    let m = last.unwrap();

    println!(
        "{}: {:.2} ms/istek | {} -> {} token (%{:.1}) | compressed={} lossless_verified={}",
        label,
        elapsed.as_secs_f64() * 1000.0 / iterations as f64,
        m.original_tokens,
        m.compressed_tokens,
        m.savings_percentage,
        m.is_compressed,
        m.lossless_verified
    );
}

fn main() {
    let workers = std::env::var("TLM_ENGINE_WORKERS").unwrap_or_else(|_| "auto".into());
    let prompt = build_prompt(12, 220, 0);
    println!(
        "girdi: {} bayt | is parcacigi: {} | donanim: {:?}",
        prompt.len(),
        workers,
        app_lib::engine::hw::profile()
    );

    run("benzersiz girdi", 12, 220, 10);

    // Darbogaz analizi: tam prompt tokenize suresi (onbellek disi).
    let bpe = tiktoken_rs::cl100k_base().unwrap();
    let start = Instant::now();
    for _ in 0..10 {
        std::hint::black_box(bpe.encode_with_special_tokens(&prompt));
    }
    println!(
        "yalniz tokenize (seri): {:.2} ms",
        start.elapsed().as_secs_f64() * 1000.0 / 10.0
    );
}

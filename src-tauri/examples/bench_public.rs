// Herkese açık, tekrarlanabilir token ölçümü.
//
//   cargo run --example bench_public --release
//
// Veri tamamen sentetiktir ve tohumlu bir LCG ile üretilir — gerçek kişi ya da
// özel veri yoktur. Her veri seti için ham/sıkıştırılmış token sayısı, tasarruf
// yüzdesi ve round-trip sonucu yazdırılır. Çıktı ayrıca
// `bench/results/token-savings.md` dosyasına yazılır.
//
// Yeni bağımlılık yok: cl100k tokenizer `tiktoken-rs` üzerinden gelir.
// Hiçbir sayı elle yazılmaz; tümü bu kodun çalışmasıyla üretilir.

use app_lib::engine::ingest::try_ingest;
use app_lib::engine::jscompress::JsonCompressor;
use app_lib::engine::plain_table;
use app_lib::engine::process_with_metrics;
use std::fmt::Write as _;
use std::fs;


/// Küçük, deterministik LCG (Numerical Recipes sabitleri).
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
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[self.below(items.len() as u32) as usize]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Json,
    Jsonl,
    Csv,
    Logfmt,
    MdTable,
    Xml,
    Sql,
    Ini,
    Toml,
    Yaml,
    Prose,
    Code,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Json => "json",
            Kind::Jsonl => "jsonl",
            Kind::Csv => "csv",
            Kind::Logfmt => "logfmt",
            Kind::MdTable => "md-table",
            Kind::Xml => "xml",
            Kind::Sql => "sql",
            Kind::Ini => "ini",
            Kind::Toml => "toml",
            Kind::Yaml => "yaml",
            Kind::Prose => "prose",
            Kind::Code => "code",
        }
    }
    /// ingest katmanından geçen (kanonik JSON'a normalleşen) türler.
    fn structural(self) -> bool {
        matches!(self, Kind::Jsonl | Kind::Csv | Kind::Logfmt | Kind::MdTable)
    }
    fn plain(self) -> bool {
        matches!(self, Kind::Xml | Kind::Sql | Kind::Ini | Kind::Toml | Kind::Yaml)
    }
}

struct Dataset {
    name: &'static str,
    kind: Kind,
    text: String,
}

fn json_array() -> String {
    let mut rng = Lcg::new(42);
    let mut rows = Vec::with_capacity(200);
    for i in 0..200 {
        rows.push(format!(
            r#"{{"id":{i},"name":"item-{i:03}","status":"{}","amount":{}.50,"created_at":"2024-01-{:02}T10:00:00Z"}}"#,
            rng.pick(&["active", "trial", "paused"]),
            rng.below(900) + 10,
            rng.below(28) + 1
        ));
    }
    format!("[{}]", rows.join(","))
}

fn jsonl() -> String {
    let mut rng = Lcg::new(7);
    (0..500)
        .map(|i| {
            format!(
                r#"{{"ts":"2024-01-01T10:{:02}:{:02}Z","level":"{}","service":"{}","status":{},"path":"/v1/items/{}"}}"#,
                i % 60,
                rng.below(60),
                rng.pick(&["info", "info", "info", "warn", "error"]),
                rng.pick(&["api", "worker", "gateway"]),
                rng.pick(&["200", "200", "200", "404", "500"]),
                i
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv() -> String {
    let mut rng = Lcg::new(99);
    let mut s = String::from("id,customer,status,total,created_at\n");
    for i in 0..300 {
        let _ = writeln!(
            s,
            "{i},customer-{:03},{},{}.90,2024-02-{:02}",
            i,
            rng.pick(&["shipped", "pending", "cancelled", "pending"]),
            rng.below(500) + 10,
            rng.below(28) + 1
        );
    }
    s
}

fn logfmt() -> String {
    let mut rng = Lcg::new(1234);
    (0..300)
        .map(|i| {
            format!(
                "ts=2024-01-01T10:00:{:02}Z level={} service={} method={} path=\"/v1/items/{}\" status={}",
                i % 60,
                rng.pick(&["info", "info", "warn", "error"]),
                rng.pick(&["api", "worker", "gateway"]),
                rng.pick(&["GET", "POST", "GET"]),
                i,
                rng.pick(&["200", "200", "404", "500"])
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn md_table() -> String {
    let mut rng = Lcg::new(555);
    let mut s = String::from("| id | city | region | population |\n|---|---|---|---|\n");
    for i in 0..100 {
        let _ = writeln!(
            s,
            "| {} | city-{:03} | region-{} | {} |",
            i,
            i,
            rng.below(8),
            100_000 + i * 137
        );
    }
    s
}

fn xml() -> String {
    let mut rng = Lcg::new(2024);
    let mut s = String::from("<catalog>\n");
    for i in 0..150 {
        let _ = write!(
            s,
            "  <item id=\"{i}\" available=\"true\">\n    <title>Product {i:03}</title>\n    <price>{}.99</price>\n    <category>cat-{}</category>\n  </item>\n",
            rng.below(90) + 10,
            rng.below(6)
        );
    }
    s.push_str("</catalog>\n");
    s
}

fn sql() -> String {
    let mut rng = Lcg::new(31337);
    let mut s = String::from("INSERT INTO orders (id, customer, status, total) VALUES\n");
    for i in 0..200 {
        let sep = if i + 1 == 200 { ";" } else { "," };
        let _ = writeln!(
            s,
            "({i}, 'customer-{i:03}', '{}', {}.90){sep}",
            rng.pick(&["shipped", "pending", "cancelled"]),
            rng.below(500) + 10
        );
    }
    s
}

fn ini() -> String {
    (0..16)
        .map(|i| {
            format!("[profile_{i:02}]\nhost = db-{i:02}.internal\nport = 5432\nsslmode = require\n\n")
        })
        .collect()
}

fn toml() -> String {
    (0..16)
        .map(|i| {
            format!(
                "[[dependency.{i}]]\nname = \"crate-{i:02}\"\nversion = \"1.4\"\noptional = false\n\n"
            )
        })
        .collect()
}

fn yaml() -> String {
    let mut rng = Lcg::new(8080);
    let mut s = String::from("workers:\n");
    for i in 0..12 {
        let _ = write!(
            s,
            "  - id: {i}\n    name: worker-{i:03}\n    replicas: {}\n    active: {}\n",
            rng.below(4) + 1,
            if i % 2 == 0 { "true" } else { "false" }
        );
    }
    s
}

/// KONTROL: ~2000 karakter düz yazı. Beklenen tasarruf ≈ 0.
fn prose() -> String {
    let sentence = "Thalamus runs locally and rewrites only structure, never prose. \
                    Each candidate is decoded again and compared before it is used. ";
    sentence.repeat(20)
}

/// KONTROL: fenced kod bloğu. Beklenen: dokunulmaz.
fn code() -> String {
    "```python\ndef total(rows):\n    return sum(r['amount'] for r in rows)\n\nprint(total([{'amount': 3}, {'amount': 4}]))\n```".to_string()
}

fn datasets() -> Vec<Dataset> {
    vec![
        Dataset { name: "JSON records", kind: Kind::Json, text: json_array() },
        Dataset { name: "JSONL access log", kind: Kind::Jsonl, text: jsonl() },
        Dataset { name: "CSV orders", kind: Kind::Csv, text: csv() },
        Dataset { name: "logfmt lines", kind: Kind::Logfmt, text: logfmt() },
        Dataset { name: "Markdown table", kind: Kind::MdTable, text: md_table() },
        Dataset { name: "XML catalog", kind: Kind::Xml, text: xml() },
        Dataset { name: "SQL inserts", kind: Kind::Sql, text: sql() },
        Dataset { name: "INI profiles", kind: Kind::Ini, text: ini() },
        Dataset { name: "TOML deps", kind: Kind::Toml, text: toml() },
        Dataset { name: "YAML workers", kind: Kind::Yaml, text: yaml() },
        Dataset { name: "CONTROL prose", kind: Kind::Prose, text: prose() },
        Dataset { name: "CONTROL code", kind: Kind::Code, text: code() },
    ]
}

fn strip_decoder(processed: &str) -> &str {
    match processed.split_once('\n') {
        Some((first, rest)) if first.starts_with("Decode @T") => rest,
        _ => processed,
    }
}

/// Round-trip doğrulaması: ham → sıkıştır → geri aç.
/// `None` → motor passthrough yaptı (karşılaştırma gerekmez, "n/a").
fn verify(ds: &Dataset, processed: &str) -> Option<bool> {
    if processed == ds.text {
        return None;
    }
    let body = strip_decoder(processed);
    if ds.kind.plain() {
        return Some(plain_table::decompress(body).as_deref() == Some(ds.text.as_str()));
    }
    let decoded = JsonCompressor::decompress(body).ok()?;
    if ds.kind.structural() {
        let trimmed = ds.text.trim_end_matches(['\n', '\r']);
        let lines: Vec<&str> = trimmed.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let expected = try_ingest(&lines).map(|i| i.value)?;
        Some(decoded == expected)
    } else {
        let expected: serde_json::Value = serde_json::from_str(&ds.text).ok()?;
        Some(decoded == expected)
    }
}

fn main() {
    let bpe = tiktoken_rs::cl100k_base().expect("cl100k tokenizer");

    let mut markdown = String::new();
    markdown.push_str("# Public token-savings measurement\n\n");
    markdown.push_str(
        "Generated by `cargo run --example bench_public --release`. All data is \
         synthetic and deterministic (seeded LCG); no real or private data is used.\n\n",
    );
    markdown.push_str("| Dataset | Kind | Raw tokens | Compressed tokens | Savings % | Round-trip | Applied |\n");
    markdown.push_str("|---|---|---:|---:|---:|---|---|\n");

    println!(
        "{:<20} {:<10} {:>10} {:>12} {:>10} {:>11} {:>8}",
        "dataset", "kind", "raw", "compressed", "savings%", "roundtrip", "applied"
    );
    println!("{}", "-".repeat(88));

    for ds in datasets() {
        let m = process_with_metrics(&ds.text, &bpe, false);
        let applied = m.processed_prompt != ds.text;
        let rt = verify(&ds, &m.processed_prompt);
        let rt_label = match rt {
            None => "n/a".to_string(),
            Some(true) => "ok".to_string(),
            Some(false) => "FAILED".to_string(),
        };
        println!(
            "{:<20} {:<10} {:>10} {:>12} {:>10.1} {:>11} {:>8}",
            ds.name,
            ds.kind.label(),
            m.original_tokens,
            m.compressed_tokens,
            m.savings_percentage,
            rt_label,
            if applied { "yes" } else { "no" }
        );
        let _ = writeln!(
            markdown,
            "| {} | {} | {} | {} | {:.1} | {} | {} |",
            ds.name,
            ds.kind.label(),
            m.original_tokens,
            m.compressed_tokens,
            m.savings_percentage,
            rt_label,
            if applied { "yes" } else { "no" }
        );
    }

    markdown.push_str(
        "\nNotes:\n\n\
         - Token counts use the `cl100k_base` tokenizer; other tokenizers \
         (Claude, Gemini, Llama) will differ.\n\
         - Prose and fenced code are control cases: the expected saving is 0 and the text must come back unchanged.\n\
         - `round-trip` = the compressed form decodes back to the original data (`n/a` when the engine left it untouched).\n",
    );

    // Cikti her zaman REPO KOKUndeki bench/results'a yazilir: ornek hem repo
    // kokunden (`--manifest-path`) hem de src-tauri icinden calistirilabilir.
    let out_dir = repo_root().join("bench").join("results");
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("uyari: {} olusturulamadi: {e}", out_dir.display());
    }
    let target = out_dir.join("token-savings.md");
    match fs::write(&target, &markdown) {
        Ok(()) => println!("\nYazildi: {}", target.display()),
        Err(e) => eprintln!("uyari: sonuc dosyasi yazilamadi: {e}"),
    }
}

/// `package.json` iceren ust dizini (repo koku) bulur; bulunamazsa cwd.
fn repo_root() -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    for dir in cwd.ancestors() {
        if dir.join("package.json").is_file() {
            return dir.to_path_buf();
        }
    }
    cwd
}

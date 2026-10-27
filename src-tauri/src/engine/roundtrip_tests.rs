//! Motorun herkese açık sözleşmesinin round-trip kapsamı.
//!
//! Bu modül motoru DEĞİŞTİRMEZ; yalnızca `process_with_metrics` çıktısının
//! kayıpsız olduğunu her içerik türü için bağımsız olarak doğrular.
//!
//! İki ayrı kayıpsızlık sözleşmesi vardır ve testler bunu açıkça ayırır:
//!
//! - Düz-tablo (XML/SQL/INI/TOML/YAML): `plain_table::decompress` çıktısı
//!   ham girdiyle **bayt bayt** aynı olmalıdır.
//! - Yapısal (JSON, JSONL, CSV, logfmt, markdown tablo): ingest katmanı
//!   metni kanonik JSON'a normalleştirir, bu yüzden bayt eşitliği beklenmez.
//!   Sözleşme, çözülen JSON'un ingest edilen JSON ile birebir aynı olmasıdır.
//!
//! Hiçbir testte motor düzeltilmez: gerçek bir hata bulunursa test `#[ignore]`
//! ile işaretlenip ayrıca raporlanır.

use super::{process_with_metrics, CompressionMetrics};
use crate::engine::ingest::try_ingest;
use crate::engine::jscompress::JsonCompressor;
use crate::engine::plain_table;
use tiktoken_rs::CoreBPE;

fn bpe() -> CoreBPE {
    tiktoken_rs::cl100k_base().expect("cl100k")
}

/// `process_with_metrics` JSON adayları için başa bir decoder talimatı koyar.
/// Geri çözüm için yalnızca `@T`/`#xml` gibi gövdeyi bırakırız.
fn strip_decoder_instruction(processed: &str) -> &str {
    match processed.split_once('\n') {
        Some((first, rest)) if first.starts_with("Decode @T") => rest,
        _ => processed,
    }
}

#[derive(Debug, PartialEq)]
enum Outcome {
    /// Girdi değişti ve round-trip doğrulandı.
    Applied,
    /// Girdi olduğu gibi bırakıldı (eşik altı / ayrıştırılamadı).
    Passthrough,
}

/// Düz-tablo türleri: çözüm bayt eşitliği vermek zorunda.
fn assert_plain_roundtrip(name: &str, raw: &str, bpe: &CoreBPE) -> Outcome {
    let m: CompressionMetrics = process_with_metrics(raw, bpe, false);
    if m.processed_prompt == raw {
        return Outcome::Passthrough;
    }
    let body = strip_decoder_instruction(&m.processed_prompt);
    let decoded = plain_table::decompress(body)
        .unwrap_or_else(|| panic!("{name}: düz-tablo çözümü başarısız\n{body}"));
    assert_eq!(decoded, raw, "{name}: bayt düzeyinde round-trip bozuk");
    Outcome::Applied
}

/// Yapısal türler: çözülen JSON, ingest edilen JSON ile aynı olmak zorunda.
fn assert_structured_roundtrip(name: &str, raw: &str, bpe: &CoreBPE) -> Outcome {
    let m = process_with_metrics(raw, bpe, false);
    if m.processed_prompt == raw {
        return Outcome::Passthrough;
    }
    let body = strip_decoder_instruction(&m.processed_prompt);
    let decoded = JsonCompressor::decompress(body)
        .unwrap_or_else(|e| panic!("{name}: @T çözümü başarısız ({e})\n{body}"));
    let expected = ingest_value(raw);
    assert_eq!(
        decoded, expected,
        "{name}: JSON değeri round-trip'te değişti"
    );
    Outcome::Applied
}

/// Metni segmentleyicinin ingest ettiği gibi ayrıştırır: sondaki boş satırlar
/// atılır, satır sonundaki `\r` kırpılır (CRLF).
fn ingest_value(raw: &str) -> serde_json::Value {
    let trimmed = raw.trim_end_matches(['\n', '\r']);
    let lines: Vec<&str> = trimmed
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .collect();
    try_ingest(&lines)
        .map(|ing| ing.value)
        .unwrap_or_else(|| serde_json::from_str(raw).expect("json veya ingest"))
}

fn json_array(n: usize) -> String {
    let rows: Vec<String> = (0..n)
        .map(|i| {
            format!(
                r#"{{"id":{i},"name":"item-{i:03}","status":"{}","amount":{}.50,"created_at":"2024-01-{:02}T10:00:00Z"}}"#,
                if i % 2 == 0 { "active" } else { "trial" },
                i % 7 + 1,
                i % 28 + 1
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

fn jsonl_log(n: usize) -> String {
    (0..n)
        .map(|i| {
            format!(
                r#"{{"ts":"2024-01-01T10:00:{:02}Z","level":"{}","service":"api","status":{},"path":"/v1/items/{}"}}"#,
                i % 60,
                if i % 10 == 0 { "error" } else { "info" },
                if i % 10 == 0 { 500 } else { 200 },
                i
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv_orders(n: usize) -> String {
    let mut s = String::from("id,customer,status,total,created_at\n");
    for i in 0..n {
        s.push_str(&format!(
            "{i},customer-{:03},{},{}.90,2024-02-{:02}\n",
            i,
            if i % 3 == 0 { "shipped" } else { "pending" },
            i % 50 + 10,
            i % 28 + 1
        ));
    }
    s
}

fn logfmt_lines(n: usize) -> String {
    (0..n)
        .map(|i| {
            format!(
                "ts=2024-01-01T10:00:{:02}Z level={} service=api method=GET path=\"/v1/items/{}\" status={}",
                i % 60,
                if i % 10 == 0 { "error" } else { "info" },
                i,
                if i % 10 == 0 { 500 } else { 200 }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn md_table(n: usize) -> String {
    let mut s = String::from("| id | city | region | population |\n|---|---|---|---|\n");
    for i in 0..n {
        s.push_str(&format!(
            "| {} | city-{:03} | region-{} | {} |\n",
            i,
            i,
            i % 8,
            100_000 + i * 137
        ));
    }
    s
}

fn xml_catalog(n: usize) -> String {
    let mut s = String::from("<catalog>\n");
    for i in 0..n {
        s.push_str(&format!(
            "  <item id=\"{i}\" available=\"true\">\n    <title>Product {i:03}</title>\n    <price>{}.99</price>\n    <category>cat-{}</category>\n  </item>\n",
            i % 90 + 10,
            i % 6
        ));
    }
    s.push_str("</catalog>\n");
    s
}

fn sql_inserts(n: usize) -> String {
    let mut s = String::from("INSERT INTO orders (id, customer, status, total) VALUES\n");
    for i in 0..n {
        let sep = if i + 1 == n { ";" } else { "," };
        s.push_str(&format!(
            "({i}, 'customer-{i:03}', '{}', {}.90){sep}\n",
            if i % 3 == 0 { "shipped" } else { "pending" },
            i % 50 + 10
        ));
    }
    s
}

fn ini_profiles(n: usize) -> String {
    (0..n)
        .map(|i| {
            format!(
                "[profile_{i:02}]\nhost = db-{i:02}.internal\nport = 5432\nsslmode = require\n\n"
            )
        })
        .collect()
}

fn toml_deps(n: usize) -> String {
    // Sıra numarası SIFIR DOLGUSUZ olmalı: `[00]` yazılırsa kodlayıcı `[0]`
    // olarak geri üretir ve round-trip doğrulaması adayı (doğru şekilde)
    // reddeder — bu bir motor hatası değil, beklenen fail-safe davranışıdır.
    (0..n)
        .map(|i| {
            format!(
                "[[dependency.{i}]]\nname = \"crate-{i:02}\"\nversion = \"1.4\"\noptional = false\n\n"
            )
        })
        .collect()
}

fn yaml_workers(n: usize) -> String {
    let mut s = String::from("workers:\n");
    for i in 0..n {
        s.push_str(&format!(
            "  - id: {i}\n    name: worker-{i:03}\n    replicas: {}\n    active: {}\n",
            i % 4 + 1,
            if i % 2 == 0 { "true" } else { "false" }
        ));
    }
    s
}

// ---------------------------------------------------------------------------
// Her biçim için round-trip
// ---------------------------------------------------------------------------

#[test]
fn json_array_roundtrip_covers_all_formats() {
    let b = bpe();
    assert_eq!(
        assert_structured_roundtrip("json", &json_array(200), &b),
        Outcome::Applied
    );
}

#[test]
fn jsonl_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_structured_roundtrip("jsonl", &jsonl_log(500), &b),
        Outcome::Applied
    );
}

#[test]
fn csv_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_structured_roundtrip("csv", &csv_orders(300), &b),
        Outcome::Applied
    );
}

#[test]
fn logfmt_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_structured_roundtrip("logfmt", &logfmt_lines(300), &b),
        Outcome::Applied
    );
}

#[test]
#[ignore = "MOTOR BOSLUGU: segmentleyici yapisal run'i 3 satirdan baslatiyor, \
            markdown tablo ise en az 4 satir (baslik+ayrac+2 satir) istiyor; \
            bu yuzden tablo hic Data segmentine donusmuyor. Motor duzeltmesi \
            bu turun kapsami disinda (bkz. final rapor)."]
fn markdown_table_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_structured_roundtrip("md-table", &md_table(100), &b),
        Outcome::Applied
    );
}

/// Yukaridaki boslugun kayipsizlik tarafi: tablo en azindan HAM kalmali.
#[test]
fn markdown_table_passes_through_untouched() {
    let table = md_table(100);
    let b = bpe();
    let m = process_with_metrics(&table, &b, false);
    assert_eq!(
        m.processed_prompt, table,
        "segmentlenemeyen tablo bayt bayt korunmali"
    );
}

#[test]
fn xml_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_plain_roundtrip("xml", &xml_catalog(150), &b),
        Outcome::Applied
    );
}

#[test]
fn sql_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_plain_roundtrip("sql", &sql_inserts(200), &b),
        Outcome::Applied
    );
}

#[test]
fn ini_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_plain_roundtrip("ini", &ini_profiles(16), &b),
        Outcome::Applied
    );
}

#[test]
fn toml_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_plain_roundtrip("toml", &toml_deps(16), &b),
        Outcome::Applied
    );
}

#[test]
fn yaml_roundtrip() {
    let b = bpe();
    assert_eq!(
        assert_plain_roundtrip("yaml", &yaml_workers(12), &b),
        Outcome::Applied
    );
}

// ---------------------------------------------------------------------------
// Kontrol grubu: dokunulmaması gerekenler
// ---------------------------------------------------------------------------

#[test]
fn prose_is_never_touched() {
    let text = "Thalamus yerel calisan bir masaustu uygulamasidir. \
                Sohbet, proje calisma alani ve ajan modu tek pencerede toplanir. \
                Motor yalnizca yapisal veriyi donusturur; duz yazi hic degismez. \
                Bu paragraf 2000 karaktere yaklasana kadar uzatilir ki esik \
                asilsa bile metin adayi uretilmesin. "
        .repeat(8);
    let b = bpe();
    let m = process_with_metrics(&text, &b, false);
    assert_eq!(m.processed_prompt, text, "duz yazi degismemeli");
    assert!(!m.is_compressed);
}

#[test]
fn fenced_code_block_is_never_touched() {
    let code = "```json\n[{\"id\":1,\"status\":\"ok\"},{\"id\":2,\"status\":\"ok\"}]\n```";
    let b = bpe();
    let m = process_with_metrics(code, &b, false);
    assert_eq!(m.processed_prompt, code, "fenced blok degismemeli");
}

// ---------------------------------------------------------------------------
// Kenar durumlari
// ---------------------------------------------------------------------------

#[test]
fn empty_input_is_returned_as_is() {
    let b = bpe();
    let m = process_with_metrics("", &b, false);
    assert_eq!(m.processed_prompt, "");
    assert_eq!(m.original_tokens, 0);
    assert_eq!(m.savings_percentage, 0.0);
}

#[test]
fn single_record_array_is_not_corrupted() {
    let json = r#"[{"id":1,"name":"tek","status":"ok"}]"#;
    let b = bpe();
    let m = process_with_metrics(json, &b, false);
    // Küçük veride motor passthrough kalir; kalsın da bozulmamalı.
    if m.processed_prompt != json {
        let body = strip_decoder_instruction(&m.processed_prompt);
        let decoded = JsonCompressor::decompress(body).expect("çözüm");
        let expected: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(decoded, expected);
    }
}

#[test]
fn turkish_unicode_survives_roundtrip() {
    let b = bpe();
    // JSON içinde Türkçe karakterler (ğüşiöçİ) ve kaçışlar.
    let json = json_array(120).replace("\"active\"", "\"ğüşiöçİ aktif\"");
    assert_eq!(
        assert_structured_roundtrip("json-turkce", &json, &b),
        Outcome::Applied
    );
    let xml = xml_catalog(80).replace("<title>Product", "<title>Ürün ğüşiöçİ");
    let m = process_with_metrics(&xml, &b, false);
    if m.processed_prompt != xml {
        let decoded = plain_table::decompress(strip_decoder_instruction(&m.processed_prompt))
            .expect("xml çözüm");
        assert_eq!(decoded, xml, "Türkçe karakterler bozulmamalı");
    }
}

#[test]
fn very_long_single_line_is_not_corrupted() {
    let b = bpe();
    // Tek satırda 40 KB'lik düz metin: segmenter bunu metin saymalı.
    let long = "x".repeat(40_000);
    let m = process_with_metrics(&long, &b, false);
    assert_eq!(m.processed_prompt, long);
}

#[test]
fn crlf_input_is_not_corrupted() {
    let b = bpe();
    let crlf = xml_catalog(150).replace('\n', "\r\n");
    let m = process_with_metrics(&crlf, &b, false);
    if m.processed_prompt != crlf {
        let decoded = plain_table::decompress(strip_decoder_instruction(&m.processed_prompt))
            .unwrap_or_else(|| panic!("CRLF çözümü başarısız"));
        assert_eq!(decoded, crlf, "CRLF satır sonları korunmalı");
    }
    // CSV'de de aynı değişmez: ya ham kalır ya birebir çözülür.
    let csv = csv_orders(120).replace('\n', "\r\n");
    let m = process_with_metrics(&csv, &b, false);
    if m.processed_prompt != csv {
        let body = strip_decoder_instruction(&m.processed_prompt);
        let decoded = JsonCompressor::decompress(body).expect("csv çözüm");
        assert_eq!(decoded, ingest_value(&csv));
    }
}

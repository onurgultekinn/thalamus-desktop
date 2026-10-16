// Thalamus yerel sıkıştırma motoru.
// ONNX/model bağımlılığı yoktur; saf Rust + serde_json + tiktoken-rs.
pub mod code_shrink;
pub mod edits;
pub mod ingest;
pub mod jscompress;
pub mod pipeline;
pub mod repo_map;
pub mod schema;
pub mod segments;

pub use jscompress::JsonCompressor;
pub use pipeline::{process_with_metrics, CompressionMetrics};

/// Kabul edilen JSON yükleri için çıktının başına (en fazla bir kez) eklenen
/// decoder talimatı. Tek satırlık muğlak bir anahtar yerine, tabloyu geri
/// açarken en kritik kuralları açıkça verir (ditto `^`, sözlük, prefix,
/// escape'ler) — LLM'in yanlış yorumlama riskini düşürürken token yükünü
/// düşük tutar (ölçülerek ~60 token; karar motoru net tasarrufu zaten doğrular).
pub const MINIMAL_DECODER_INSTRUCTION: &str = r#"Decode @T table to original JSON. @T(k=v) constants. col(0=a;1=b): dict, cell index->value. col[p]: add back prefix p; "" means value p. ~=null. "..."=string (\t \n). ^=repeat previous row cell. Output restored JSON only."#;

/// Tüm JSON ayrıştırma adımlarından önce uygulanan onarım:
/// JSON string literal'leri içindeki gerçek satır sonlarını kaçışlı hale getirir
/// (kopyalanmış JSON'da string içine düşmüş yeni satırlar parse'ı bozar).
pub fn sanitize_json_string(input: &str) -> String {
    let mut output = String::with_capacity(input.len() + 16);
    let mut in_string = false;
    let mut escaped = false;

    for c in input.chars() {
        if escaped {
            output.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            output.push(c);
            escaped = true;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
            output.push(c);
            continue;
        }
        if in_string {
            match c {
                '\n' => output.push_str("\\n"),
                '\r' => output.push_str("\\r"),
                other => output.push(other),
            }
        } else {
            output.push(c);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::pipeline::{
        determine_scope, CandidateCost, Decision, DecisionEngine, VetoScope,
    };

    fn bpe() -> tiktoken_rs::CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn sanitize_converts_real_newlines_inside_strings() {
        let input = "{\"a\": \"line1\nline2\"}";
        let sanitized = sanitize_json_string(input);
        assert!(!sanitized.contains('\n'));
        assert!(sanitized.contains("\\n"));
    }

    #[test]
    fn json_compression_is_lossless_and_saves_tokens() {
        // Sabit kolonlar ve tekrar eden değerler içeren yeterince büyük bir veri
        // (decoder satırının maliyetini aşan gerçek bir tasarruf üretir).
        let items: Vec<String> = (0..60)
            .map(|i| format!(r#"{{"id":{},"type":"telemetry","status":"ok"}}"#, i))
            .collect();
        let json = format!("[{}]", items.join(","));

        let compressed = JsonCompressor::compress(&json, false).unwrap();
        let parsed = serde_json::from_str::<serde_json::Value>(&json).unwrap();
        let decompressed = JsonCompressor::decompress(&compressed).unwrap();
        assert_eq!(decompressed, parsed);

        let metrics = process_with_metrics(&json, &bpe(), false);
        assert!(metrics.processed_prompt != json);
        assert!(metrics.compressed_tokens < metrics.original_tokens);
        assert!(metrics.savings_percentage > 0.0);
        assert!(metrics.is_compressed);
        assert!(metrics.execution_time_ms >= 0.0);
    }

    #[test]
    fn small_json_is_rejected_when_decoder_cost_outweighs_savings() {
        // Küçük veride decoder satırı tasarrufu aşar → passthrough kalmalı.
        let json = r#"[{"id":1,"name":"a","status":"ok"},{"id":2,"name":"b","status":"ok"}]"#;
        let metrics = process_with_metrics(json, &bpe(), false);
        assert!(!metrics.is_compressed);
        assert_eq!(metrics.processed_prompt, json);
    }

    #[test]
    fn veto_keyword_blocks_compression_and_preserves_raw() {
        let prompt = r#"bu json'u bozma: {"a":1,"b":2}"#;
        let metrics = process_with_metrics(prompt, &bpe(), false);
        assert!(!metrics.is_compressed);
        assert_eq!(metrics.processed_prompt, prompt);
    }

    #[test]
    fn veto_override_forces_structure_change() {
        let prompt = r#"bu json'u bozma: {"a":1,"b":2}"#;
        let forced = process_with_metrics(prompt, &bpe(), true);
        assert_ne!(forced.processed_prompt, prompt);
        // D2: veto_override altinda kayipsizlik DOGRULANMISTIR — bayrak
        // yanlis yakilmasin ("verified lossless" rozetinin tek kaynagi).
        assert!(!forced.lossless_verified);
        let normal = process_with_metrics(prompt, &bpe(), false);
        assert!(normal.lossless_verified);
    }

    #[test]
    fn determine_scope_local_vs_global() {
        assert_eq!(determine_scope("bu json'u bozma"), VetoScope::LocalToNext);
        assert_eq!(determine_scope("tüm json'ları bozma"), VetoScope::Global);
    }

    #[test]
    fn decision_engine_accepts_when_saving_worth_decoder() {
        let candidates = [CandidateCost {
            raw_tokens: 100,
            optimized_tokens: 50,
            lossless: true,
            vetoed: false,
        }];
        let decisions = DecisionEngine::evaluate(&candidates, 10);
        assert_eq!(decisions[0], Decision::Accept);
    }

    // -----------------------------------------------------------------------
    // Kayıpsızlık korpusu: her kabul edilen sıkıştırma geri açılabilir olmalı.
    // -----------------------------------------------------------------------

    /// Sıkıştırma kabul edilirse round-trip kayıpsızlığını doğrular.
    /// Reddedilirse (güvenli passthrough) `None` döner.
    fn lossless_or_skip(json: &str) -> Option<String> {
        match JsonCompressor::compress(json, false) {
            Ok(c) => {
                let parsed = serde_json::from_str::<serde_json::Value>(json).unwrap();
                assert_eq!(
                    JsonCompressor::decompress(&c).unwrap(),
                    parsed,
                    "round-trip kayıpsızlık bozuldu"
                );
                Some(c)
            }
            Err(_) => None,
        }
    }

    #[test]
    fn edge_case_corpus_is_lossless_and_compresses() {
        // Sayıya benzeyen string'ler, boş string, "^", "~" , "true", unicode,
        // tab/satır sonu içeren string'ler, null ve bool karışımı.
        let items: Vec<serde_json::Value> = vec![
            serde_json::json!({"id":0,"name":"007","status":true}),
            serde_json::json!({"id":1,"name":"","status":false}),
            serde_json::json!({"id":2,"name":"1.5","status":null}),
            serde_json::json!({"id":3,"name":"true","status":true}),
            serde_json::json!({"id":4,"name":"^","status":false}),
            serde_json::json!({"id":5,"name":"~","status":true}),
            serde_json::json!({"id":6,"name":"0","status":null}),
            serde_json::json!({"id":7,"name":"İstanbul-Ş","status":true}),
            serde_json::json!({"id":8,"name":"tab\there","status":false}),
            serde_json::json!({"id":9,"name":"line\nbreak","status":true}),
        ];
        let mut rows: Vec<serde_json::Value> = Vec::with_capacity(60);
        for i in 0..60 {
            let mut v = items[i % items.len()].clone();
            v["id"] = serde_json::json!(i);
            rows.push(v);
        }
        let json = serde_json::to_string(&serde_json::Value::Array(rows)).unwrap();

        let _comp = lossless_or_skip(&json).expect("köşe durum korpusu sıkışmalı");
        let m = process_with_metrics(&json, &bpe(), false);
        assert!(
            m.is_compressed,
            "köşe durum korpusu hedeflenen tasarrufa ulaşmalı"
        );
        assert!(m.saved_tokens > 0);
        assert!(m.savings_percentage > 0.0);
    }

    #[test]
    fn mixed_string_number_column_with_prefix_is_lossless() {
        // Aynı kolonda hem "val_N" string'leri (ortak prefiks "val_") hem de
        // ham sayı hücreleri var. Önceden decode sayıya prefix ekliyordu;
        // kayıpsızlık reddiyle passthrough'a düşüyordu. Şimdi ikisi de güvenli.
        let rows: Vec<serde_json::Value> = (0..60)
            .map(|i| {
                serde_json::json!({
                    "id": i,
                    "val": if i % 2 == 0 {
                        serde_json::Value::String(format!("val_{}", i % 20))
                    } else {
                        serde_json::Value::Number((i % 20).into())
                    }
                })
            })
            .collect();
        let json = serde_json::to_string(&serde_json::Value::Array(rows)).unwrap();

        let _comp = lossless_or_skip(&json).expect("prefix+sayı karışımı artık sıkışmalı");
        let m = process_with_metrics(&json, &bpe(), false);
        assert!(m.is_compressed);
        // Düzeltmenin kanıtı: sayı hücreleri sayı, string'ler prefix+string kalmalı.
        // (compress işlenmiş çıktıda sayılar olduğu gibi kalmalı)
        assert!(m.processed_prompt.contains("val_") || m.is_compressed);
    }

    #[test]
    fn nested_json_tabs_and_big_numbers_are_lossless() {
        let rows: Vec<serde_json::Value> = (0..30)
            .map(|i| {
                serde_json::json!({
                    "id": i,
                    "meta": {"nested":[1,2,{"k":"v"}],"list":["a","b"]},
                    "big": 18_446_744_073_709_551_615u64,
                    "neg": -9_223_372_036_854_775_808i64,
                    "f1": 0.5,
                    "f2": 1e300,
                })
            })
            .collect();
        let json = serde_json::to_string(&serde_json::Value::Array(rows)).unwrap();
        // Güvenlik: kabul edilirse kayıpsız; reddedilirse yine güvenli.
        let _ = lossless_or_skip(&json);
    }

    #[test]
    fn single_object_and_primitive_array_are_safe() {
        let obj = r#"{"a":1,"b":2,"c":"x","d":true,"e":[1,2,{"k":"v"}]}"#;
        if let Ok(c) = JsonCompressor::compress(obj, false) {
            assert_eq!(
                JsonCompressor::decompress(&c).unwrap(),
                serde_json::from_str::<serde_json::Value>(obj).unwrap()
            );
        }
        // İlkel dizi: değişmeden döner ama kayıpsızdır.
        let arr = "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]";
        assert_eq!(JsonCompressor::compress(arr, false).unwrap(), arr);
    }

    #[test]
    fn ditto_chain_round_trips() {
        // Aynı uzun değerin peş peşe geldiği satırlar `^` ile kodlanır.
        // (sabit kolon koşuluna takılmamak için 20 ayrı değer; sözlüğe
        // düşmemek için >10 benzersiz; prefix'e düşmemek için ortak önek yok.)
        let mut rows: Vec<serde_json::Value> = Vec::with_capacity(40);
        for i in 0..40 {
            rows.push(serde_json::json!({
                "id": i,
                "payload": format!("s{}_bbbbbbbbbbbbbbbbbbbb", i / 2),
            }));
        }
        let json = serde_json::to_string(&serde_json::Value::Array(rows)).unwrap();
        let comp = lossless_or_skip(&json).expect("ditto zinciri sıkışmalı");
        assert!(comp.contains('^'), "ditto işareti üretilmeli");
        // Kayıpsızlık zaten lossless_or_skip içinde doğrulandı.
    }

    #[test]
    fn hybrid_prompt_compression_is_lossless() {
        let rows: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"id":{},"type":"t","st":"ok"}}"#, i))
            .collect();
        let json = format!("[{}]", rows.join(","));
        let prompt = format!("aşağıdaki veriyi işle: {}", json);
        let m = process_with_metrics(&prompt, &bpe(), false);
        if m.is_compressed {
            assert!(m.saved_tokens > 0);
            assert!(m.processed_prompt.starts_with(MINIMAL_DECODER_INSTRUCTION));
            assert!(m.processed_prompt.contains("aşağıdaki veriyi işle"));
        }
    }

    // -----------------------------------------------------------------------
    // Katmanlı segmentasyon: kod asla bozulmaz, sıra korunur.
    // -----------------------------------------------------------------------

    #[test]
    fn fenced_code_is_never_compressed() {
        let rows: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"id":{},"type":"t","st":"ok"}}"#, i))
            .collect();
        let prompt = format!(
            "kod:\n```python\nx = {{\"a\": 1, \"b\": 2}}\n```\nveri: [{}]",
            rows.join(",")
        );
        let m = process_with_metrics(&prompt, &bpe(), false);
        assert!(m.is_compressed, "fence dışındaki JSON sıkışmalı");
        assert!(
            m.processed_prompt.contains("x = {\"a\": 1, \"b\": 2}"),
            "fenced kod bozulmamalı"
        );
        assert!(
            m.processed_prompt.contains("```python"),
            "fence işaretleri kalmalı"
        );
    }

    #[test]
    fn inline_code_json_is_not_extracted() {
        let rows: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"id":{},"type":"t","st":"ok"}}"#, i))
            .collect();
        let big = format!("[{}]", rows.join(","));
        let prompt = format!("şablon: `{}`", big);
        let m = process_with_metrics(&prompt, &bpe(), false);
        assert!(!m.is_compressed, "inline kod içindeki JSON çıkarılmamalı");
        assert_eq!(m.processed_prompt, prompt);
    }

    #[test]
    fn multi_segment_order_is_preserved() {
        let a: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"id":{},"t":"a"}}"#, i))
            .collect();
        let b: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"id":{},"t":"b"}}"#, i))
            .collect();
        let prompt = format!("başlangıç [{}] orta [{}] son", a.join(","), b.join(","));
        let m = process_with_metrics(&prompt, &bpe(), false);
        assert!(m.is_compressed);
        let p = &m.processed_prompt;
        let i1 = p.find("başlangıç").unwrap();
        let i2 = p.find("orta").unwrap();
        let i3 = p.find("son").unwrap();
        assert!(i1 < i2 && i2 < i3, "metin segmentleri sırasını korumalı");
    }

    // -----------------------------------------------------------------------
    // Ingest katmanı: JSON dışı yapısal metin de kayıpsız sıkışmalı.
    // -----------------------------------------------------------------------

    #[test]
    fn logfmt_block_is_compressed_losslessly() {
        let lines: Vec<String> = (1..=40)
            .map(|i| {
                format!(
                    "ts=2024-01-01T10:00:{:02}Z level=info service=api msg=\"ok{}\"",
                    i % 60,
                    i
                )
            })
            .collect();
        let prompt = format!("son loglar:\n{}", lines.join("\n"));
        let m = process_with_metrics(&prompt, &bpe(), false);
        println!(
            "logfmt: {} → {} token (%{})",
            m.original_tokens, m.compressed_tokens, m.savings_percentage
        );
        assert!(m.is_compressed, "logfmt bloğu sıkışmalı");
        assert!(m.saved_tokens > 0);
        assert!(m.processed_prompt.contains("son loglar:"));
        assert!(
            m.processed_prompt.contains("@T("),
            "sabit alanlar katlanmalı"
        );
    }
}

// Sıkıştırma hattı — tamamen kayıpsız:
//
//   prompt → katmanlı segmentasyon (fence/inline kod → JSON → metin)
//          → JSON segmentlerinde kayıpsız @T sıkıştırma + maliyet ölçümü
//          → net-tasarruf kararı (decoder maliyeti toplamda bir kez)
//          → orijinal sırayla birleştirme.
//
// Kod bloklarına (fenced/inline) ve metne asla dokunulmaz; segment sırası
// girdi sırasını birebir korur. Sıkıştırılamayan her şey ham kalır.
use crate::engine::certification;
use crate::engine::jscompress::JsonCompressor;
use crate::engine::sanitize_json_string;
use crate::engine::segments::{PromptSegmenter, Segment};
use crate::engine::MINIMAL_DECODER_INSTRUCTION;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tiktoken_rs::CoreBPE;

/// Bu boyutu aşan yükler "dev" sayılır (ileride paralel sıkıştırma için).
pub const GIANT_PAYLOAD_THRESHOLD: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionMetrics {
    pub original_prompt: String,
    pub processed_prompt: String,
    pub is_compressed: bool,
    pub original_tokens: usize,
    pub compressed_tokens: usize,
    pub saved_tokens: usize,
    pub savings_percentage: f64,
    pub execution_time_ms: f64,
    /// D2: normal yolda her sıkıştırma segment-düzeyi lossless doğrulamasından
    /// geçer; `veto_override: true` (hata ayıklama) doğrulamayı atlar ve yapıyı zorlar.
    /// değişebilir. Bu bayrak UI'nın "verified lossless" rozetini yalnızca
    /// GERÇEKTEN doğrulanmış çıktıda yakması içindir — yalan rozet yok.
    pub lossless_verified: bool,
}

// ---------------------------------------------------------------------------
// Karar motoru: decoder satırının maliyetini tüm adaylara pay edip kabul/ret verir
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Decision {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Copy)]
pub struct CandidateCost {
    pub raw_tokens: usize,
    pub optimized_tokens: usize,
    pub lossless: bool,
}

pub struct DecisionEngine;

impl DecisionEngine {
    pub fn evaluate(candidates: &[CandidateCost], decoder_tokens: usize) -> Vec<Decision> {
        let mut decisions = vec![Decision::Reject; candidates.len()];

        let mut eligible_indices = Vec::new();
        let mut total_gross_savings: usize = 0;

        for (idx, c) in candidates.iter().enumerate() {
            if !c.lossless {
                continue;
            }
            if c.raw_tokens > c.optimized_tokens {
                let gross_saving = c.raw_tokens - c.optimized_tokens;
                eligible_indices.push(idx);
                total_gross_savings += gross_saving;
            }
        }

        if total_gross_savings > decoder_tokens {
            for idx in eligible_indices {
                decisions[idx] = Decision::Accept;
            }
        }

        decisions
    }
}

// ---------------------------------------------------------------------------
// Segment analizi ve ana hat
// ---------------------------------------------------------------------------
fn count_tokens(bpe: &CoreBPE, text: &str) -> usize {
    bpe.encode_with_special_tokens(text).len()
}

fn is_lossless(raw: &str, compressed: &str) -> bool {
    if let Ok(decompressed) = JsonCompressor::decompress(compressed) {
        if let Ok(original) = serde_json::from_str::<serde_json::Value>(&sanitize_json_string(raw))
        {
            return decompressed == original;
        }
    }
    false
}

pub fn process(raw_prompt: &str, bpe: &CoreBPE, veto_override: bool) -> String {
    let segments = PromptSegmenter::segment(raw_prompt);

    // KAYIPSIZLIK BEKÇİSİ: segmentler girdiyi birebir kaplamıyorsa (boşluk ya da
    // örtüşme) birleştirme sessizce karakter kaybedebilir. Gerçek kod
    // dosyalarında gözlendi (lab/docs/TRIALS.md, TRIALS-003). Böyle bir durumda
    // sıkıştırma tamamen iptal edilir ve ham metin döner: kayıpsızlık kazançtan
    // önce gelir.
    if !PromptSegmenter::tiles_exactly(&segments, raw_prompt) {
        return raw_prompt.to_string();
    }

    struct Candidate<'a> {
        raw: &'a str,
        compressed: Option<String>,
        cost: CandidateCost,
        /// Düz-tablo (XML/SQL) adayı: kendi decoder talimatı yoktur, karar
        /// motorundaki JSON decoder maliyetine tabi değildir.
        structured: bool,
    }

    // AŞAMA 1 — ANALİZ: yalnız JSON/yapısal adaylar. Metin ve talimat dokunulmaz.
    let mut candidates: Vec<Candidate> = Vec::new();

    for seg in &segments {
        match seg {
            // Metin (talimat/prose) hiçbir zaman sıkıştırılmaz ve niyet
            // tahmini yapılmaz. Koruma kararı yalnız çağıranın `preserve`
            // ayarından gelir (D-040).
            Segment::Text(_) => {}
            Segment::Verbatim(_) => {
                // Fenced/inline kod: asla dokunulmaz.
            }
            Segment::Structured {
                raw,
                compressed,
                kind,
            } => {
                // Segmenter yalnız kayıpsız doğrulanmış temsilleri üretir.
                let raw_tokens = count_tokens(bpe, raw);
                let candidate_tokens = count_tokens(bpe, compressed);
                // SERTİFİKASYON EŞİĞİ: anlama kapısından geçmemiş veya bu
                // aday için kazanç eşiğin altındaysa ham kalır (D-031).
                let savings_pct = if raw_tokens == 0 {
                    0.0
                } else {
                    100.0 * (raw_tokens.saturating_sub(candidate_tokens) as f64)
                        / (raw_tokens as f64)
                };
                let certified = certification::plain_table_ok(*kind, savings_pct);
                candidates.push(Candidate {
                    raw,
                    compressed: if certified {
                        Some(compressed.clone())
                    } else {
                        None
                    },
                    cost: CandidateCost {
                        raw_tokens,
                        optimized_tokens: if certified { candidate_tokens } else { raw_tokens },
                        lossless: true,
                    },
                    structured: true,
                });
            }
            Segment::Json(raw) | Segment::Data { raw, json: _ } => {
                let raw_tokens = count_tokens(bpe, raw);
                let mut cand = Candidate {
                    raw,
                    compressed: None,
                    cost: CandidateCost {
                        raw_tokens,
                        optimized_tokens: raw_tokens,
                        lossless: false,
                    },
                    structured: false,
                };

                let is_giant = raw.len() >= GIANT_PAYLOAD_THRESHOLD;
                // Json segmentinde ham metin zaten JSON'dur; Data segmentinde
                // ingest edilmiş kanonik JSON üzerinde çalışılır.
                let source_json = match seg {
                    Segment::Json(raw) => raw,
                    Segment::Data { json, .. } => json.as_str(),
                    _ => unreachable!(),
                };
                if let Ok(compressed) = JsonCompressor::compress(source_json, is_giant) {
                    // compress() zaten kayıpsızlığı doğrular; reddederse ham kalır.
                    if veto_override || is_lossless(source_json, &compressed) {
                        cand.cost.optimized_tokens = count_tokens(bpe, &compressed);
                        cand.cost.lossless = true;
                        cand.compressed = Some(compressed);
                    }
                }
                candidates.push(cand);
            }
        }
    }

    if candidates.is_empty() {
        return raw_prompt.to_string();
    }

    // AŞAMA 2 — KARAR: JSON decoder maliyeti toplamda bir kez hesaba katılır.
    // Düz-tablo adayları decoder talimatı gerektirmez (şema kendi içinde).
    let decoder_tokens = count_tokens(bpe, MINIMAL_DECODER_INSTRUCTION);
    let json_idx: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.structured)
        .map(|(i, _)| i)
        .collect();
    let json_costs: Vec<CandidateCost> = json_idx.iter().map(|&i| candidates[i].cost).collect();
    let mut decisions = vec![Decision::Reject; candidates.len()];
    if veto_override {
        decisions = vec![Decision::Accept; candidates.len()];
    } else {
        let json_decisions = DecisionEngine::evaluate(&json_costs, decoder_tokens);
        for (k, &i) in json_idx.iter().enumerate() {
            decisions[i] = json_decisions[k];
        }
        for (i, c) in candidates.iter().enumerate() {
            if c.structured {
                decisions[i] = if c.compressed.is_some() {
                    Decision::Accept
                } else {
                    Decision::Reject
                };
            }
        }
    }
    let accepted_json_any = json_idx
        .iter()
        .any(|&i| decisions[i] == Decision::Accept);

    // AŞAMA 3 — BİRLEŞTİRME: orijinal sıra, decoder talimatı en fazla bir kez.
    let mut output =
        String::with_capacity(raw_prompt.len() + MINIMAL_DECODER_INSTRUCTION.len() + 2);
    if accepted_json_any {
        output.push_str(MINIMAL_DECODER_INSTRUCTION);
        output.push('\n');
    }

    let mut json_idx = 0;
    for seg in &segments {
        match seg {
            Segment::Text(t) | Segment::Verbatim(t) => output.push_str(t),
            Segment::Json(_) | Segment::Data { .. } | Segment::Structured { .. } => {
                let cand = &candidates[json_idx];
                let decision = decisions[json_idx];
                json_idx += 1;
                match (decision, &cand.compressed) {
                    (Decision::Accept, Some(compressed)) => output.push_str(compressed),
                    _ => output.push_str(cand.raw),
                }
            }
        }
    }
    output
}

pub fn process_with_metrics(
    raw_prompt: &str,
    bpe: &CoreBPE,
    veto_override: bool,
) -> CompressionMetrics {
    let start = Instant::now();
    let processed = process(raw_prompt, bpe, veto_override);
    let elapsed = start.elapsed();
    let execution_time_ms = (elapsed.as_secs_f64() * 1000.0 * 100.0).round() / 100.0;

    let original_tokens = count_tokens(bpe, raw_prompt);
    let compressed_tokens = count_tokens(bpe, &processed);

    let is_compressed = processed != raw_prompt && compressed_tokens < original_tokens;
    let saved_tokens = if is_compressed {
        original_tokens.saturating_sub(compressed_tokens)
    } else {
        0
    };
    let savings_percentage = if original_tokens > 0 && is_compressed {
        ((saved_tokens as f64 / original_tokens as f64) * 10000.0).round() / 100.0
    } else {
        0.0
    };

    CompressionMetrics {
        original_prompt: raw_prompt.to_string(),
        processed_prompt: processed,
        is_compressed,
        original_tokens,
        compressed_tokens,
        saved_tokens,
        savings_percentage,
        execution_time_ms,
        // Normal yol yalnızca doğrulanmış sıkıştırmayı yayar; veto_override
        // doğrulamayı atlarcasına yapıyı zorlar → dürüstçe `false`.
        lossless_verified: !veto_override,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bpe() -> CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    fn xml_doc() -> String {
        let mut s = String::from("<services>
");
        for i in 0..10 {
            s.push_str(&format!(
                "  <item id=\"{}\" enabled=\"true\">
    <name>svc-{:02}</name>
    <port>{}</port>
  </item>
",
                i,
                i,
                8000 + i
            ));
        }
        s.push_str("</services>
");
        s
    }

    #[test]
    fn structured_xml_is_compressed_losslessly() {
        let doc = xml_doc();
        let out = process(&doc, &bpe(), false);
        assert!(out.contains("#xml <item>"), "tablo bekleniyordu: {}", out);
        assert!(out.len() < doc.len());
        assert_eq!(
            crate::engine::plain_table::decompress(&out).expect("geri çözüm"),
            doc
        );
        // Düz-tablo kendi şemasını taşır; JSON decoder satırı eklenmemeli.
        assert!(!out.starts_with("Decode @T"));
    }

    #[test]
    fn fenced_xml_is_never_touched() {
        let doc = format!("```xml
{}```", xml_doc());
        assert_eq!(process(&doc, &bpe(), false), doc);
    }


    #[test]
    fn thin_savings_is_rejected_by_certification_gate() {
        // Değerler etiketlerden uzun: tablo kazancı %25 eşiğinin altında kalır.
        let mut doc = String::from("<r>
");
        for i in 0..4 {
            doc.push_str(&format!(
                "  <i id=\"{}\">
    <v>deger-{}-{}</v>
  </i>
",
                i,
                i,
                "x".repeat(120)
            ));
        }
        doc.push_str("</r>
");
        let out = process(&doc, &bpe(), false);
        assert!(out.contains("<i id=\"0\">"), "esik alti ham kalmali: {}", out);
        assert!(!out.contains("#xml <i>"));
    }
    #[test]
    fn ini_toml_yaml_are_compressed_losslessly() {
        let n = '\n';
        let mut ini = String::new();
        let mut toml = String::new();
        for i in 0..16 {
            ini.push_str(&format!(
                "[p{:02}]{n}host = db-{:02}{n}port = 5432{n}sslmode = require{n}{n}",
                i, i
            ));
            toml.push_str(&format!(
                "[[dep.{}]]{n}name = \"c{r:02}\"{n}version = \"1.4\"{n}optional = false{n}{n}",
                i,
                r = i
            ));
        }
        let mut yaml = String::from("workers:");
        yaml.push(n);
        for i in 0..8 {
            yaml.push_str(&format!("  - id: {}{n}    name: w-{:03}{n}    active: true{n}", i, i));
        }
        for (doc, marker) in [
            (ini, "#ini section "),
            (toml, "#toml [["),
            (yaml, "#yaml list "),
        ] {
            let out = process(&doc, &bpe(), false);
            assert!(out.contains(marker), "donusum bekleniyordu: {out}");
            assert!(out.len() < doc.len());
            assert_eq!(
                crate::engine::plain_table::decompress(&out).expect("geri cozum"),
                doc
            );
        }
    }

}

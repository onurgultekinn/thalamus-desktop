// Sıkıştırma hattı — tamamen kayıpsız:
//
//   prompt → katmanlı segmentasyon (fence/inline kod → JSON → metin)
//          → metin segmentlerinde veto niyeti analizi
//          → JSON segmentlerinde kayıpsız @T sıkıştırma + maliyet ölçümü
//          → net-tasarruf kararı (decoder maliyeti toplamda bir kez)
//          → orijinal sırayla birleştirme.
//
// Kod bloklarına (fenced/inline) ve metne asla dokunulmaz; segment sırası
// girdi sırasını birebir korur. Sıkıştırılamayan her şey ham kalır.
use crate::engine::jscompress::JsonCompressor;
use crate::engine::segments::{PromptSegmenter, Segment};
use crate::engine::sanitize_json_string;
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
    pub vetoed: bool,
}

pub struct DecisionEngine;

impl DecisionEngine {
    pub fn evaluate(candidates: &[CandidateCost], decoder_tokens: usize) -> Vec<Decision> {
        let mut decisions = vec![Decision::Reject; candidates.len()];

        let mut eligible_indices = Vec::new();
        let mut total_gross_savings: usize = 0;

        for (idx, c) in candidates.iter().enumerate() {
            if c.vetoed || !c.lossless {
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
// Veto (anahtar kelime tabanlı) — koruma niyeti taşıyan metinleri yakalar
// ---------------------------------------------------------------------------
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum VetoScope {
    Global,
    LocalToNext,
    None,
}

#[derive(Debug, PartialEq, Clone)]
pub struct IntentAnalysis {
    pub scope: VetoScope,
    pub confidence: f32,
    pub is_vetoed: bool,
}

/// "Bunu sıkıştırma / aynen koru / parse et" niyeti → veto (sıkıştırmayı engelle).
const PRESERVE_PHRASES: &[&str] = &[
    // İngilizce
    "do not compress",
    "dont compress",
    "no compression",
    "do not minify",
    "dont minify",
    "no minification",
    "keep it as is",
    "keep as is",
    "keep the original",
    "keep original",
    "original format",
    "raw json",
    "raw format",
    "verbatim",
    "untouched",
    "don't change",
    "do not change",
    "don't modify",
    "fix the json",
    "fix this json",
    // Parse kodu isteği
    "write code to parse",
    "write a parser",
    "write a script to parse",
    "write a function to parse",
    "write a program to parse",
    "parse this json",
    "parse the following json",
    "parse the json",
    "parse the data",
    // Türkçe
    "bozma",
    "bozmayın",
    "dokunma",
    "dokunmayın",
    "değiştirme",
    "değiştirmeyin",
    "sıkıştırma yapma",
    "sıkıştırma",
    "yapma sıkıştır",
    "olduğu gibi",
    "aynen koru",
    "aynen bırak",
    "koru",
    "koruyarak",
    "küçültme",
    "minimize etme",
    "parse et",
    "parse eden kod",
    "parse eden",
    "kod yaz",
];

const LOCAL_KEYWORDS: &[&str] = &[
    "bu json",
    "bu veriyi",
    "aşağıdaki json",
    "aşağıdaki veri",
    "şu json",
    "this json",
    "this data",
    "the following json",
    "following data",
];

const GLOBAL_KEYWORDS: &[&str] = &[
    "tüm json",
    "tüm veriler",
    "bütün json",
    "hepsi",
    "tamamını",
    "her json",
    "all json",
    "all data",
    "every json",
    "everything",
];

fn judge_intent(text: &str) -> IntentAnalysis {
    let lower = text.to_lowercase();
    let is_vetoed = PRESERVE_PHRASES.iter().any(|&kw| lower.contains(kw));

    let scope = if is_vetoed {
        determine_scope(text)
    } else {
        VetoScope::None
    };

    IntentAnalysis {
        scope,
        confidence: if is_vetoed { 0.9 } else { 0.0 },
        is_vetoed,
    }
}

pub fn determine_scope(text: &str) -> VetoScope {
    let lower = text.to_lowercase();

    let has_local = LOCAL_KEYWORDS.iter().any(|&kw| lower.contains(kw));
    let has_global = GLOBAL_KEYWORDS.iter().any(|&kw| lower.contains(kw));

    if has_local && !has_global {
        VetoScope::LocalToNext
    } else {
        VetoScope::Global
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
        if let Ok(original) =
            serde_json::from_str::<serde_json::Value>(&sanitize_json_string(raw))
        {
            return decompressed == original;
        }
    }
    false
}

pub fn process(raw_prompt: &str, bpe: &CoreBPE, veto_override: bool) -> String {
    let segments = PromptSegmenter::segment(raw_prompt);

    struct Candidate<'a> {
        raw: &'a str,
        compressed: Option<String>,
        cost: CandidateCost,
    }

    // AŞAMA 1 — ANALİZ: metin segmentlerinde veto niyeti, JSON adayları.
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut has_global_veto = false;
    let mut pending_local_veto = false;

    for seg in &segments {
        match seg {
            Segment::Text(t) => {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let analysis = judge_intent(trimmed);
                if analysis.is_vetoed {
                    match analysis.scope {
                        VetoScope::Global => has_global_veto = true,
                        VetoScope::LocalToNext => pending_local_veto = true,
                        VetoScope::None => {}
                    }
                }
            }
            Segment::Verbatim(_) => {
                // Fenced/inline kod: asla dokunulmaz, veto zincirini de etkilemez.
            }
            Segment::Json(raw) | Segment::Data { raw, json: _ } => {
                let is_vetoed = !veto_override && (has_global_veto || pending_local_veto);
                pending_local_veto = false; // local veto tüketildi

                let raw_tokens = count_tokens(bpe, raw);
                let mut cand = Candidate {
                    raw,
                    compressed: None,
                    cost: CandidateCost {
                        raw_tokens,
                        optimized_tokens: raw_tokens,
                        lossless: false,
                        vetoed: is_vetoed,
                    },
                };

                if !is_vetoed {
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
                }
                candidates.push(cand);
            }
        }
    }

    if candidates.is_empty() {
        return raw_prompt.to_string();
    }

    // AŞAMA 2 — KARAR: decoder maliyeti toplamda bir kez hesaba katılır.
    let decoder_tokens = count_tokens(bpe, MINIMAL_DECODER_INSTRUCTION);
    let costs: Vec<CandidateCost> = candidates.iter().map(|c| c.cost).collect();
    let decisions = if veto_override {
        vec![Decision::Accept; candidates.len()]
    } else {
        DecisionEngine::evaluate(&costs, decoder_tokens)
    };
    let accepted_any = decisions.contains(&Decision::Accept);

    // AŞAMA 3 — BİRLEŞTİRME: orijinal sıra, decoder talimatı en fazla bir kez.
    let mut output =
        String::with_capacity(raw_prompt.len() + MINIMAL_DECODER_INSTRUCTION.len() + 2);
    if accepted_any {
        output.push_str(MINIMAL_DECODER_INSTRUCTION);
        output.push('\n');
    }

    let mut json_idx = 0;
    for seg in &segments {
        match seg {
            Segment::Text(t) | Segment::Verbatim(t) => output.push_str(t),
            Segment::Json(_) | Segment::Data { .. } => {
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
    }
}

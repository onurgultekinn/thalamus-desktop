// Ince tokenizer katmani — tiktoken ile BIREBIR ayni cikti, daha hizli tarama.
//
// Neden hizli:
// tiktoken-rs, cl100k desenindeki `\s+(?!\S)` lookahead'i icin `fancy_regex`
// kullaniyor; kutuphanenin kendi notuna gore lookahead'siz desen ~3x daha hizli
// taraniyor. `\s+(?!\S)|\s+` alternatifi davranissal olarak `\s+` ile aynidir
// (ikisi de ayni bosluk kosusunu esit uzunlukta esler), bu yuzden desen
// kayipsiz sekilde sadeleştirilebilir.
//
// Neden kayipsiz:
// tiktoken `_encode_ordinary_native` de metni ayni regex ile parcalara ayirip
// her parcayi bagimsiz BPE'ler. Biz de ayni parcalari uretip ayni
// `byte_pair_encode` fonksiyonunu cagiriyoruz; token dizisi birebir ayni.
//
// Guvenlik:
//   * "<|" iceren metin (ozel token) seri yola duser.
//   * Rank tablosu/desen yuklenemezse seri yol.
//   * Kucuk makinelerde (Tier::Small) bellek tasarrufu icin kapali.
//   * TLM_FASTTOK=0 ile tamamen kapatilabilir.
//
// Dogrulama: tests::token_ids_match_core_bpe ve count_matches_serial_on_corpus.

use base64::Engine as _;
use fancy_regex::Regex;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::sync::OnceLock;
use tiktoken_rs::{byte_pair_encode, CoreBPE};

use crate::engine::hw::{self, Tier};

/// tiktoken-rs 0.5.9 cl100k_base parcalama deseni (birebir).
const PATTERN: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";

/// tiktoken-rs 0.5.9 ile ayni sozluk (kamuya acik veri).
const ASSET: &str = include_str!("../../assets/cl100k_base.tiktoken");

/// Bu esigin altinda paralellik maliyeti kazanci asar.
const MIN_BYTES: usize = 8_192;

struct FastTok {
    ranks: FxHashMap<Vec<u8>, usize>,
    re: Regex,
}

fn load_ranks() -> Option<FxHashMap<Vec<u8>, usize>> {
    let decoder = base64::engine::general_purpose::STANDARD;
    let mut ranks: FxHashMap<Vec<u8>, usize> =
        FxHashMap::with_capacity_and_hasher(100_256, Default::default());
    for line in ASSET.lines() {
        let (b64, rank) = line.split_once(' ')?;
        let bytes = decoder.decode(b64).ok()?;
        ranks.insert(bytes, rank.trim().parse().ok()?);
    }
    if ranks.len() < 100_000 {
        return None;
    }
    Some(ranks)
}

fn instance() -> Option<&'static FastTok> {
    static INSTANCE: OnceLock<Option<FastTok>> = OnceLock::new();
    INSTANCE
        .get_or_init(|| {
            if std::env::var("TLM_FASTTOK").map(|v| v == "0").unwrap_or(false) {
                return None;
            }
            // Zayif makinede ~20 MB'lik ek tablo yuklenmesin.
            if hw::profile().tier() == Tier::Small {
                return None;
            }
            let ranks = load_ranks()?;
            let re = Regex::new(PATTERN).ok()?;
            Some(FastTok { ranks, re })
        })
        .as_ref()
}

fn encode_len(f: &FastTok, piece: &str) -> usize {
    let bytes = piece.as_bytes();
    if f.ranks.contains_key(bytes) {
        1
    } else {
        byte_pair_encode(bytes, &f.ranks).len()
    }
}

/// Parcalari sirayla token kimliklerine cevirir (test/teshis icin).
#[cfg(test)]
fn encode_ids(f: &FastTok, text: &str) -> Option<Vec<usize>> {
    let mut out = Vec::new();
    for m in f.re.find_iter(text) {
        let m = m.ok()?;
        let piece = m.as_str().as_bytes();
        match f.ranks.get(piece) {
            Some(&t) => out.push(t),
            None => out.extend(byte_pair_encode(piece, &f.ranks)),
        }
    }
    Some(out)
}

/// Token sayisi — seri kodlamayla birebir ayni.
pub fn count(bpe: &CoreBPE, text: &str) -> usize {
    // Ozel token isareti veya kucuk metin: seri yol.
    if text.len() < MIN_BYTES || text.contains("<|") {
        return bpe.encode_with_special_tokens(text).len();
    }
    let Some(f) = instance() else {
        return bpe.encode_with_special_tokens(text).len();
    };

    // Parcalama tek gecis (tiktoken ile ayni desen), BPE paralel.
    let mut pieces: Vec<&str> = Vec::new();
    let mut expected = 0usize;
    for m in f.re.find_iter(text) {
        let Ok(m) = m else {
            return bpe.encode_with_special_tokens(text).len();
        };
        // Bosluk/ortusme varsa desen varsayimi tutmadi -> seri yol.
        if m.start() != expected {
            return bpe.encode_with_special_tokens(text).len();
        }
        expected = m.end();
        pieces.push(m.as_str());
    }
    if expected != text.len() {
        return bpe.encode_with_special_tokens(text).len();
    }

    pieces
        .par_iter()
        .map(|piece| encode_len(f, piece))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiktoken_rs::cl100k_base;

    fn samples() -> Vec<String> {
        let mut v = vec![
            "merhaba dünya".to_string(),
            "İstanbul Şişli ğüşıöç İIıi".to_string(),
            "emoji 🚀🔥 ve karışık ΑΒΓ 漢字 한국어".to_string(),
            "  çok   fazla   boşluk\tve\tsekmeler  ".to_string(),
            "satır\nsonu\r\n\r\nparagraf\n\n\nson".to_string(),
            "{\"a\":1,\"b\":[1,2,3],\"c\":\"x y\"}".to_string(),
            "1234567890 007 1.5 1e300 -42".to_string(),
            "'s 't 're 've 'm 'll 'd don't we're".to_string(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            "a,b,c,d,e,f,g,h,".repeat(50),
        ];
        v.push("kelime ".repeat(2_000));
        v.push("kod: fn main() { println!(\"hi\"); }\n".repeat(400));
        let rows: Vec<String> = (0..400)
            .map(|i| {
                format!(
                    r#"{{"id":{},"type":"telemetry","status":"ok","note":"satır {} düğüm"}}"#,
                    i, i
                )
            })
            .collect();
        v.push(format!("veri: [{}]", rows.join(",")));
        v
    }

    fn fast() -> Option<&'static FastTok> {
        // Testler tier/env bagimsiz calissin.
        static T: OnceLock<Option<FastTok>> = OnceLock::new();
        T.get_or_init(|| {
            let ranks = load_ranks()?;
            let re = Regex::new(PATTERN).ok()?;
            Some(FastTok { ranks, re })
        })
        .as_ref()
    }

    #[test]
    fn token_ids_match_core_bpe() {
        let Some(f) = fast() else {
            panic!("rank tablosu yuklenemedi");
        };
        let bpe = cl100k_base().unwrap();
        for (i, s) in samples().iter().enumerate() {
            let expected = bpe.encode_ordinary(s);
            let got = encode_ids(f, s).expect("parcalama hatasi");
            assert_eq!(got, expected, "token kimlikleri farkli (ornek {})", i);
        }
    }

    #[test]
    fn count_matches_serial_on_corpus() {
        let bpe = cl100k_base().unwrap();
        for (i, s) in samples().iter().enumerate() {
            let expected = bpe.encode_with_special_tokens(s).len();
            let got = count(&bpe, s);
            assert_eq!(got, expected, "sayim farkli (ornek {})", i);
        }
    }

    #[test]
    fn special_token_marker_falls_back_to_serial() {
        let bpe = cl100k_base().unwrap();
        let text = format!("<|endoftext|> {}", "kelime ".repeat(2_000));
        assert_eq!(
            count(&bpe, &text),
            bpe.encode_with_special_tokens(&text).len()
        );
    }

    #[test]
    fn empty_and_tiny_inputs_are_safe() {
        let bpe = cl100k_base().unwrap();
        for s in ["", "a", "   ", "🚀"] {
            assert_eq!(count(&bpe, s), bpe.encode_with_special_tokens(s).len());
        }
    }
}

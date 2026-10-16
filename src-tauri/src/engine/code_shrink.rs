// DENEY — kayıpsız kod daraltma (code shrink): sembol sözlüğü.
//
// Ölçülmüş gerçekler (cl100k, 2026-10):
//   - boşluk serileri zaten 1 token (4/8/12 sp = 1) → girinti kodlaması kazanç sağlamaz
//   - harf+rakam işaretçiler ("a1") 2 token → kazanç sıfır
//   - iki harfli nadir kombinasyonlar ("qx","zq"...) ve unicode tekil işaretler
//     ("§","µ","¤","·") 1 token → identifier sözlüğü çalışır
//
// Sözleşme: `expand(shrink(code)) == code` (BAYT-BAYT). LLM'e giden metin hâlâ
// kod gibi okunur (yalnızca uzun adlar kısa işaretçilere iner). Kazanç negatifse
// shrink None döner → çağıran ham kodu kullanır (hata-güvenli). Bu modül
// pipeline'a bağlı DEĞİLDİR — ölçüm deneyidir.

use std::collections::{HashMap, HashSet};
use tiktoken_rs::CoreBPE;

pub struct ShrinkOutput {
    pub header: String,
    pub body: String,
}

const MAX_SYMBOLS: usize = 24;
const MIN_WORD_CHARS: usize = 5;
const MIN_FREQ: usize = 3;

/// 1 token eden nadir iki harfli işaretçiler (kaynakta kelime olarak geçmesi
/// beklenmeyenler). Kod içi çakışma shrink içinde ölçülerek elenir.
const MARKER_POOL: [&str; 24] = [
    "qx", "qz", "qj", "xq", "zx", "jz", "vq", "wq", "kq", "qk", "xj", "jx", "vx", "xv", "wz",
    "zw", "kv", "vk", "jq", "qv", "xw", "wx", "jk", "kj",
];

pub fn shrink(code: &str, bpe: &CoreBPE) -> Option<ShrinkOutput> {
    let symbols = plan_symbols(code, bpe);
    if symbols.is_empty() {
        return None;
    }

    let mut body = code.to_string();
    let mut header = String::from("@S");
    for (marker, word) in &symbols {
        body = replace_word(&body, word, marker);
        header.push_str(&format!(" {}={}", marker, word));
    }

    // Net kazanç: toplam kısalmıyorsa vazgeç.
    let full = format!("{}\n{}", header, body);
    if count(bpe, &full) < count(bpe, code) {
        Some(ShrinkOutput { header, body })
    } else {
        None
    }
}

/// Bayt-bayt geri dönüş.
pub fn expand(header: &str, body: &str) -> String {
    let mut text = body.to_string();
    for tok in header.split_whitespace().skip(1) {
        if let Some((marker, word)) = tok.split_once('=') {
            text = replace_word(&text, marker, word);
        }
    }
    text
}

fn plan_symbols(code: &str, bpe: &CoreBPE) -> Vec<(String, String)> {
    let mut freq: HashMap<String, usize> = HashMap::new();
    let mut all_words: HashSet<String> = HashSet::new();

    let chars: Vec<char> = code.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            all_words.insert(word.clone());
            if word.chars().count() >= MIN_WORD_CHARS {
                *freq.entry(word).or_insert(0) += 1;
            }
        } else {
            i += 1;
        }
    }

    // Kazanç sırası: sıklık × (kelime token - 1).
    let mut ranked: Vec<(usize, String)> = freq
        .iter()
        .filter(|(_, &f)| f >= MIN_FREQ)
        .filter_map(|(w, &f)| {
            let wt = count(bpe, w);
            if wt < 2 {
                return None; // tek token ad işaretçiyle kazanç sağlamaz
            }
            Some(((wt - 1) * f, w.clone()))
        })
        .collect();
    ranked.sort_by_key(|b| std::cmp::Reverse(b.0));

    let mut assignments: Vec<(String, String)> = Vec::new();
    let mut used_words: HashSet<String> = HashSet::new();
    for marker in MARKER_POOL {
        if assignments.len() >= MAX_SYMBOLS {
            break;
        }
        // Çakışma: işaretçi kaynakta kelime olarak geçmemeli ve 1 token olmalı.
        if all_words.contains(marker) || code.contains(marker) || count(bpe, marker) != 1 {
            continue;
        }
        for (_, word) in &ranked {
            if used_words.contains(word) {
                continue;
            }
            used_words.insert(word.clone());
            assignments.push((marker.to_string(), word.clone()));
            break;
        }
    }
    assignments
}

/// Kelime-sınırı değiştirme (ASCII güvenli).
fn replace_word(text: &str, from: &str, to: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == from.chars().next().unwrap() {
            let end = i + from.chars().count();
            if end <= chars.len() {
                let slice: String = chars[i..end].iter().collect();
                if slice == from
                    && (i == 0 || !is_word(chars[i - 1]))
                    && (end == chars.len() || !is_word(chars[end]))
                {
                    out.push_str(to);
                    i = end;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn count(bpe: &CoreBPE, text: &str) -> usize {
    bpe.encode_with_special_tokens(text).len()
}

/// Ölçüm deneylerinde kullanılan gerçekçi Python örneği.
pub(crate) const SAMPLE: &str = r#"class ConfigurationManager:
    def __init__(self, configuration_path):
        self.configuration_path = configuration_path
        self.service_registry = {}
        self.request_timeout = 30

    def load_configuration(self, configuration_path):
        with open(configuration_path, encoding="utf-8") as configuration_file:
            for service_line in configuration_file:
                service_name, service_endpoint = service_line.strip().split("=")
                self.service_registry[service_name] = service_endpoint
        return self.service_registry

    def dispatch_request(self, request_handler):
        for service_name, service_endpoint in self.service_registry.items():
            if request_handler.matches(service_name):
                response = request_handler.execute(service_endpoint, self.request_timeout)
                return response
        raise LookupError(f"service {request_handler} not found in registry")

    def dispatch_request_again(self, request_handler):
        for service_name, service_endpoint in self.service_registry.items():
            if request_handler.matches(service_name):
                response = request_handler.execute(service_endpoint, self.request_timeout)
                return response
        raise LookupError(f"service {request_handler} not found in registry")
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn bpe() -> tiktoken_rs::CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn small_code_is_gated_by_header_cost() {
        // ~227 token'lık örnekte gövde kazancı (~20) başlık maliyetine (~24)
        // yeniyor → shrink dürüstçe None döner.
        let b = bpe();
        assert!(shrink(SAMPLE, &b).is_none(), "küçük kodda net kazanç yok");
    }

    #[test]
    fn large_code_saves_modestly_and_round_trips() {
        let b = bpe();
        let big = SAMPLE.repeat(5); // ~1100 token, aynı identifier yoğunluğu
        let before = count(&b, &big);
        let out = shrink(&big, &b).expect("büyük identifier-ağır kod kazançlı olmalı");
        let full = format!("{}\n{}", out.header, out.body);
        let after = count(&b, &full);

        // BAYT-BAYT geri dönüş
        assert_eq!(expand(&out.header, &out.body), big);

        println!("orijinal : {} token", before);
        println!("çıktı    : {} token", after);
        println!("kazanç   : %{:.1}", 100.0 * (before - after) as f64 / before as f64);
        assert!(after < before);
    }

    #[test]
    fn representation_experiments() {
        // Kaldıraç-2 ölçümleri: "temsil değiştir, içeriği değil"
        let b = bpe();
        let before = count(&b, SAMPLE);
        println!("tam kod              : {} token (baz)", before);

        // A) OUTLINE / ŞEMA: yalnızca tanım imzaları
        let outline: Vec<&str> = SAMPLE
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with("def ") || t.starts_with("class ")
            })
            .collect();
        let outline_tok = count(&b, &outline.join("\n"));
        println!("A) şema/outline      : {} token (%{:.0} — tam kodun) → tasarruf %{:.0}",
            outline_tok,
            100.0 * outline_tok as f64 / before as f64,
            100.0 * (1.0 - outline_tok as f64 / before as f64));

        // B) SKELETON: kontrol akışı hattı (yapı anahtar kelimeleri)
        let skeleton: Vec<&str> = SAMPLE
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                ["def ", "class ", "for ", "while ", "if ", "return ", "with ", "raise ", "self."]
                    .iter()
                    .any(|k| t.starts_with(k))
            })
            .collect();
        let skeleton_tok = count(&b, &skeleton.join("\n"));
        println!("B) iskelet           : {} token (%{:.0}) → tasarruf %{:.0}",
            skeleton_tok,
            100.0 * skeleton_tok as f64 / before as f64,
            100.0 * (1.0 - skeleton_tok as f64 / before as f64));

        // C) Karakter bileşimi: ağırlık nerede?
        let mut ws = 0usize;
        let mut punct = 0usize;
        let mut alnum = 0usize;
        for c in SAMPLE.chars() {
            if c.is_whitespace() { ws += 1; }
            else if c.is_ascii_alphanumeric() || c == '_' { alnum += 1; }
            else { punct += 1; }
        }
        let total = ws + punct + alnum;
        println!("C) karakter bileşimi : boşluk %{:.0}, isim/rakam %{:.0}, noktalama %{:.0} ({} karakter, yoğunluk {:.1} kar/token)",
            100.0 * ws as f64 / total as f64,
            100.0 * alnum as f64 / total as f64,
            100.0 * punct as f64 / total as f64,
            total,
            SAMPLE.chars().count() as f64 / before as f64);
    }

    #[test]
    fn indent_hierarchy_as_json_measurement() {
        // Kullanıcı hipotezi: girinti hiyerarşisini JSON tablosuna çevirip
        // @T motoruyla sıkıştırmak. Düzleştirilmiş EN İYİ senaryo:
        // her satır = {d: derinlik, t: satır metni}.
        let b = bpe();
        let unit = "    ";
        let mut rows = Vec::new();
        for line in SAMPLE.split('\n') {
            let indent: String = line.chars().take_while(|&c| c == ' ').collect();
            let depth = if indent.len() % unit.len() == 0 {
                indent.len() / unit.len()
            } else {
                0
            };
            rows.push(serde_json::json!({"d": depth, "t": &line[indent.len()..]}));
        }
        let json = serde_json::to_string(&rows).unwrap();

        let before = count(&b, SAMPLE);
        let json_tokens = count(&b, &json);
        println!("orijinal kod        : {} token", before);
        println!("JSON tablo (sıkıştırmasız): {} token", json_tokens);
        match crate::engine::jscompress::JsonCompressor::compress(&json, false) {
            Ok(c) => {
                let after = count(&b, &c);
                let diff = before as i64 - after as i64;
                println!("@T sıkıştırılmış    : {} token ({} {} token)",
                    after,
                    if diff >= 0 { "kazanç" } else { "KAYIP" },
                    diff.abs());
                println!("SONUÇ: kaynak kod {} token vs @T {} token → {}",
                    before, after,
                    if after < before { "@T kazandı (beklenmedik!)" } else { "kaynak kod daha küçük — hipotez ölçüyle reddedildi" });
            }
            Err(e) => println!("@T reddetti: {}", e),
        }
    }
}

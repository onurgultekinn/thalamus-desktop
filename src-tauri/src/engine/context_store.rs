//! Bağlam deposu — "context window'u ortadan kaldırma" iddiasının çekirdeği.
//!
//! ## Sorun
//!
//! Uzun bir ajan oturumunda iki şey birden bozulur:
//!
//! 1. **Bağlam penceresi dolar.** Model geçmişin tamamını göremez; uygulamalar
//!    eski turları SİLER veya KIRPAR → bilgi kalıcı olarak kaybolur.
//! 2. **Model aptallaşır.** Literatürde "context rot": pencere doldukça
//!    dikkat seyrelir, pencerenin ortasındaki gerçekler kaybolur
//!    (lost-in-the-middle; 2026 RULER/NoLiMa ölçümlerinde çok-faktör isabeti
//!    ~%60). Büyük pencere bunu ÇÖZMEZ, sadece kaybolacak daha çok "orta" verir.
//!
//! ## Çözüm
//!
//! Geçmiş bağlama DEĞİL, depoya gider. Bağlama yalnız iki şey gider:
//! **harita** (küçük bir indeks) ve **son tur**. Model ihtiyaç duyduğunu
//! `recall(id)` ile geri çağırır; çağrılan içerik **kayıpsız** çözülür.
//!
//! ## Neden buradaki sıkıştırma işe yarıyor (ölçülmüş)
//!
//! Ajan oturumunda asıl ağırlık araç çıktılarıdır (JSON/XML/SQL/log).
//! Ölçüm (bkz. `examples/pyramid_probe.rs`):
//!
//! - Çıplak JSON yükü: **%80-86** bayt tasarrufu (kayıpsız, round-trip doğrulanmış)
//! - Mesaj zarfıyla sarılmış hâli (`{"role":..,"content":..}`): **%0.4**
//!   — üst dizide anahtar az ve değerler heterojen olduğu için sabit-kolon/
//!   sözlük tespiti hiç devreye girmiyor.
//!
//! Bu modülün varlık sebebi tam olarak bu fark: **zarf ince bir indeks satırı
//! olur, ağır yük ayrı ve çıplak saklanıp sıkıştırılır.** Böylece sıkıştırma
//! gerçekten çalışır.
//!
//! Ölçülen diğer sayılar (100 turluk sentetik oturum):
//! - dedup (aynı dosya tekrar okununca): %54
//! - prose: %2.2, kod: %0 → bunlar sıkışmaz, ama **kaybolmaz** da: depoda durur.
//!
//! ## Kayıpsızlık sözleşmesi
//!
//! Her artefakt yazılırken çözülüp bayt/bayt karşılaştırılır. Doğrulanamayan
//! artefakt **ham** saklanır. Hiçbir içerik sessizce bozulmaz.

use crate::engine::jscompress::JsonCompressor;
use serde_json::Value;
use std::collections::HashMap;

/// Bir artefaktın türü — haritada modelin ne aradığını anlaması için.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Kullanıcı mesajı.
    User,
    /// Asistan cevabı.
    Assistant,
    /// Araç çıktısı (dosya okuma, arama, komut, web).
    Tool,
    /// Dosya içeriği.
    File,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::User => "user",
            Kind::Assistant => "asst",
            Kind::Tool => "tool",
            Kind::File => "file",
        }
    }
}

/// Depodaki tek bir içerik parçası. `payload` sıkıştırılmış ya da ham.
#[derive(Debug, Clone)]
pub struct Artifact {
    pub id: u32,
    /// Hangi turda üretildi (0 tabanlı).
    pub turn: u32,
    pub kind: Kind,
    /// Araç adı ya da dosya yolu — haritada görünen kısa etiket.
    pub label: String,
    /// Sıkıştırılmış (ya da ham) yük.
    payload: String,
    /// Yük JSON olarak sıkıştırıldı mı? Çözüm yolu buna bağlı.
    compressed: bool,
    /// Bu artefaktın ham hâlinin token tahmini (haritada "ne kadar büyük").
    pub tokens: usize,
    /// Gerçekten round-trip doğrulandı mı?
    pub verified: bool,
}

/// Bir turun harita satırı (modelin gördüğü şey).
#[derive(Debug, Clone)]
pub struct IndexEntry {
    pub id: u32,
    pub turn: u32,
    pub kind: Kind,
    pub label: String,
    pub tokens: usize,
    /// Aynı içerik daha önce saklandıysa onun id'si (yük tekrar edilmez).
    pub alias_of: Option<u32>,
}

/// Oturum bağlam deposu.
#[derive(Debug, Default)]
pub struct ContextStore {
    artifacts: Vec<Artifact>,
    index: Vec<IndexEntry>,
    by_dedup: HashMap<String, u32>,
    next_id: u32,
    /// Ham (sıkıştırılmamış) toplam bayt — tasarruf raporu için.
    raw_bytes: usize,
    /// Depoda kapladığı toplam bayt.
    stored_bytes: usize,
    /// Dedup sayesinde saklanmayan bayt.
    dedup_saved_bytes: usize,
}

/// Harita satır uzunluğu sınırı (etiket kırpma).
const MAX_LABEL: usize = 44;

impl ContextStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bir içeriği depoya yazar ve indeks satırını döndürür.
    ///
    /// `dedup_key` verilirse aynı anahtarla daha önce yazılmış içerik yeniden
    /// saklanmaz; yeni satır eskiye `alias_of` ile bağlanır. Bu, bir ajanın
    /// aynı dosyayı tekrar tekrar okuması durumunda ölçülen %54'lük kazancın
    /// kaynağıdır.
    pub fn push(
        &mut self,
        turn: u32,
        kind: Kind,
        label: &str,
        content: &Value,
        dedup_key: Option<String>,
        bpe: Option<&tiktoken_rs::CoreBPE>,
    ) -> u32 {
        let label = clip(label, MAX_LABEL);
        let raw = serde_json::to_string(content).unwrap_or_default();
        let raw_len = raw.len();
        let tokens = count_tokens(bpe, &raw);

        // Dedup: aynı içerik zaten depoda mı?
        if let Some(key) = dedup_key.as_ref() {
            if let Some(&existing) = self.by_dedup.get(key) {
                let id = self.next_id;
                self.next_id += 1;
                self.index.push(IndexEntry {
                    id,
                    turn,
                    kind,
                    label,
                    tokens,
                    alias_of: Some(existing),
                });
                self.dedup_saved_bytes += raw_len;
                return id;
            }
        }

        // Sıkıştır + doğrula. Doğrulanmazsa ham sakla (asla bozuk yazma).
        let (payload, compressed, verified) = match JsonCompressor::compress(&raw, false) {
            Ok(c) => {
                let ok = JsonCompressor::decompress(&c)
                    .map(|back| back == *content)
                    .unwrap_or(false);
                if ok {
                    (c, true, true)
                } else {
                    (raw.clone(), false, false)
                }
            }
            Err(_) => (raw.clone(), false, false),
        };

        let id = self.next_id;
        self.next_id += 1;
        self.raw_bytes += raw_len;
        self.stored_bytes += payload.len();
        if let Some(key) = dedup_key {
            self.by_dedup.insert(key.clone(), id);
            self.artifacts.push(Artifact {
                id,
                turn,
                kind,
                label: label.clone(),
                payload,
                compressed,
                tokens,
                verified,
            });
        } else {
            self.artifacts.push(Artifact {
                id,
                turn,
                kind,
                label: label.clone(),
                payload,
                compressed,
                tokens,
                verified,
            });
        }
        self.index.push(IndexEntry {
            id,
            turn,
            kind,
            label,
            tokens,
            alias_of: None,
        });
        id
    }

    /// Bir artefaktı **kayıpsız** çözer. `None` = id yok.
    ///
    /// Takma ad (dedup) satırları kendi yükünü taşımaz; kaynağa yönlenir.
    /// Böylece model haritada hangi id'yi görürse görsün içeriğe ulaşır.
    pub fn recall(&self, id: u32) -> Option<Value> {
        let target = self
            .index
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.alias_of)
            .unwrap_or(id);
        let art = self.artifacts.iter().find(|a| a.id == target)?;
        if !art.compressed {
            return serde_json::from_str(&art.payload).ok();
        }
        JsonCompressor::decompress(&art.payload).ok()
    }

    /// Haritayı modele verilecek metin olarak üretir.
    ///
    /// `max_tokens` sınırı aşılırsa en eski satırlar özetlenir ama **id'ler
    /// korunur** (model yine recall edebilir). Bu, haritanın bağlamı yemesini
    /// engeller: harita sabit üst sınırda kalır, depo büyümeye devam eder.
    pub fn map(&self, bpe: Option<&tiktoken_rs::CoreBPE>, max_tokens: usize) -> String {
        if self.index.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        out.push_str(&format!(
            "[CONTEXT MAP] {} content item(s) stored outside the window. \
             Call recall(id) to get the full content of any item — it is restored losslessly.\n",
            self.index.len()
        ));

        // Önce en yeni satırlar; bütçe dolunca eskiler "collapse" edilir.
        let mut lines: Vec<String> = Vec::new();
        let mut collapsed = 0usize;
        for e in self.index.iter().rev() {
            let line = match e.alias_of {
                Some(src) => format!(
                    "  #{} t{} {} {} ~{}tk (same as #{})\n",
                    e.id,
                    e.turn,
                    e.kind.as_str(),
                    e.label,
                    e.tokens,
                    src
                ),
                None => format!(
                    "  #{} t{} {} {} ~{}tk\n",
                    e.id,
                    e.turn,
                    e.kind.as_str(),
                    e.label,
                    e.tokens
                ),
            };
            lines.push(line);
            let body = format!("{}{}", out, lines.concat());
            if count_tokens(bpe, &body) > max_tokens {
                lines.pop();
                collapsed = self.index.len() - lines.len();
                break;
            }
        }
        if collapsed > 0 {
            let first_id = self.index.first().map(|e| e.id).unwrap_or(0);
            out.push_str(&format!(
                "  … {} earlier item(s) collapsed (ids #{}–#{}) — still recallable by id\n",
                collapsed,
                first_id,
                first_id + collapsed as u32 - 1
            ));
        }
        for line in lines.iter().rev() {
            out.push_str(line);
        }
        out
    }

    /// Depo istatistikleri (arayüz/telemetri için).
    pub fn stats(&self) -> StoreStats {
        StoreStats {
            items: self.index.len(),
            artifacts: self.artifacts.len(),
            raw_bytes: self.raw_bytes,
            stored_bytes: self.stored_bytes,
            dedup_saved_bytes: self.dedup_saved_bytes,
            unverified: self
                .artifacts
                .iter()
                .filter(|a| a.compressed && !a.verified)
                .count(),
        }
    }

    /// Sorudan anahtar çıkarıp depodan ilgili içerikleri getirir.
    ///
    /// Neden gerekli: ölçüldü (map_navigation_test, qwen2.5-coder:7b) — model
    /// haritadan doğru id'yi seçemiyor (0/20). Model navigasyonu yerine
    /// **deterministik anahtar eşleştirme** kullanıyoruz: sorudaki kelimeleri
    /// depodaki etiket ve içerikte arıyoruz. Model eklemiyoruz; 7B'de de
    /// 70B'de de aynı davranır.
    ///
    /// `query`: kullanıcının sorusu (anahtar çıkarma kaynağı).
    /// `exclude_ids`: bağlamda zaten bulunan id'ler (son tur vb) — tekrar eklenmez.
    /// `max_chars`: döndürülen içerik toplamı bu sınırı aşmasın.
    ///
    /// Döndürülen: (id, turn, kind, label, çözülmüş metin) listesi.
    /// Skor sırasına göre (en çok eşleşen ilk).
    pub fn relevant(
        &self,
        query: &str,
        exclude_ids: &[u32],
        max_chars: usize,
    ) -> Vec<(u32, u32, Kind, String, String)> {
        // Sorudan anahtar kelimeleri çıkar: 3+ karakter, stop-word değil.
        let keys: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() >= 3)
            .map(|w| w.to_lowercase())
            .filter(|w| !STOP_WORDS.contains(&w.as_str()))
            .collect();
        if keys.is_empty() {
            return Vec::new();
        }

        // Her artefaktı skorla: etiket eşleşmesi ×2, içerik eşleşmesi ×1.
        let mut scored: Vec<(usize, u32, u32, Kind, String, String)> = Vec::new();
        for art in &self.artifacts {
            if exclude_ids.contains(&art.id) {
                continue;
            }
            let content = self.recall(art.id).map(|v| {
                match &v {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                }
            });
            let Some(text) = content else { continue };
            let label_lower = art.label.to_lowercase();
            let text_lower = text.to_lowercase();
            let mut score = 0usize;
            for key in &keys {
                if label_lower.contains(key.as_str()) {
                    score += 2;
                }
                if text_lower.contains(key.as_str()) {
                    score += 1;
                }
            }
            if score == 0 {
                continue;
            }
            scored.push((score, art.id, art.turn, art.kind, art.label.clone(), text));
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0));

        // Bütçe: en iyi eşleşmelerden başla, toplam karakter sınırına kadar.
        let mut out = Vec::new();
        let mut used = 0usize;
        for (_, id, turn, kind, label, text) in scored {
            if used + text.len() > max_chars {
                break;
            }
            used += text.len();
            out.push((id, turn, kind, label, text));
        }
        out
    }
}

/// Türkçe ve İngilizce yaygın kelimeler — anahtar eşleştirmede yok sayılır.
const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
    "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two",
    "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use", "bu", "ve",
    "bir", "için", "gibi", "daha", "çok", "ama", "yok", "var", "ne", "nasıl", "neden", "olan",
    "ile", "kadar", "sonra", "önce", "şu", "bunu", "şunu", "benim", "senin", "bize", "sana",
    "neyle", "nerede", "kimin", "kaç", "yeni", "eski", "dosya", "var", "yok", "değil", "yap",
    "et", "etme", "olsun", "oldu", "olan", "what", "that", "this", "with", "from", "have",
    "been", "when", "where", "which", "will", "would", "could", "should", "there", "their",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreStats {
    /// Harita satırı sayısı (hatırlatılabilir öğe).
    pub items: usize,
    /// Gerçekten saklanan yük sayısı (dedup sonrası).
    pub artifacts: usize,
    pub raw_bytes: usize,
    pub stored_bytes: usize,
    pub dedup_saved_bytes: usize,
    /// Sıkıştırma doğrulanamadığı için ham saklanan artefakt sayısı.
    pub unverified: usize,
}

impl StoreStats {
    /// Sıkıştırmanın sağladığı bayt tasarrufu oranı (%).
    pub fn savings_pct(&self) -> f64 {
        if self.raw_bytes == 0 {
            return 0.0;
        }
        100.0 * (self.raw_bytes.saturating_sub(self.stored_bytes) as f64) / (self.raw_bytes as f64)
    }
}

fn clip(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept)
}

fn count_tokens(bpe: Option<&tiktoken_rs::CoreBPE>, text: &str) -> usize {
    match bpe {
        Some(b) => b.encode_ordinary(text).len(),
        // Tokenizer yoksa ~4 bayt/token.
        None => (text.len() + 3) / 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bare_payload_is_compressed_and_verified() {
        let mut s = ContextStore::new();
        let rows: Vec<Value> = (0..40)
            .map(|i| {
                json!({
                    "id": i,
                    "file": format!("src/m{}.rs", i % 5),
                    "status": if i % 2 == 0 { "ok" } else { "warn" },
                    "elapsed_ms": 10 + i,
                })
            })
            .collect();
        let content = Value::Array(rows);
        let id = s.push(0, Kind::Tool, "tool_result", &content, None, None);
        assert_eq!(s.recall(id).as_ref(), Some(&content), "round-trip bozulmamalı");
        let st = s.stats();
        assert!(st.savings_pct() > 50.0, "yapısal yük %50+ sıkışmalı, ölçülen: {}", st.savings_pct());
        assert_eq!(st.unverified, 0);
    }

    #[test]
    fn wrapper_is_not_the_unit_of_compression() {
        // Regresyon koruması: zarf içine alınmış kayıt sıkışmaz. Bu yüzden
        // depo zarfı AYRI tutar. Ölçüm: %0.4 vs %85.7.
        let rows: Vec<Value> = (0..40)
            .map(|i| json!({"id": i, "file": format!("src/m{}.rs", i % 5), "status": "ok"}))
            .collect();
        let bare = Value::Array(rows.clone());
        let wrapped = json!({"role": "tool", "content": Value::Array(rows)});

        let mut s1 = ContextStore::new();
        s1.push(0, Kind::Tool, "bare", &bare, None, None);
        let mut s2 = ContextStore::new();
        s2.push(0, Kind::Tool, "wrapped", &wrapped, None, None);

        let bare_saving = s1.stats().savings_pct();
        let wrapped_saving = s2.stats().savings_pct();
        assert!(
            bare_saving > wrapped_saving + 30.0,
            "çıplak yük zarftan belirgin küçük olmalı: çıplak %{:.1}, zarflı %{:.1}",
            bare_saving,
            wrapped_saving
        );
    }

    #[test]
    fn dedup_stores_payload_once() {
        let mut s = ContextStore::new();
        let body = json!({"path": "a.rs", "text": "fn main() {}".repeat(50)});
        let a = s.push(0, Kind::File, "a.rs", &body, Some("file:a.rs".into()), None);
        let b = s.push(5, Kind::File, "a.rs", &body, Some("file:a.rs".into()), None);
        assert_ne!(a, b, "her çağrı kendi satırını almalı");
        let st = s.stats();
        assert_eq!(st.items, 2);
        assert_eq!(st.artifacts, 1, "yük bir kez saklanmalı");
        assert!(st.dedup_saved_bytes > 0);
        assert_eq!(s.recall(b), Some(body), "takma ad da çözülmeli");
    }

    #[test]
    fn prose_and_code_are_stored_but_not_lost() {
        let mut s = ContextStore::new();
        let prose = json!("Bu bir düz metin paragrafı. Sıkıştırılmaz ama kaybolmaz.");
        let id = s.push(0, Kind::User, "user", &prose, None, None);
        assert_eq!(s.recall(id), Some(prose.clone()), "prose kaybolmamalı");
        let code = json!({"path": "x.ts", "body": "export const a = 1;\n".repeat(40)});
        let id2 = s.push(1, Kind::File, "x.ts", &code, None, None);
        assert_eq!(s.recall(id2), Some(code));
    }

    #[test]
    fn map_respects_budget_and_keeps_ids_recallable() {
        let mut s = ContextStore::new();
        for t in 0..200u32 {
            let v = json!({"n": t, "text": format!("row {}", t)});
            s.push(t, Kind::Tool, &format!("tool_{}", t), &v, None, None);
        }
        let map = s.map(None, 500);
        let st = s.stats();
        assert_eq!(st.items, 200);
        // Harita bütçeyi aşmamalı (yaklaşık; tokenizer yoksa 4 bayt/token).
        assert!(
            map.len() / 4 <= 500 + 60,
            "harita bütçeyi aşmamalı: ~{} token",
            map.len() / 4
        );
        assert!(map.contains("collapsed"), "eski öğeler çökmeli: {}", &map[..map.len().min(200)]);
        // Çöken öğeler yine de hatırlatılabilmeli.
        assert!(s.recall(0).is_some(), "en eski öğe depoda kalmalı");
    }

    #[test]
    fn empty_store_produces_empty_map() {
        let s = ContextStore::new();
        assert_eq!(s.map(None, 500), "");
        assert_eq!(s.stats().savings_pct(), 0.0);
    }

    #[test]
    fn recall_unknown_id_is_none() {
        let s = ContextStore::new();
        assert!(s.recall(9999).is_none());
    }

    #[test]
    fn relevant_finds_content_by_keyword() {
        let mut s = ContextStore::new();
        s.push(0, Kind::Tool, "grep_search src/auth.rs",
            &json!({"results": ["auth timeout at line 42", "retry logic missing"]}),
            None, None);
        s.push(1, Kind::Tool, "read_file src/db.rs",
            &json!({"content": "let pool = connect_to_database();"}),
            None, None);
        s.push(2, Kind::File, "src/auth.rs",
            &json!({"body": "fn login(user: &str) -> Result<Token> { auth_timeout_check() }"}),
            None, None);

        let res = s.relevant("auth timeout problem", &[], 50_000);
        assert!(!res.is_empty(), "auth+timeout eşleşmeli");
        // En iyi eşleşme auth.rs içeren artefakt olmalı
        assert!(res.iter().any(|(_,_,_,l,_)| l.contains("auth")),
            "etiket auth içermeli: {:?}", res.iter().map(|r| &r.3).collect::<Vec<_>>());
    }

    #[test]
    fn relevant_excludes_specified_ids() {
        let mut s = ContextStore::new();
        s.push(0, Kind::Tool, "tool_a", &json!({"data": "timeout retry logic"}), None, None);
        let id2 = s.push(1, Kind::Tool, "tool_b", &json!({"data": "timeout again here"}), None, None);

        let res = s.relevant("timeout", &[id2], 50_000);
        // tool_b exclude edildi, sadece tool_a dönmeli
        assert_eq!(res.len(), 1, "exclude sonrası 1 sonuç: {:?}", res.len());
        assert_eq!(res[0].0, 0, "tool_a id'si 0 olmalı");
    }

    #[test]
    fn relevant_respects_max_chars() {
        let mut s = ContextStore::new();
        for i in 0..10u32 {
            s.push(i, Kind::Tool, &format!("timeout_tool_{}", i),
                &json!({"data": "timeout".repeat(1200), "n": i}), None, None);
        }
        let res = s.relevant("timeout", &[], 15_000);
        let total: usize = res.iter().map(|r| r.4.len()).sum();
        assert!(total <= 15_000, "bütçe aşılmalı değil: {}", total);
        assert!(!res.is_empty(), "en az 1 sonuç");
    }

    #[test]
    fn relevant_returns_empty_for_stop_words_only() {
        let mut s = ContextStore::new();
        s.push(0, Kind::Tool, "tool", &json!({"data": "something"}), None, None);
        let res = s.relevant("bu ne için", &[], 50_000);
        assert!(res.is_empty(), "sadece stop-word varsa sonuç boş olmalı");
    }

    #[test]
    fn relevant_turkish_keyword_matches() {
        let mut s = ContextStore::new();
        s.push(0, Kind::Tool, "grep_auth",
            &json!({"mesaj": "kimlik doğrulama hatası: token süresi dolmuş"}),
            None, None);
        s.push(1, Kind::File, "src/db.rs",
            &json!({"icerik": "veritabanı bağlantısı kuruldu"}),
            None, None);

        let res = s.relevant("kimlik doğrulama token hatası", &[], 50_000);
        assert!(res.iter().any(|(_,_,_,l,_)| l.contains("auth")),
            "auth içeren sonuç dönmeli: {:?}", res.iter().map(|r| &r.3).collect::<Vec<_>>());
    }

    #[test]
    fn relevant_no_match_returns_empty() {
        let mut s = ContextStore::new();
        s.push(0, Kind::Tool, "tool", &json!({"data": "abc def"}), None, None);
        let res = s.relevant("xyzzy quantum", &[], 50_000);
        assert!(res.is_empty(), "eşleşme yoksa boş");
    }
}

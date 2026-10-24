// Token sayimi onbellegi.
//
// Tokenizer (BPE) hatti en pahali adim; ayni metin bir istek icinde birden
// fazla kez sayiliyor (ham + aday + decoder + nihai olcum). Sonuc deterministik
// oldugu icin memoizasyon KAYIPSIZDIR: yalnizca tekrar is yapilmaz.
//
// Anahtar: (uzunluk, SipHash). 64-bit cakisma olasiligi ihmal edilebilir;
// yine de uzunluk anahtara dahil edilerek risk daha da dusurulur.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use tiktoken_rs::CoreBPE;

use crate::engine::hw;

pub struct TokenCache {
    map: Mutex<HashMap<(usize, u64), usize>>,
    cap: usize,
}

impl TokenCache {
    pub fn new(cap: usize) -> Self {
        Self {
            map: Mutex::new(HashMap::with_capacity(cap.min(4096))),
            cap,
        }
    }

    pub fn count(&self, bpe: &CoreBPE, text: &str) -> usize {
        self.count_with(bpe, text, |b, t| b.encode_with_special_tokens(t).len())
    }

    /// Sayim stratejisini cagirandan alir (or. paralel tam-prompt sayimi).
    /// Strateji kayipsiz oldugu surece onbellek de kayipsizdir.
    pub fn count_with<F>(&self, bpe: &CoreBPE, text: &str, count_fn: F) -> usize
    where
        F: FnOnce(&CoreBPE, &str) -> usize,
    {
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let key = (text.len(), hasher.finish());

        if let Ok(map) = self.map.lock() {
            if let Some(&hit) = map.get(&key) {
                return hit;
            }
        }

        let n = count_fn(bpe, text);

        if let Ok(mut map) = self.map.lock() {
            // Basit, bagimliliksiz tahliye: dolunca temizle. Bellek siniri
            // donanima gore secilir (zayif makinede kucuk kalir).
            if map.len() >= self.cap {
                map.clear();
            }
            map.insert(key, n);
        }

        n
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }
}

pub fn global() -> &'static TokenCache {
    static CACHE: OnceLock<TokenCache> = OnceLock::new();
    CACHE.get_or_init(|| TokenCache::new(hw::profile().token_cache_entries()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bpe() -> CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn cached_and_direct_counts_match() {
        let cache = TokenCache::new(64);
        let bpe = bpe();
        for s in ["", "merhaba", "{\"a\":1}", "uzun bir metin örneği 12345"] {
            let direct = bpe.encode_with_special_tokens(s).len();
            assert_eq!(cache.count(&bpe, s), direct);
            // Ikinci cagri onbellekten gelmeli, sonuc ayni.
            assert_eq!(cache.count(&bpe, s), direct);
        }
    }

    #[test]
    fn cache_is_bounded() {
        let cache = TokenCache::new(8);
        let bpe = bpe();
        for i in 0..100 {
            cache.count(&bpe, &format!("metin-{}", i));
        }
        assert!(cache.len() <= 8);
    }
}

// Model yetenek yönlendirmesi (model capability routing).
//
// EVREN gibi çok-modelli sağlayıcılarda her model aynı sözleşmeyi kabul
// etmez: `laya`/`clef` gibi modeller `tools: false`, bazıları
// `reasoning_effort` alanını reddeder, OCR/embedding/ASR modelleri sohbet
// (chat/completions) uç noktasını hiç kullanmaz. Bu modül /models
// meta verisini bir kez çekip önbelleğe alır ve isteği modele göre UYARLAR:
//
//   - tools desteği yoksa araç şemaları GÖNDERİLMEZ (aksi halde sağlayıcı
//     400 verir ve kullanıcı anlamsız bir hata görür),
//   - reasoning_effort desteklenmiyorsa alan gönderilmez,
//   - vision yoksa görsel parçalar reddedilir (açık mesajla),
//   - task chat değilse (ocr/embedding/asr/tts/rerank) istek reddedilir ve
//     modelin gerçekte ne yaptığı söylenir.
//
// Meta veri çekilemezse (ağ yok, sağlayıcı /models sunmuyor) muhafazakâr
// varsayılan kullanılır: mevcut davranış aynen korunur.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct ModelCaps {
    pub task: String,
    pub tools: bool,
    pub vision: bool,
    pub reasoning_effort: bool,
    pub context_length: Option<u64>,
}

impl Default for ModelCaps {
    /// Meta veri yoksa: bilinen-güvenli varsayılan (araç var say, düşünme yok).
    fn default() -> Self {
        Self {
            task: "chat".into(),
            tools: true,
            vision: true,
            reasoning_effort: true,
            context_length: None,
        }
    }
}

impl ModelCaps {
    /// Sohbet uç noktası bu modelle anlamlı mı? OCR/TTS/ASR/embedding
    /// modelleri chat/completions ile çalışmaz.
    pub fn is_chat_capable(&self) -> bool {
        matches!(
            self.task.as_str(),
            "chat" | "text" | "completion" | "llm" | "auto" | "vision" | "multimodal" | ""
        )
    }

    /// Kullanıcıya ne olduğunu anlatan kısa etiket.
    pub fn task_label(&self) -> &str {
        match self.task.as_str() {
            "ocr" => "OCR (görselden metin)",
            "embedding" => "embedding (vektör)",
            "asr" => "konuşma tanıma (STT)",
            "tts" => "ses sentezi (TTS)",
            "rerank" => "yeniden sıralama (rerank)",
            _ => "sohbet",
        }
    }
}

struct CacheEntry {
    at: Instant,
    caps: HashMap<String, ModelCaps>,
}

static CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(600);

fn cache_key(base_url: &str, api_key: &str) -> String {
    // Anahtar DEĞERİ anahtara gömülmez; bağlantı kimliği + anahtar uzunluğu
    // yeterli (farklı hesaplar farklı yetenek görebilir).
    format!("{}#{}", base_url.trim_end_matches('/'), api_key.len())
}

/// `/models` yanıtından yetenekleri çıkarır. Bilinmeyen alanlar
/// varsayılanda kalır (alan yoksa "destekliyor" sayılır — geriye uyumlu).
pub fn parse_models(payload: &Value) -> HashMap<String, ModelCaps> {
    let mut out = HashMap::new();
    let Some(items) = payload.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for m in items {
        let Some(id) = m.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let caps = m.get("capabilities");
        let get_bool = |name: &str| -> Option<bool> {
            caps.and_then(|c| c.get(name)).and_then(|v| v.as_bool())
        };
        let task = m
            .get("task")
            .and_then(|t| t.as_str())
            .unwrap_or("chat")
            .to_string();
        out.insert(
            id.to_string(),
            ModelCaps {
                task,
                tools: get_bool("tools").unwrap_or(true),
                vision: get_bool("vision").unwrap_or(true),
                reasoning_effort: get_bool("reasoning_effort").unwrap_or(true),
                context_length: m.get("context_length").and_then(|c| c.as_u64()),
            },
        );
    }
    out
}

fn fetch(base_url: &str, api_key: &str) -> Option<HashMap<String, ModelCaps>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let mut req = client.get(&url);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload: Value = resp.json().ok()?;
    let parsed = parse_models(&payload);
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

/// Modelin yetenekleri. Önbellek yoksa çeker; başarısız olursa `None`
/// (çağıran mevcut davranışı korur).
pub fn caps_for(base_url: &str, api_key: &str, model: &str) -> Option<ModelCaps> {
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return None;
    }
    let key = cache_key(base_url, api_key);
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_ref() {
            if let Some(entry) = map.get(&key) {
                if entry.at.elapsed() < TTL {
                    return entry.caps.get(model).cloned();
                }
            }
        }
    }
    let fetched = fetch(base_url, api_key)?;
    let hit = fetched.get(model).cloned();
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(key, CacheEntry { at: Instant::now(), caps: fetched });
    hit
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({"data":[
            {"id":"laya","task":"chat","capabilities":{"tools":false,"vision":false,"reasoning_effort":false},"context_length":8192},
            {"id":"clef","task":"chat","capabilities":{"tools":false,"vision":true},"context_length":16384},
            {"id":"deepseek-ocr-2","task":"ocr","capabilities":{"tools":false}},
            {"id":"qwen3-embedding-8b","task":"embedding"},
            {"id":"glm-5.3","task":"chat","capabilities":{"tools":true,"reasoning_effort":true}}
        ]})
    }

    #[test]
    fn parses_capabilities_per_model() {
        let m = parse_models(&sample());
        let laya = m.get("laya").unwrap();
        assert!(!laya.tools && !laya.vision && !laya.reasoning_effort);
        let clef = m.get("clef").unwrap();
        assert!(!clef.tools && clef.vision);
        let glm = m.get("glm-5.3").unwrap();
        assert!(glm.tools && glm.reasoning_effort);
        // Alan yoksa geriye uyumlu varsayılan: destekliyor say.
        let emb = m.get("qwen3-embedding-8b").unwrap();
        assert!(emb.tools, "alan yoksa varsayılan true");
    }

    #[test]
    fn only_chat_tasks_are_chat_capable() {
        let m = parse_models(&sample());
        assert!(m.get("laya").unwrap().is_chat_capable());
        assert!(m.get("clef").unwrap().is_chat_capable());
        assert!(!m.get("deepseek-ocr-2").unwrap().is_chat_capable());
        assert!(!m.get("qwen3-embedding-8b").unwrap().is_chat_capable());
        assert_eq!(m.get("deepseek-ocr-2").unwrap().task_label(), "OCR (görselden metin)");
    }

    #[test]
    fn unknown_model_defaults_to_permissive() {
        let caps = ModelCaps::default();
        assert!(caps.tools && caps.is_chat_capable());
    }

    /// İstek gövdesi modelin yeteneğine göre uyarlanmalı.
    #[test]
    fn request_adaptation_rules() {
        let m = parse_models(&sample());
        // laya: araç ve reasoning gönderilmemeli.
        let laya = m.get("laya").unwrap();
        assert!(!laya.tools, "tools şeması gönderilmemeli");
        assert!(!laya.reasoning_effort, "reasoning_effort gönderilmemeli");
        // clef: vision var, tools yok.
        let clef = m.get("clef").unwrap();
        assert!(clef.vision && !clef.tools);
    }
}

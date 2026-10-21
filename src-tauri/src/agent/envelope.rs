// AEP — Ajan Zarf Protokolü (Agent Envelope Protocol).
//
// Farkımız: ajanlar birbirleriyle SERBEST METİN konuşmaz. Her tur, tek bir
// tipli JSON zarfıdır ve zarfın TEL biçimi mevcut kayıpsız @T motorundan
// geçirilir. İnsan-okur metin yalnızca ARAYÜZDE türetilir; taşıma katmanı
// JSON'dur. Bu, ajan-arası bağlamı hem tipli (şema-doğrulanabilir) hem de
// ucuz (token-tasarruflu) kılar.
//
// Sorumluluk ayrımı (ribozym §14 ruhu): model YALNIZ
// `{"status": "...", "payload": {...}}` üretir. Zarfın kimlik/rota/seq
// alanlarını MAKİNE yazar — model değil. Böylece modelin uydurabileceği
// alan sayısı en aza iner.

use crate::engine::JsonCompressor;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tiktoken_rs::CoreBPE;

pub const PROTOCOL_VERSION: u32 = 1;

/// Tel üzerinden geçen tam zarf. `raw` = çözülmüş hali (UI'da "Doğal"),
/// `wire` = motorun ürettiği sıkıştırılmış JSON (UI'da "Tel").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentEnvelope {
    pub v: u32,
    pub id: String,
    pub run: String,
    pub from: String,
    pub to: Vec<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    pub status: String,
    pub payload: Value,
}

/// Motor çıktısı: zarfın tel biçimi + bilanço.
#[derive(Debug, Clone)]
pub struct WirePayload {
    /// Sonraki ajana GÖNDERİLEN metin: sıkıştırma kazançlıysa @T, değilse ham JSON.
    pub wire: String,
    /// Sıkıştırılmamış JSON'un token sayısı (referans maliyet).
    pub raw_tokens: usize,
    /// Tel biçiminin token sayısı (gerçek maliyet).
    pub wire_tokens: usize,
    pub compressed: bool,
    /// Sıkıştırma kabul edildiyse round-trip kayıpsızlığı doğrulandı mı.
    pub lossless: bool,
}

/// Metinden tek bir JSON nesnesi çıkarır: ```json fence'lerini ve çevre
/// metnini tolere eder (model sözleşmeye uysa da uymasa da en iyi çabayı
/// gösterir; son söz `validate_reply`te).
pub fn extract_json_object(content: &str) -> Option<Value> {
    // Fence varsa içeriğini al; yoksa ham metni kullan.
    let candidate = if let Some(start) = content.find("```") {
        let after = &content[start + 3..];
        let after = after.split_once('\n').map(|(_, r)| r).unwrap_or(after);
        match after.find("```") {
            Some(end) => &after[..end],
            None => after,
        }
    } else {
        content
    };
    let s = candidate.trim();
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        if v.is_object() {
            return Some(v);
        }
    }
    // En geniş nesne aralığını dene (çevre metni/bozuk süslemeler).
    let first = s.find('{')?;
    let last = s.rfind('}')?;
    if last <= first {
        return None;
    }
    serde_json::from_str::<Value>(&s[first..=last]).ok().filter(Value::is_object)
}

/// Model yanıtını doğrular ve zarfın GÖVDESİNİ çıkarır: `{"status","payload"}`.
/// Zarfın kimlik/rota alanları burada YOK — onları orkestratör yazar.
pub fn validate_reply(content: &str) -> Result<(String, Value), String> {
    let obj = extract_json_object(content)
        .ok_or_else(|| "reply is not a JSON object".to_string())?;
    let payload = obj
        .get("payload")
        .cloned()
        .ok_or_else(|| "missing required field: payload".to_string())?;
    if !payload.is_object() && !payload.is_array() {
        return Err("payload must be an object or array".into());
    }
    let status = obj
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("ok")
        .to_string();
    let status = match status.as_str() {
        "ok" | "warn" | "fail" => status,
        _ => "ok".to_string(),
    };
    Ok((status, payload))
}

/// Zarfın tel biçimini üretir.
///
/// Önemli: motorun @T kodlayıcısı YALNIZCA üst-düzey nesne DİZİLERİNİ sıkıştırır
/// (kolonlu kayıt tabloları). Bu yüzden protokol, ajan yüklerini kolonlu kayıt
/// dizileri olarak tanımlar; tel biçimi zarfın `data` alanını bu dizinin
/// sıkıştırılmış (veya ham) haliyle taşır. Sıkıştırma kazanç sağlamıyorsa ham
/// zarf dürüstçe geçer — sahte tasarruf yok.
pub fn encode_wire(env: &AgentEnvelope, bpe: &CoreBPE) -> WirePayload {
    let raw_json = serde_json::to_string(env).unwrap_or_default();
    let raw_tokens = crate::engine::code_shrink::count(bpe, &raw_json);

    let payload_json = serde_json::to_string(&env.payload).unwrap_or_default();
    let mut enc = "json";
    let mut data: Value = env.payload.clone();
    let mut compressed = false;
    let mut lossless = false;

    if let Ok(candidate) = JsonCompressor::compress(&payload_json, false) {
        if candidate != payload_json {
            // Kayıpsızlık: geri açıp birebir karşılaştır (motorun sözleşmesi).
            let round_trip_ok = JsonCompressor::decompress(&candidate)
                .ok()
                .map(|v| v == env.payload)
                .unwrap_or(false);
            if round_trip_ok {
                enc = "@t";
                data = Value::String(candidate);
                compressed = true;
                lossless = true;
            }
        }
    }

    let wire_obj = serde_json::json!({
        "v": env.v,
        "id": env.id,
        "run": env.run,
        "from": env.from,
        "to": env.to,
        "kind": env.kind,
        "task": env.task,
        "ref": env.r#ref,
        "status": env.status,
        "enc": enc,
        "data": data,
    });
    let wire = serde_json::to_string(&wire_obj).unwrap_or_default();
    let wire_tokens = crate::engine::code_shrink::count(bpe, &wire);

    if !compressed || wire_tokens >= raw_tokens {
        // Net kazanç yok → ham zarf (decoder satırı maliyeti boşa çıkmasın).
        return WirePayload {
            wire: raw_json,
            raw_tokens,
            wire_tokens: raw_tokens,
            compressed: false,
            lossless: false,
        };
    }

    WirePayload {
        wire,
        raw_tokens,
        wire_tokens,
        compressed: true,
        lossless,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bpe() -> CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    fn sample_plan_env() -> AgentEnvelope {
        // Kolonlu kayıt dizisi: motorun en iyi sıkıştırdığı biçim.
        let tasks: Vec<Value> = (0..6)
            .map(|i| {
                json!({
                    "id": format!("t{}", i + 1),
                    "title": format!("Refactor module {}", i + 1),
                    "files": "src/components/Panel.tsx|src/lib/util.ts|src/services/client.ts",
                    "deps": if i == 0 { String::new() } else { format!("t{}", i) },
                    "est": 400 + i * 10,
                    "risk": "low"
                })
            })
            .collect();
        AgentEnvelope {
            v: PROTOCOL_VERSION,
            id: "e-1".into(),
            run: "r-1".into(),
            from: "planner".into(),
            to: vec!["coder".into()],
            kind: "plan".into(),
            task: None,
            r#ref: None,
            status: "ok".into(),
            payload: Value::Array(tasks),
        }
    }

    #[test]
    fn columnar_plan_payload_compresses_losslessly() {
        let env = sample_plan_env();
        let w = encode_wire(&env, &bpe());
        assert!(w.compressed, "kolonlu plan yükü @T ile sıkışmalı");
        assert!(w.lossless, "sıkıştırma kayıpsız doğrulanmalı");
        assert!(w.wire_tokens < w.raw_tokens);
        // Tel biçimindeki `data` gerçekten geri açılabilmeli.
        let wire: Value = serde_json::from_str(&w.wire).unwrap();
        assert_eq!(wire["enc"], json!("@t"));
        let back = JsonCompressor::decompress(wire["data"].as_str().unwrap()).unwrap();
        assert_eq!(back, env.payload);
    }

    #[test]
    fn non_columnar_payload_passes_through_honestly() {
        // Nesne yükü (üst-düzey dizi değil) sıkışmaz → ham zarf geçer.
        let mut env = sample_plan_env();
        env.payload = json!({"summary": "tek nesne"});
        let w = encode_wire(&env, &bpe());
        assert!(!w.compressed);
        assert_eq!(w.wire_tokens, w.raw_tokens);
    }

    #[test]
    fn validate_reply_accepts_minimal_contract() {
        let (status, payload) = validate_reply(r#"{"status":"warn","payload":{"a":1}}"#).unwrap();
        assert_eq!(status, "warn");
        assert_eq!(payload["a"], json!(1));
    }

    #[test]
    fn validate_reply_tolerates_fences_and_prose() {
        let content = "İşte plan:\n```json\n{\"status\":\"ok\",\"payload\":{\"tasks\":[]}}\n```\n";
        let (_, payload) = validate_reply(content).unwrap();
        assert!(payload["tasks"].is_array());
    }

    #[test]
    fn validate_reply_rejects_missing_payload() {
        assert!(validate_reply(r#"{"status":"ok"}"#).is_err());
        assert!(validate_reply("no json here").is_err());
    }
}

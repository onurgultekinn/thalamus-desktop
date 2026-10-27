// AI sağlayıcı köprüsü — tool-call döngüsü ile.
//
// Frontend `/api/ai/chat`'e provider + model + mesajlar gönderir; backend
// sağlayıcıyı (OpenAI-uyumlu protokol) RUST TARAFINDAN çağırır (CORS yok,
// anahtar yanıtta gezinmez), aradaki `get_code_body` araç çağrılarını lokalde
// çalıştırır ve nihai yanıtı döndürür.
//
// Katmanlı ifşa sözleşmesi: prompt'ta kod yerine şema gider; LLM gövde
// isterse backend isteğin içindeki code_blocks'tan verir. Orijinal kod
// frontend'te durur → hiçbir içerik kaybolmaz, bağlam küçülür.

use serde_json::{json, Value};

use crate::engine::pipeline::process_with_metrics;
use crate::engine::{edits, schema, MINIMAL_DECODER_INSTRUCTION};

use super::{model_caps, tools, BackendState};
use super::serve::begin_use;
use axum::extract::State;

/// Sağlayıcı HTTP taşıması — testlerde stub'lanır.
pub trait Transport: Send + Sync {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &Value,
    ) -> Result<Value, String>;
}

pub struct HttpTransport;

/// Paylaşımlı blocking client: her çağrıda yeni connection-pool/thread kurmak
/// yerine bir kez oluşturulur ve yeniden kullanılır.
static HTTP_CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();

impl Transport for HttpTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &Value,
    ) -> Result<Value, String> {
        let client = HTTP_CLIENT.get_or_init(|| {
            reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("HTTP client oluşturulamadı")
        });
        let mut req = client.post(url).json(body);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {}", status, e))?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, text));
        }
        Ok(json)
    }
}

#[derive(serde::Deserialize)]
pub struct CodeBlockIn {
    pub id: String,
    pub name: String,
    pub body: String,
}

#[derive(serde::Deserialize)]
pub struct AiChatRequest {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Açık akışlar (ayar testi) için doğrudan anahtar. Normal sohbet yolu
    /// GÖNDERMEZ — `use_stored_key` ile backend kasadan çözer.
    #[serde(default)]
    pub api_key: Option<String>,
    /// true → anahtar Credential Manager'dan `provider` kimliğiyle çözülür;
    /// anahtar JS/renderer sürecine ve istek gövdesine hiç girmez.
    #[serde(default)]
    pub use_stored_key: bool,
    pub model: String,
    pub messages: Value,
    #[serde(default)]
    pub code_blocks: Vec<CodeBlockIn>,
    /// Sağlayıcıya özgü düşünme (reasoning) modu. EVREN/vLLM gibi sunucularda
    /// modeller varsayılan olarak düşünür: cevap `reasoning` alanına gider,
    /// düşünme token'ları çıktıya yazılır ve içerik erken kesilebilir. `"none"`
    /// gönderildiğinde içerik temiz gelir (ölçüldü: 35 → 2 çıktı token'ı).
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Kullanıcı "aynen / olduğu gibi / tam metin" istediğinde true gelir:
    /// motor sıkıştırması TAMAMEN atlanır (metin birebir gider). Varsayılan
    /// maliyet optimizasyonu yalnız açık bir koruma isteği yoksa uygulanır.
    #[serde(default)]
    pub preserve: bool,
    /// Kullanıcının Ayarlar > Sohbet tercihi. Boşsa sağlayıcı varsayılanı
    /// kullanılır (0..2 aralığı dışındaki değerler yok sayılır).
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Tek yanıt için çıktı token üst sınırı. Boşsa uygulama varsayılanı
    /// (4096) kullanılır; 1..32768 aralığına kırpılır.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// İzin modu: run_command (kabuk) aracı yalnız "auto"/"autonomous"
    /// modlarında modele sunulur. Boşsa yalnız okuma/düzenleme araçları var.
    #[serde(default)]
    pub permission: Option<String>,
    /// false → araç şemaları HİÇ gönderilmez (~950 token/istek tasarrufu).
    /// Araç gerektirmeyen dahili çağrılar (özetleme, komut palası) için.
    #[serde(default)]
    pub tools_enabled: Option<bool>,
}

/// İsteğin anahtarını çözer: (1) açıkça verilen api_key, (2) use_stored_key
/// ise kasa (Credential Manager, DPAPI korumalı) provider kimliğiyle.
/// Hata mesajlarında anahtar DEĞERİ asla yer almaz.
/// Başlığa yazılamayacak karakterleri ayıklar. Kasadan bozuk bir değer
/// gelse bile reqwest'in "builder error" (500) vermesi yerine ya temiz
/// değer kullanılır ya da açıklayıcı 400 döner.
fn sanitize_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .collect()
}

fn resolve_api_key(req: &AiChatRequest) -> Result<String, (axum::http::StatusCode, String)> {
    if let Some(k) = req.api_key.as_deref() {
        let cleaned = sanitize_key(k);
        if !cleaned.is_empty() {
            return Ok(cleaned);
        }
    }
    if req.use_stored_key {
        return match crate::secrets::imp::secret_get(req.provider.trim()) {
            Ok(Some(k)) if !sanitize_key(&k).is_empty() => Ok(sanitize_key(&k)),
            Ok(_) => Err((
                axum::http::StatusCode::UNAUTHORIZED,
                format!(
                    "no valid stored key for '{}'. Paste the key again in Settings → Providers (the previous entry was corrupt and has been cleared).",
                    req.provider
                ),
            )),
            Err(e) => Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("key vault read failed: {}", e),
            )),
        };
    }
    Ok(String::new())
}

/// run_command (kabuk) aracına izin veren modlar. Frontend PERMISSION_MODES
/// ile aynı anlamsal: auto/autonomous = ajan kendi doğrulamasını çalıştırır.
fn shell_allowed(permission: Option<&str>) -> bool {
    matches!(permission, Some("auto") | Some("autonomous"))
}

/// İstek gövdesine yazılan üretim parametreleri (tek yerde doğrulanır).
#[derive(Clone, Copy)]
pub struct GenOptions {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Araç şemaları gönderilsin mi? (araç gerektirmeyen çağrılar için off)
    pub tools_enabled: bool,
    /// MODEL YETENEĞİ: model `tools` desteklemiyorsa şema gönderilmez
    /// (laya/clef gibi modellerde sağlayıcı 400 verirdi).
    pub model_supports_tools: bool,
    /// Model `reasoning_effort` alanını reddediyorsa gönderilmez.
    pub model_supports_reasoning_effort: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        Self {
            temperature: None,
            max_tokens: None,
            tools_enabled: true,
            model_supports_tools: true,
            model_supports_reasoning_effort: true,
        }
    }
}

impl GenOptions {
    pub fn from_request(req: &AiChatRequest) -> Self {
        Self {
            temperature: req
                .temperature
                .filter(|t| t.is_finite() && (0.0..=2.0).contains(t)),
            max_tokens: req.max_tokens.filter(|n| (1..=32_768).contains(n)),
            tools_enabled: req.tools_enabled.unwrap_or(true),
            // Yetenekler prepare_prompt'ta modele göre doldurulur.
            model_supports_tools: true,
            model_supports_reasoning_effort: true,
        }
    }

    /// Model yeteneklerini uygular (prepare_prompt sonrası çağrılır).
    pub fn with_caps(mut self, caps: &model_caps::ModelCaps) -> Self {
        self.model_supports_tools = caps.tools;
        self.model_supports_reasoning_effort = caps.reasoning_effort;
        self
    }

    fn max_tokens_or_default(&self) -> u32 {
        self.max_tokens.unwrap_or(4096)
    }

    /// Sağlayıcı gövdesine uygular. `max_tokens` her zaman yazılır (mevcut
    /// davranış korunur); sıcaklık yalnız kullanıcı açıkça verdiyse.
    fn apply(&self, body: &mut Value) {
        body["max_tokens"] = json!(self.max_tokens_or_default());
        if let Some(t) = self.temperature {
            body["temperature"] = json!(t);
        }
    }
}

#[derive(serde::Deserialize)]
pub struct AiTestRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

pub async fn ai_test(
    axum::Json(req): axum::Json<AiTestRequest>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let base = req.base_url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "base_url must start with http:// or https://".into(),
        ));
    }
    if req.api_key.trim().is_empty() && !is_local_endpoint(&base) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "api_key gerekli".into(),
        ));
    }

    let url = format!("{}/models", base);
    let _local_use = begin_use(&url);
    let key = req.api_key.trim().to_string();
    let models = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let mut request = client.get(&url);
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
        let response = request.send().map_err(|e| format!("connection failed: {e}"))?;
        let status = response.status();
        let text = response.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail: String = text.chars().take(300).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), detail));
        }
        let json: Value =
            serde_json::from_str(&text).map_err(|_| "provider did not return JSON".to_string())?;
        Ok(json
            .get("data")
            .and_then(|d| d.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default())
    })
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, e))?;

    Ok(axum::Json(json!({
        "ok": true,
        "count": models.len(),
        "models": models
    })))
}

/// Chat URL'inden sağlayıcı TABANINI çıkarır (".../v1/chat/completions" →
/// ".../v1"). Model yeteneği sorgusu (`/models`) bu tabanı ister.
fn base_url_of(chat_url: &str) -> &str {
    chat_url
        .strip_suffix("/chat/completions")
        .unwrap_or(chat_url)
}

pub(crate) fn provider_url(provider: &str, base_url: Option<&str>) -> Result<String, String> {
    // Kullanıcı tanımlı bağlantı: verilen base_url HER ZAMAN önceliklidir;
    // sabit eşlemeler yalnızca hiç URL verilmediğinde yedektir.
    if let Some(base) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(format!("{}/chat/completions", base.trim_end_matches('/')));
    }
    match provider {
        "deepseek" => Ok("https://api.deepseek.com/v1/chat/completions".into()),
        "openai" => Ok("https://api.openai.com/v1/chat/completions".into()),
        // EVREN (T.C. Savunma Sanayii): OpenAI uyumlu, veri Türkiye'de, ücretsiz dönem.
        "evren" => Ok("https://evren-llmapi.ssyz.org.tr/v1/chat/completions".into()),
        _ => Err(format!("unknown provider '{}' and no base_url", provider)),
    }
}

/// G2: URL'in OTORİTE (host) kısmını ayrıştırıp yalnızca gerçek loopback
/// adreslerini yerel sayar. Eski `url.contains("localhost")` kontrolü
/// `https://evil.com/?x=localhost` gibi URL'leri yerel sanıp API anahtarı
/// zorunluluğunu atlıyordu.
pub(crate) fn is_local_endpoint(url: &str) -> bool {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Host başlığında userinfo meşru değil; URL'de varsa anormal say, reddet.
    if authority.contains('@') {
        return false;
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

/// Kod bağlamı: gövde yerine ŞEMA gönderilir (bağlam tasarrufu);
/// gövde `get_code_body` aracıyla istenir. Düzenlemeler aider tarzı
/// SEARCH/REPLACE blokları olarak beklenir.
fn build_code_context(
    blocks: &[(String, String, String)],
    bpe: &tiktoken_rs::CoreBPE,
) -> Option<String> {
    if blocks.is_empty() {
        return None;
    }
    let mut out = String::from(
        "Code context: SCHEMA only (signatures + line ranges; short bodies given fully).\n\
         - get_code_body tool fetches a long body (cheap — do it before judging or editing).\n\
         - \"çağırır:\" lists functions that definition calls; fetch all relevant ones first.\n\
         - PREFER the edit_file tool for changes (multiple calls ok); write_file for new files.\n\
         - SEARCH/REPLACE blocks in your reply also work (SEARCH must match exactly):\n\
         ```\n<file>\n<<<<<<< SEARCH\n<exact existing lines>\n=======\n<new lines>\n>>>>>>> REPLACE\n```\n\nŞEMA:\n",
    );
    for (id, name, body) in blocks {
        let _ = id;
        // Küçük gövde: şema zaten gövdenin çoğunu gömer + başlık/tur bilgisi
        // ekler → şema TAM KODDAN BÜYÜK olur. Eşik altında ham gövde gönder.
        if body.chars().count() < 1_400 {
            out.push_str(&format!("--- {} (small, full body) ---\n{}\n", name, body));
            continue;
        }
        // Uzantı-duyarlı çıkarım: .py girinti, .ts/.tsx/.js/.rs küme
        // parantezi derinliği. Desteklenmeyen uzantı → tam gövde (eskisi gibi).
        //
        // ÖLÇÜMLÜ SEÇİM (AR-GE): şema her zaman kazanç sağlamaz — çok küçük
        // ya da çok sayıda kısa fonksiyon içeren dosyada şema TAM GÖVDEDEN
        // BÜYÜK olabilir. Token'la ölçülür; kazanç %25'in (certification
        // eşiği) altındaysa tam gövde gönderilir. Anlama tarafının ölçümü
        // lab/tools/comprehension_probe.py code_schema yöntemiyle çalışır.
        match schema::extract_schema_for(name, body) {
            Some(sch) => {
                let rendered = schema::render_schema(&sch);
                let body_tokens = bpe.encode_ordinary(body).len();
                let schema_tokens = bpe.encode_ordinary(&rendered).len();
                let savings = if body_tokens == 0 {
                    0.0
                } else {
                    100.0 * (body_tokens.saturating_sub(schema_tokens)) as f64
                        / body_tokens as f64
                };
                if savings >= 25.0 {
                    out.push_str(&format!("--- {} ---
{}
", name, rendered));
                } else {
                    out.push_str(&format!(
                        "--- {} (small/sparse, full body) ---
{}
",
                        name, body
                    ));
                }
            }
            None => out.push_str(&format!(
                "--- {} (schema extraction failed, full body) ---
{}
",
                name, body
            )),
        }
    }
    Some(out)
}

/// edit_file/write_file kayıtlarını frontend `edits` raporuna çevirir.
/// Kayıtlar dosya başına KÜMÜLATİF olduğu için yalnız her dosyanın son
/// kaydı yayılır; kronolojik sıra korunur (araç edit'leri önce).
fn recorded_edits_json(records: &[tools::RecordedEdit]) -> Vec<Value> {
    // İlk görülme sırasını koru; her dosya için SON kaydı al (kümülatif).
    let mut order: Vec<&str> = Vec::new();
    let mut last: std::collections::HashMap<&str, &tools::RecordedEdit> = Default::default();
    for rec in records {
        if !order.contains(&rec.file.as_str()) {
            order.push(&rec.file);
        }
        last.insert(rec.file.as_str(), rec);
    }
    order
        .into_iter()
        .filter_map(|f| {
            last.get(f).map(|rec| {
                json!({
                    "file": rec.file,
                    "applied": true,
                    "message": rec.message,
                    "new_body": rec.new_body,
                })
            })
        })
        .collect()
}

/// todo_write kayıtlarını frontend'e taşınabilir JSON'a çevirir.
fn todos_json(todos: &[(String, String)]) -> Value {
    Value::Array(
        todos
            .iter()
            .map(|(content, status)| {
                json!({"content": content, "status": status})
            })
            .collect(),
    )
}

/// Model yanıtındaki SEARCH/REPLACE bloklarını gövdelere uygular ve
/// frontend'e döndürülecek düzenleme raporunu üretir.
fn finalize_edits(content: &str, blocks: &[(String, String, String)]) -> Vec<Value> {
    let parsed = edits::parse_edit_blocks(content);
    let results = edits::apply_blocks(blocks, &parsed);
    results
        .iter()
        .map(|r| {
            json!({
                "file": r.file,
                "applied": r.ok,
                "message": r.message,
                "new_body": if r.ok { Value::String(r.new_code.clone()) } else { Value::Null },
            })
        })
        .collect()
}

/// Whole-file yedeğinin denenip denenmeyeceğine karar verir. Yedek YALNIZCA
/// model gerçekten SEARCH/REPLACE ürettiyse (düzenleme denediyse) ve o bloklar
/// mevcut kodla eşleşmediyse anlamlıdır. Soru-cevap turunda bağlam için
/// eklenen `code_blocks` yüzünden tetiklenip ikinci bir LLM çağrısıyla dosyayı
/// habersizce baştan yazmamalıdır (sahte "applied" raporunun kaynağı buydu).
fn should_try_whole_file_fallback(content: &str, edits: &[Value], has_blocks: bool) -> bool {
    let all_failed = edits.is_empty() || edits.iter().all(|e| e["applied"] == Value::Bool(false));
    let edit_attempted = !edits::parse_edit_blocks(content).is_empty();
    all_failed && edit_attempted && has_blocks
}

/// Markdown kod bloğunun içeriğini çıkarır (```lang … ```).
fn extract_code_block(content: &str) -> Option<String> {
    let start = content.find("```")?;
    let rest = &content[start + 3..];
    let nl = rest.find('\n')?;
    let body = &rest[nl + 1..];
    let end = body.find("```")?;
    Some(body[..end].trim().to_string())
}

/// Aider "whole edit format" yedeği: SEARCH/REPLACE başarısız olursa modelden
/// dosyanın TAMAMINI tek kod bloğu olarak döndürmesi istenir.
#[allow(clippy::too_many_arguments)]
fn whole_file_fallback(
    transport: &dyn Transport,
    url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    blocks: &[(String, String, String)],
    reasoning_effort: Option<&str>,
    gen: GenOptions,
) -> Result<Option<Vec<Value>>, String> {
    let Some((_, name, body)) = blocks.first() else {
        return Ok(None);
    };
    let instruction = format!(
        "SEARCH/REPLACE blokları mevcut kodla eşleşmedi. Aşağıdaki dosyanın TAMAMINI, istenen değişiklikler UYGULANMIŞ haliyle, tek bir kod bloğu içinde ve başka hiçbir metin yazmadan döndür:\n<dosya>{}</dosya>\n{}\n```\n...\n```",
        name, body
    );
    let mut msgs: Vec<Value> = messages.to_vec();
    msgs.push(json!({"role": "user", "content": instruction}));
    let mut body = json!({"model": model, "messages": msgs});
    gen.apply(&mut body);
    if let Some(effort) = reasoning_effort.filter(|_| gen.model_supports_reasoning_effort) {
        body["reasoning_effort"] = json!(effort);
    }
    let resp = transport.post_json(
        url,
        &[("Authorization".to_string(), format!("Bearer {}", api_key))],
        &body,
    )?;
    let content = resp["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(extract_code_block(&content).map(|code| {
        vec![json!({
            "file": name,
            "applied": true,
            "message": "applied via whole-file fallback (SEARCH/REPLACE mismatch)",
            "new_body": code,
        })]
    }))
}

/// Eski turların araç sonuçlarını kırpma eşiği (karakter). Güncel turun
/// sonuçları tam kalır; eskiler için model gerektiğinde aracı yeniden
/// çağırabilir — bağlam pencerisi her turda şişmez.
const TOOL_RESULT_TRIM: usize = 2_000;

/// Tool loop'ta güncel turdan önceki `tool` mesajlarını kırpır. Her tur tüm
/// konuşma sağlayıcıya yeniden gönderildiği için, kırpılmamış eski read_file/
/// grep çıktıları prompt token'ını turlarla üstel büyütüyordu.
fn trim_old_tool_results(messages: &mut [Value], fresh_count: usize) {
    let tool_idx: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
        .map(|(i, _)| i)
        .collect();
    if tool_idx.len() <= fresh_count {
        return;
    }
    for &i in &tool_idx[..tool_idx.len() - fresh_count] {
        let Some(content) = messages[i].get("content").and_then(|c| c.as_str()) else {
            continue;
        };
        if content.chars().count() <= TOOL_RESULT_TRIM {
            continue;
        }
        let head: String = content.chars().take(TOOL_RESULT_TRIM).collect();
        let trimmed = format!(
            "{}\n…[earlier tool output trimmed to save context; call the tool again if you need the rest]",
            head
        );
        if let Some(obj) = messages[i].as_object_mut() {
            obj.insert("content".to_string(), Value::String(trimmed));
        }
    }
}

/// Tek turda biriken araç sonuçlarının karakter bütçesi (tools::TOOL_RESULT_BUDGET).
/// Aşıldığında tur hata ile durur: model tek seferde düzinelerce dosya okuyup
/// kullanıcıyı büyük faturaya boğmadan döngü kesilir.
fn round_budget_error(fresh_chars: usize) -> Option<String> {
    if fresh_chars > tools::TOOL_RESULT_BUDGET {
        Some(format!(
            "tool result budget exceeded in one round ({} chars > {}); make fewer or smaller tool calls (read_file offset/limit)",
            fresh_chars,
            tools::TOOL_RESULT_BUDGET
        ))
    } else {
        None
    }
}

/// `run_command` çıktısındaki `[exit code: N]` satırından kodu okur.
/// Zaman aşımında çıktı bu satırı taşımaz; o durumda `None`.
fn parse_exit_code(result: &str) -> Option<i32> {
    let marker = "[exit code: ";
    let start = result.rfind(marker)? + marker.len();
    let rest = &result[start..];
    let end = rest.find(']')?;
    rest[..end].trim().parse::<i32>().ok()
}

/// Sağlayıcı hatası tekrarlanmaya değer mi? Yalnızca yanıt GÖNDERİLMEDEN
/// oluşan hatalar (HTTP durum satırı, bağlantı kurulamadı) — akış ortasında
/// üretilmez, bu yüzden kısmi akışı tekrar basma riski yoktur.
fn is_retryable_provider_error(e: &str) -> bool {
    e.starts_with("HTTP 429")
        || e.starts_with("HTTP 5")
        || e.contains("error sending request")
}

/// Geçici sağlayıcı hatalarında geri çekilmeli tekrar (429/5xx/bağlantı):
/// en fazla 2 tekrar, 1.6 sn / 3.2 sn bekleme. Kalıcı hata ilk hatayla döner.
fn post_with_retry<T>(mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut attempt = 0usize;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < 2 && is_retryable_provider_error(&e) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(800 * (1 << attempt)));
            }
            Err(e) => return Err(e),
        }
    }
}

/// dispatch_agent: salt-okunur sub-ajan araştırması. Alt döngü kendi başına
/// çalışır (en fazla 6 tur, read-only araçlar), sonucu kısaltılarak ana
/// bağlama döner. Alt-ajan alt-ajan doğuramaz (read_only_specs'te yok).
const SUBAGENT_MAX_TURNS: usize = 6;
const SUBAGENT_MAX_CHARS: usize = 6_000;

#[allow(clippy::too_many_arguments)]
fn run_dispatch_agent(
    transport: &dyn Transport,
    url: &str,
    api_key: &str,
    model: &str,
    args: &Value,
    ctx: &tools::ToolCtx,
    reasoning_effort: Option<&str>,
    gen: GenOptions,
    engine: tools::EngineCtx,
) -> String {
    let task = args["task"].as_str().unwrap_or("").trim();
    if task.is_empty() {
        return "HATA: task gerekli (self-contained araştırma sorusu yaz)".into();
    }
    let messages = vec![
        json!({"role": "system", "content":
            "You are a read-only investigation subagent. Explore the workspace with the provided tools, then answer with a SHORT digest (max ~40 lines): key file paths, symbols, line numbers, and the direct answer. No greetings, no prose padding."
        }),
        json!({"role": "user", "content": task}),
    ];
    let sub_gen = GenOptions {
        tools_enabled: true,
        ..gen
    };
    match run_tool_loop(
        transport,
        url,
        api_key,
        model,
        messages,
        ctx.code_blocks,
        ctx.root,
        SUBAGENT_MAX_TURNS,
        reasoning_effort,
        sub_gen,
        false,
        true,
        engine,
    ) {
        Ok((content, _, _, sub_usage, _, _)) => {
            // Alt döngünün maliyeti ana bilançoya akar — görünmez kalmasın.
            accumulate_usage(&mut ctx.sub_usage.borrow_mut(), &sub_usage);
            if content.chars().count() > SUBAGENT_MAX_CHARS {
                let head: String = content.chars().take(SUBAGENT_MAX_CHARS).collect();
                format!("{}\n…[subagent digest truncated]", head)
            } else {
                content
            }
        }
        Err(e) => format!("subagent failed: {}", e),
    }
}

/// Tur başına gelen usage'ı toplamağa ekler. Sağlayıcı her istekte yalnız O
/// isteğin token'ını raporlar; tool-loop'ta bağlam her tur yeniden gider —
/// gerçek fatura = turların TOPLAMI. Diğer alanlar son turdan korunur.
fn accumulate_usage(acc: &mut Value, round: &Value) {
    if round.is_null() {
        return;
    }
    let cached_of = |v: &Value| -> u64 {
        v.get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|c| c.as_u64())
            .unwrap_or(0)
            + v.get("prompt_cache_hit_tokens")
                .and_then(|c| c.as_u64())
                .unwrap_or(0)
    };
    if acc.is_null() {
        // İlk tur: klonla, cache detayını üst düzeye taşı (toplam kaybetmesin).
        *acc = round.clone();
        let c = cached_of(acc);
        if c > 0 {
            acc["cached_tokens"] = json!(c);
        }
        return;
    }
    for key in ["prompt_tokens", "completion_tokens", "total_tokens"] {
        let sum = acc.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
            + round.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        acc[key] = json!(sum);
    }
    // Cache toplamı YALNIZ üst düzey sayaçtan yürür; detay alanları merge'le
    // kopyalanmaz (çift sayım önlenir).
    let cached_total = acc.get("cached_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
        + cached_of(round);
    if cached_total > 0 {
        acc["cached_tokens"] = json!(cached_total);
    }
    if let (Some(obj), Some(new)) = (acc.as_object_mut(), round.as_object()) {
        for (k, v) in new {
            if k == "prompt_tokens_details" || k == "prompt_cache_hit_tokens" {
                continue;
            }
            obj.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
}
/// Tool-call döngüsü. Araçlar `tools` kayıt sisteminden gelir (dosya/arama/
/// şema/düzenleme); tümü workspace köküne sınırlıdır. Döndürür: (içerik,
/// düşünme, tur, usage, edit kayıtları, todo kayıtları).
/// `read_only=true` → sub-ajan modu: salt-okunur araç seti, değiştiren
/// araçlar savunma olarak reddedilir (bkz. dispatch_agent).
/// Bir ajan koşusunda turlar toplamında harcanabilecek azami girdi token'ı.
/// (Kullanıcı başına maliyet sigortası; aracın tek turda okuyabildiği
/// miktar zaten TOOL_RESULT_BUDGET ile sınırlı.)
const RUN_PROMPT_BUDGET: u64 = 150_000;

#[allow(clippy::too_many_arguments)] // iç çağrı: parametreler bilinçli; struct'a sarmak churn
pub fn run_tool_loop(
    transport: &dyn Transport,
    url: &str,
    api_key: &str,
    model: &str,
    mut messages: Vec<Value>,
    code_blocks: &[(String, String, String)],
    root: &std::path::Path,
    max_rounds: usize,
    reasoning_effort: Option<&str>,
    gen: GenOptions,
    allow_shell: bool,
    read_only: bool,
    engine: tools::EngineCtx,
) -> Result<(String, String, usize, Value, Vec<tools::RecordedEdit>, Vec<(String, String)>), String> {
    let tools_json = if read_only {
        tools::read_only_specs()
    } else {
        tools::specs(allow_shell)
    };
    let mut ctx = tools::ToolCtx::new(root, code_blocks);
    ctx.allow_shell = allow_shell;
    ctx.read_only = read_only;
    ctx.engine = engine;
    let headers = vec![("Authorization".to_string(), format!("Bearer {}", api_key))];
    let mut rounds = 0usize;
    let mut usage = Value::Null;

    loop {
        rounds += 1;
        if rounds > max_rounds {
            return Err(format!("tool loop limit exceeded ({} rounds)", max_rounds));
        }
        // Düşünme modu açıkça kapatılabilir (EVREN/vLLM). Verilmezse alan
        // gönderilmez; diğer sağlayıcılar bilinmeyen alandan etkilenmez.
        let mut body = json!({
            "model": model,
            "messages": messages,
        });
        if gen.tools_enabled && gen.model_supports_tools {
            body["tools"] = tools_json.clone();
        }
        gen.apply(&mut body);
        if let Some(effort) = reasoning_effort.filter(|_| gen.model_supports_reasoning_effort) {
            body["reasoning_effort"] = json!(effort);
        }
        let resp = post_with_retry(|| transport.post_json(url, &headers, &body))?;
        if let Some(u) = resp.get("usage") {
            // Turların TOPLAMI raporlanır: bağlam her tur yeniden faturalanır.
            accumulate_usage(&mut usage, u);
            // RUN BÜTÇESİ: toplam girdi üst sınırı — kaçak bir döngü (model
            // durmadan araç çağırırsa) faturayı patlatmadan kesilir.
            let spent = usage
                .get("prompt_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if spent > RUN_PROMPT_BUDGET {
                return Err(format!(
                    "run input budget exceeded: {} prompt tokens > {} — narrow the task or read fewer/smaller chunks",
                    spent, RUN_PROMPT_BUDGET
                ));
            }
        }
        let msg = resp["choices"][0]["message"].clone();
        if msg.is_null() {
            return Err("provider response was unexpectedly empty".into());
        }
        let tool_calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
        if tool_calls.is_empty() {
            let content = msg["content"].as_str().unwrap_or("").to_string();
            // Düşünme (reasoning) metni: sağlayıcıya göre `reasoning` ya da
            // `reasoning_content` alanında gelir (EVREN/vLLM: `reasoning`).
            // Arayüzde katlanabilir "Düşünme" bloğu olarak gösterilir.
            let reasoning = msg["reasoning"]
                .as_str()
                .or_else(|| msg["reasoning_content"].as_str())
                .unwrap_or("")
                .to_string();
            let mut final_usage = usage;
            accumulate_usage(&mut final_usage, &ctx.sub_usage.borrow());
            return Ok((
                content,
                reasoning,
                rounds,
                final_usage,
                ctx.edits.into_inner(),
                ctx.todos.into_inner(),
            ));
        }
        messages.push(msg);
        let mut fresh_chars = 0usize;
        // Tur içi dedupe: birebir aynı araç çağrısının sonucu ikinci kez
        // bağlama girmez (paralel çağrılarda model bazen aynısını iki kez ister).
        let mut round_seen: std::collections::HashSet<String> = Default::default();
        for tc in &tool_calls {
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args_raw = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
            if !round_seen.insert(format!("{}:{}", name, args_raw)) {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc["id"].as_str().unwrap_or(""),
                    "content": "duplicate of an identical call in this same round — its full result is already above; do not repeat identical calls.".to_string(),
                }));
                continue;
            }
            let result = if name == "dispatch_agent" && !ctx.read_only {
                run_dispatch_agent(
                    transport, url, api_key, model, &args, &ctx,
                    reasoning_effort, gen, ctx.engine.clone(),
                )
            } else {
                tools::execute(&name, &args, &ctx)
            };
            fresh_chars += result.chars().count();
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc["id"].as_str().unwrap_or(""),
                "content": result,
            }));
        }
        if let Some(e) = round_budget_error(fresh_chars) {
            return Err(e);
        }
        trim_old_tool_results(&mut messages, tool_calls.len());
    }
}

/// Proje belleği: workspace kökündeki AGENTS.md / CLAUDE.md / THALAMUS.md
/// içeriği AI bağlamına eklenir (ZCode ve Claude Code ekolü).
const PROJECT_MEMORY_MAX_CHARS: usize = 8_000;

fn project_memory(root: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for name in ["AGENTS.md", "CLAUDE.md", "THALAMUS.md"] {
        let p = std::path::Path::new(root).join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                parts.push(format!("--- {} ---
{}", name, text.trim()));
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut out = format!(
        "PROJECT INSTRUCTIONS (follow these):
{}",
        parts.join("

")
    );
    if out.chars().count() > PROJECT_MEMORY_MAX_CHARS {
        let head: String = out.chars().take(PROJECT_MEMORY_MAX_CHARS).collect();
        out = format!(
            "{}
[...project instructions truncated to {} chars - keep AGENTS.md concise]",
            head, PROJECT_MEMORY_MAX_CHARS
        );
    }
    Some(out)
}

/// Kullanıcı görünmez sağlam sıkıştırma katmanı (P2).
///
/// Provider'a giden `messages` içindeki system/user içerikleri motorun karar
/// makinesinden geçer: JSON segmentli ve kazançlı veri lossless @T sıkıştırma
/// alır; karar motoru passthrough derse ham metin kalır. Asistan
/// yanıtları (assistant) NATURAL kalmak şartıyla dokunulmaz.
/// Dönen değer toplu `(original_tokens, compressed_tokens, compressed_count)`.
fn compress_messages_invisibly(
    messages: &mut [Value],
    bpe: &tiktoken_rs::CoreBPE,
) -> (usize, usize, usize) {
    let mut original_total = 0usize;
    let mut compressed_total = 0usize;
    let mut compressed_count = 0usize;
    for msg in messages.iter_mut() {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        // Asistan çıktıları ve araç sonuçları doğal kalmalı. system/user
        // istek tarafıdır — token tasarrufu amacı sağlanabilen yer.
        if !matches!(role, "user" | "system") {
            continue;
        }
        let Some(content) = msg.get("content").and_then(|c| c.as_str()) else {
            // Dizi içerikli (görsel ekli) mesajlar: text bölümlerini tek tek
            // değil, olduğu gibi bırak — parça bazlı yönetim ileride.
            continue;
        };
        if content.trim().len() < 200 {
            // Kısa içerikte decoder talimatı maliyeti tasarrufu aşar; motor
            // zaten passthrough kararı verir ama iş yükünü de atlamak karşı
            // değil.
            continue;
        }
        let m = process_with_metrics(content, bpe, false);
        if m.is_compressed && m.compressed_tokens < m.original_tokens {
            original_total += m.original_tokens;
            compressed_total += m.compressed_tokens;
            compressed_count += 1;
            if let Some(obj) = msg.as_object_mut() {
                obj.insert(
                    "content".to_string(),
                    Value::String(m.processed_prompt.clone()),
                );
            }
        }
    }
    (original_total, compressed_total, compressed_count)
}

/// Doğrulama + prompt hazırlığı (proje belleği, görünmez sıkıştırma, kod
/// şeması). Hem tek seferlik hem akış yolu aynı hazırlığı kullanır.
type PreparedPrompt = (
    Vec<Value>,
    Vec<(String, String, String)>,
    (usize, usize, usize),
    model_caps::ModelCaps,
);

/// Geçmişteki DESTEK assistant mesajlarını kırpar. Ajan yanıtları (SEARCH/
/// REPLACE blokları, tam dosya gövdeleri) binlerce token taşıyabilir ve her
/// istekte yeniden faturalanır. Son KEEP_RECENT asistan mesajı tam kalır;
/// daha eskiler MAX_LEN üstündeyse başı korunup kuyruk kesilir. Araç-çağrılı
/// assistant mesajlarına (tool-loop içi) dokunulmaz — buraya frontend
/// geçmişi gelir, onlar zaten tur sonunda atılır.
const ASSISTANT_KEEP_RECENT: usize = 2;
const ASSISTANT_MAX_CHARS: usize = 4_000;

fn trim_old_assistant_messages(messages: &mut [Value]) {
    let idx: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                && m.get("tool_calls").is_none()
        })
        .map(|(i, _)| i)
        .collect();
    if idx.len() <= ASSISTANT_KEEP_RECENT {
        return;
    }
    for &i in &idx[..idx.len() - ASSISTANT_KEEP_RECENT] {
        let len = messages[i]["content"].as_str().map(str::chars).map_or(0, Iterator::count);
        if len <= ASSISTANT_MAX_CHARS {
            continue;
        }
        if let Some(c) = messages[i]["content"].as_str() {
            let head: String = c.chars().take(ASSISTANT_MAX_CHARS - 120).collect();
            let trimmed = format!(
                "{}
[...{} more chars trimmed from this older reply to save context]",
                head,
                len - (ASSISTANT_MAX_CHARS - 120)
            );
            if let Some(obj) = messages[i].as_object_mut() {
                obj.insert("content".into(), Value::String(trimmed));
            }
        }
    }
}

fn prepare_prompt(
    state: &BackendState,
    req: &AiChatRequest,
) -> Result<PreparedPrompt, (axum::http::StatusCode, String)> {
    let url = provider_url(&req.provider, req.base_url.as_deref())
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    // Local endpoint'ler (Ollama, LM Studio…) anahtarsız kullanılabilir;
    // bulut sağlayıcılar için anahtar zorunludur.
    let is_local_base = is_local_endpoint(&url);
    let api_key = resolve_api_key(req)?;
    if api_key.trim().is_empty() && !is_local_base {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "api_key gerekli".into(),
        ));
    }
    // MODEL YETENEKLERİ: laya/clef gibi modeller araç (tools) desteklemez;
    // OCR/embedding/ASR modelleri sohbet uç noktasını hiç kullanmaz.
    // Meta veri yoksa varsayılan (mevcut davranış) korunur.
    let caps = if is_local_base {
        None
    } else {
        model_caps::caps_for(base_url_of(&url), &api_key, &req.model)
    };
    if let Some(c) = &caps {
        if !c.is_chat_capable() {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                format!(
                    "'{}' bir {} modeli — sohbet için kullanılamaz. Sohbet için glm-5.3, deepseek-v4.1-flash veya qwen3.8-flash-next gibi bir model seçin.",
                    req.model,
                    c.task_label()
                ),
            ));
        }
    }
    let mut messages = req.messages.as_array().cloned().unwrap_or_default();
    if messages.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "messages cannot be empty".into(),
        ));
    }
    // Token tasarrufu: eski dev asistan yanıtları (SEARCH/REPLACE, dosya
    // gövdeleri) her istekte yeniden faturalanmasın — kuyrukları kesilir.
    trim_old_assistant_messages(&mut messages);
    let blocks: Vec<(String, String, String)> = req
        .code_blocks
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.body.clone()))
        .collect();

    // ÖNEK CACHE: kod bağlamı her turda değişir. Onu başa koymak tüm öneki
    // geçersiz kılar; bu yüzden son kullanıcı mesajının HEMEN ÖNÜNE eklenir.
    // (Değişmeyen sistem + geçmiş öneki cache'te kalır.)
    // PROJE BELLEGI: yalniz gercek sohbet cagirilarinda gider. Aracsiz dahili
    // cagirilar (ozetleme, komut palasi) talimatlari uygulamaz - orada AGENTS.md
    // (~2k token) saf israttir. tools_enabled=false o cagirilarin isaretidir.
    let internal_call = !GenOptions::from_request(req).tools_enabled;
    if !internal_call {
        if let Some(mem) = project_memory(
            &state
                .workspace_root
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        ) {
            messages.insert(0, json!({"role": "system", "content": mem}));
        }
    }
    // ARAÇ POLİTİKASI (~55 token): genel bilgi sorularında araç çağrısını
    // engeller (armut sorusu → tek tur; web_search yalnız gerçekten taze
    // bilgi gerekince) ve modelin KENDİ yetenekleri hakkında repo
    // karıştırmasını yasaklar.
    messages.insert(
        0,
        json!({"role": "system", "content":
            "TOOL POLICY: answer general-knowledge questions directly from your own knowledge              WITHOUT calling any tools — even though web_search exists, use it ONLY when fresh              or verifiable facts are genuinely required. Never inspect the repository to answer              questions about your own tools or capabilities."
        }),
    );

    // P2: görünmez lossless sıkıştırma — provider'a giden istek boyunca.
    // KULLANICI KORUMASI: "aynen/olduğu gibi/tam metin" istendiyse dokunma.
    // YEREL MODELLER: küçük modeller (1–3B) @T tablosunu ve decoder talimatını
    // çözemiyor; sıkıştırma onların cevabını bozuyor. Loopback uç noktalarda
    // ham metin gönderilir.
    let engine = if req.preserve || is_local_base {
        (0usize, 0usize, 0usize)
    } else {
        compress_messages_invisibly(&mut messages, &state.bpe)
    };
    // Sıkıştırılmış veri varsa decoder talimatı tam bir sistem mesajı olarak
    // en başa girer (görünmez katmanın model tarafı sözleşmesi).
    if engine.2 > 0 {
        messages.insert(
            0,
            json!({"role": "system", "content": MINIMAL_DECODER_INSTRUCTION}),
        );
    }
    if let Some(ctx) = build_code_context(&blocks, &state.bpe) {
        let pos = messages.len().saturating_sub(1);
        messages.insert(pos, json!({"role": "system", "content": ctx}));
    }
    Ok((messages, blocks, engine, caps.unwrap_or_default()))
}

// ── Canlı akış (SSE) ────────────────────────────────────────────────────────
// Akışta tool döngüsü korunur: her tur ayrı akıtılır, araç çağrısı varsa
// araçlar çalıştırılıp bir sonraki tur akıtılır. Metin parçaları geldikçe
// `{"type":"delta"}` olayı olarak gönderilir.

/// Akışa özel client: toplam süre 10 dk (sonsuz asılmayı önler), bağlantı
/// kurulumu 20 sn. İptal, istemci bağlantıyı kapatınca kanalın kapanmasıyla olur.
static STREAM_CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();

fn stream_client() -> &'static reqwest::blocking::Client {
    STREAM_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .expect("stream HTTP client")
    })
}

fn emit_event(tx: &tokio::sync::mpsc::Sender<String>, value: Value) -> bool {
    tx.blocking_send(value.to_string()).is_ok()
}

#[derive(Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
}

type StreamRound = (String, String, Vec<Value>, Value, Option<String>);

/// Tek turu akıtır. Dönüş: (metin, düşünme, tool çağrıları, usage, bitiş nedeni).
#[allow(clippy::too_many_arguments)]
fn stream_one_round(
    tx: &tokio::sync::mpsc::Sender<String>,
    url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    tools_json: &Value,
    reasoning_effort: Option<&str>,
    gen: GenOptions,
) -> Result<StreamRound, String> {
    let build_body = |include_usage: bool| -> Value {
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
        });
        if gen.tools_enabled && gen.model_supports_tools {
            body["tools"] = tools_json.clone();
        }
        gen.apply(&mut body);
        if include_usage {
            body["stream_options"] = json!({"include_usage": true});
        }
        if let Some(effort) = reasoning_effort.filter(|_| gen.model_supports_reasoning_effort) {
            body["reasoning_effort"] = json!(effort);
        }
        body
    };
    let send = |include_usage: bool| -> Result<reqwest::blocking::Response, String> {
        let mut request = stream_client().post(url).json(&build_body(include_usage));
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key);
        }
        request.send().map_err(|e| e.to_string())
    };
    let mut resp = send(true)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        // Bazı OpenAI-uyumlu sunucular `stream_options` alanını reddeder;
        // bu durumda onsuz tekrar denenir (kullanım bilgisi gelmez, akış gelir).
        if text.contains("stream_options") || text.contains("include_usage") {
            resp = send(false)?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                return Err(format!("HTTP {}: {}", status, text));
            }
        } else {
            return Err(format!("HTTP {}: {}", status, text));
        }
    }
    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);
    // Akış desteklemeyen sağlayıcı: gövde tek JSON gelir; tek parça olarak iletilir.
    if !is_sse {
        let value: Value = resp.json().map_err(|e| e.to_string())?;
        let choice = &value["choices"][0];
        let finish_reason = choice["finish_reason"].as_str().map(str::to_string);
        let msg = choice["message"].clone();
        let content = msg["content"].as_str().unwrap_or("").to_string();
        let reasoning = msg["reasoning"]
            .as_str()
            .or_else(|| msg["reasoning_content"].as_str())
            .unwrap_or("")
            .to_string();
        if !content.is_empty() && !emit_event(tx, json!({"type": "delta", "content": content})) {
            return Ok((content, reasoning, Vec::new(), Value::Null, finish_reason));
        }
        if !reasoning.is_empty() {
            let _ = emit_event(tx, json!({"type": "reasoning", "content": reasoning}));
        }
        return Ok((
            content,
            reasoning,
            msg["tool_calls"].as_array().cloned().unwrap_or_default(),
            value.get("usage").cloned().unwrap_or(Value::Null),
            finish_reason,
        ));
    }

    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_acc: std::collections::BTreeMap<usize, StreamToolCall> = Default::default();
    let mut usage = Value::Null;
    let mut finish_reason: Option<String> = None;
    let reader = std::io::BufReader::new(resp);
    for line in std::io::BufRead::lines(reader) {
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(u) = value.get("usage") {
            if !u.is_null() {
                usage = u.clone();
            }
        }
        let Some(choice) = value["choices"].get(0) else {
            continue;
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            finish_reason = Some(reason.to_string());
        }
        let delta = &choice["delta"];
        if let Some(piece) = delta["content"].as_str() {
            if !piece.is_empty() {
                content.push_str(piece);
                if !emit_event(tx, json!({"type": "delta", "content": piece})) {
                    return Ok((content, reasoning, Vec::new(), usage, finish_reason));
                }
            }
        }
        if let Some(piece) = delta["reasoning"]
            .as_str()
            .or_else(|| delta["reasoning_content"].as_str())
        {
            if !piece.is_empty() {
                reasoning.push_str(piece);
                if !emit_event(tx, json!({"type": "reasoning", "content": piece})) {
                    return Ok((content, reasoning, Vec::new(), usage, finish_reason));
                }
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let idx = call["index"].as_u64().unwrap_or(0) as usize;
                let entry = tool_acc.entry(idx).or_default();
                if let Some(id) = call["id"].as_str() {
                    if !id.is_empty() {
                        entry.id = id.to_string();
                    }
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    if !name.is_empty() && !entry.name.ends_with(name) {
                        entry.name.push_str(name);
                    }
                }
                if let Some(args) = call["function"]["arguments"].as_str() {
                    entry.arguments.push_str(args);
                }
            }
        }
    }
    let tool_calls: Vec<Value> = tool_acc
        .into_values()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            })
        })
        .collect();
    Ok((content, reasoning, tool_calls, usage, finish_reason))
}

#[allow(clippy::too_many_arguments)]
fn stream_tool_loop(
    tx: &tokio::sync::mpsc::Sender<String>,
    url: &str,
    api_key: &str,
    model: &str,
    mut messages: Vec<Value>,
    code_blocks: &[(String, String, String)],
    root: &std::path::Path,
    max_rounds: usize,
    reasoning_effort: Option<&str>,
    gen: GenOptions,
    allow_shell: bool,
    read_only: bool,
    engine: tools::EngineCtx,
) {
    let tools_json = if read_only {
        tools::read_only_specs()
    } else {
        tools::specs(allow_shell)
    };
    let mut ctx = tools::ToolCtx::new(root, code_blocks);
    ctx.allow_shell = allow_shell;
    ctx.read_only = read_only;
    ctx.engine = engine;
    let mut rounds = 0usize;
    let mut usage = Value::Null;
    loop {
        rounds += 1;
        if rounds > max_rounds {
            let _ = emit_event(
                tx,
                json!({"type": "error", "message": format!("tool loop limit exceeded ({} rounds)", max_rounds)}),
            );
            return;
        }
        // İPTAL YAYILIMI: kullanıcı Stop'a bastıysa istemci bağlantıyı kapatır
        // ve kanal kapanır. Bir sonraki tura girmeden dur — uzun bir araç
        // çağrısının (ör. 60 sn'lik komut) sonucunu beklemeye devam etmeyiz.
        if tx.is_closed() {
            return;
        }
        // Geçici hatalarda turu tekrarla: HTTP durum hataları akış
        // BAŞLAMADAN oluşur (emit yok), kısmi akış tekrarı riski yoktur.
        let round = post_with_retry(|| {
            stream_one_round(
                tx,
                url,
                api_key,
                model,
                &messages,
                &tools_json,
                reasoning_effort,
                gen,
            )
        });
        match round {
            Ok((content, _reasoning, tool_calls, round_usage, finish_reason)) => {
                if !round_usage.is_null() {
                    accumulate_usage(&mut usage, &round_usage);
                }
                if tool_calls.is_empty() {
                    let mut final_usage = usage;
                    accumulate_usage(&mut final_usage, &ctx.sub_usage.borrow());
                    let _ = emit_event(tx, json!({
                        "type": "done",
                        "rounds": rounds,
                        "usage": final_usage,
                        "finish_reason": finish_reason,
                        "edits": recorded_edits_json(&ctx.edits.borrow()),
                        "todos": todos_json(&ctx.todos.borrow()),
                    }));
                    return;
                }
                messages.push(json!({
                    "role": "assistant",
                    "content": if content.is_empty() { Value::Null } else { Value::String(content) },
                    "tool_calls": tool_calls.clone(),
                }));
                let mut fresh_chars = 0usize;
                let mut round_seen: std::collections::HashSet<String> = Default::default();
                for tc in &tool_calls {
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args_raw = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let args: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
                    // Arac cagrisi gorunur olsun (on yuz "read_file calisiyor..."
                    // gosterebilir; bilinmeyen olay tipini sessizce yoksayar).
                    let _ = emit_event(tx, json!({"type": "tool_call", "name": name}));
                    if !round_seen.insert(format!("{}:{}", name, args_raw)) {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": tc["id"].as_str().unwrap_or(""),
                            "content": "duplicate of an identical call in this same round — its full result is already above; do not repeat identical calls.".to_string(),
                        }));
                        continue;
                    }
                    let started = std::time::Instant::now();
                    let result = if name == "dispatch_agent" && !ctx.read_only {
                        let transport = HttpTransport;
                        run_dispatch_agent(
                            &transport, url, api_key, model, &args, &ctx,
                            reasoning_effort, gen, ctx.engine.clone(),
                        )
                    } else {
                        tools::execute(&name, &args, &ctx)
                    };
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    // run_command kaydı: komut metni, çıkış kodu ve süre
                    // arayüzde görünür — otomatik modda çalışan kabuğun ne
                    // yaptığı sessiz kalmamalı.
                    if name == "run_command" {
                        let command = args["command"].as_str().unwrap_or("");
                        let exit_code = parse_exit_code(&result);
                        let _ = emit_event(tx, json!({
                            "type": "tool_result",
                            "name": name,
                            "command": command,
                            "exit_code": exit_code,
                            "duration_ms": elapsed_ms,
                        }));
                    }
                    fresh_chars += result.chars().count();
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc["id"].as_str().unwrap_or(""),
                        "content": result,
                    }));
                }
                if let Some(e) = round_budget_error(fresh_chars) {
                    let _ = emit_event(tx, json!({"type": "error", "message": e}));
                    return;
                }
                trim_old_tool_results(&mut messages, tool_calls.len());
            }
            Err(e) => {
                let _ = emit_event(tx, json!({"type": "error", "message": e}));
                return;
            }
        }
    }
}

/// `/api/ai/chat/stream`: aynı istek gövdesi, SSE yanıtı.
/// Olaylar: `meta` (motor), `delta`, `reasoning`, `done`, `error`.
pub async fn ai_chat_stream(
    State(state): State<BackendState>,
    axum::Json(req): axum::Json<AiChatRequest>,
) -> Result<axum::response::Response, (axum::http::StatusCode, String)> {
    use axum::response::IntoResponse;
    let url = provider_url(&req.provider, req.base_url.as_deref())
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    // İstek boyunca sunucuyu meşgul işaretle: uykuya dalmışsa hemen uyandır.
    let local_use = begin_use(&url);
    let (messages, blocks, engine, caps) = prepare_prompt(&state, &req)?;
    let url_for_task = url.clone();
    let api_key_for_task = resolve_api_key(&req)?;
    let model_for_task = req.model.clone();
    let effort_for_task = req.reasoning_effort.clone();
    let gen_for_task = GenOptions::from_request(&req).with_caps(&caps);
    let permission_for_task = req.permission.clone();
    let root_for_task = state
        .workspace_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let engine_for_task = tools::EngineCtx {
        bpe: Some(state.bpe.clone()),
        repo_cache: Some(state.repo_cache.clone()),
        schema_cache: Some(state.schema_cache.clone()),
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
    let _ = tx.try_send(
        json!({
            "type": "meta",
            "engine": {
                "compressed_messages": engine.2,
                "original_tokens": engine.0,
                "compressed_tokens": engine.1,
            }
        })
        .to_string(),
    );
    tokio::task::spawn_blocking(move || {
        let _local_use = local_use;
        stream_tool_loop(
            &tx,
            &url_for_task,
            &api_key_for_task,
            &model_for_task,
            messages,
            &blocks,
            std::path::Path::new(&root_for_task),
            8,
            effort_for_task.as_deref(),
            gen_for_task,
            shell_allowed(permission_for_task.as_deref()),
            false,
            engine_for_task.clone(),
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|item| {
                (
                    Ok::<_, std::convert::Infallible>(
                        axum::response::sse::Event::default().data(item),
                    ),
                    rx,
                )
            })
    });
    Ok(axum::response::sse::Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response())
}

pub async fn ai_chat(
    State(state): State<BackendState>,
    axum::Json(req): axum::Json<AiChatRequest>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let url = provider_url(&req.provider, req.base_url.as_deref())
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    // Tüm yanıt (yedek whole-file denemesi dahil) bitene kadar meşgul say.
    let _local_use = begin_use(&url);
    let messages_before_context = req.messages.as_array().cloned().unwrap_or_default();
    let (messages, blocks, engine, caps) = prepare_prompt(&state, &req)?;
    let (engine_original, engine_compressed, engine_count) = engine;

    let effort_for_task = req.reasoning_effort.clone();
    let gen_for_task = GenOptions::from_request(&req).with_caps(&caps);
    let blocks_for_task = blocks.clone();
    let url_for_task = url.clone();
    let api_key_for_task = resolve_api_key(&req)?;
    let model_for_task = req.model.clone();
    let permission_for_task = req.permission.clone();
    let root_for_task = state
        .workspace_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let engine_for_task = tools::EngineCtx {
        bpe: Some(state.bpe.clone()),
        repo_cache: Some(state.repo_cache.clone()),
        schema_cache: Some(state.schema_cache.clone()),
    };
    let result = tokio::task::spawn_blocking(move || {
        let transport = HttpTransport;
        run_tool_loop(
            &transport,
            &url_for_task,
            &api_key_for_task,
            &model_for_task,
            messages,
            &blocks_for_task,
            std::path::Path::new(&root_for_task),
            8,
            effort_for_task.as_deref(),
            gen_for_task,
            shell_allowed(permission_for_task.as_deref()),
            false,
            engine_for_task.clone(),
        )
    })
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, e))?;

    // Araç edit'leri (edit_file/write_file) önce; sonra nihai yanıtta
    // SEARCH/REPLACE ile gelenler. Aynı dosyada ikisi birden varsa araç
    // kaydı zaten kümülatif son gövdeyi taşır.
    let mut edits = recorded_edits_json(&result.4);
    edits.extend(finalize_edits(&result.0, &blocks));

    // Aider stratejisi: SEARCH/REPLACE eşleşmediyse whole-file yedeği dene.
    // Blocking client async çalışanda çağrılamaz — spawn_blocking'e taşındı
    // (aksi halde uzun provider gecikmesi tüm HTTP sunucusunu kilitler).
    let edits = if should_try_whole_file_fallback(&result.0, &edits, !blocks.is_empty()) {
        let fallback_messages = messages_before_context;
        let fallback_url = url.clone();
        let fallback_key = resolve_api_key(&req)?;
        let fallback_model = req.model.clone();
        let fallback_effort = req.reasoning_effort.clone();
        match tokio::task::spawn_blocking(move || {
            let transport = HttpTransport;
            whole_file_fallback(
                &transport,
                &fallback_url,
                &fallback_key,
                &fallback_model,
                &fallback_messages,
                &blocks,
                fallback_effort.as_deref(),
                gen_for_task,
            )
        })
        .await
        {
            Ok(Ok(Some(fb))) => fb,
            _ => edits,
        }
    } else {
        edits
    };

    Ok(axum::Json(json!({
        "content": result.0,
        "reasoning": result.1,
        "rounds": result.2,
        "usage": result.3,
        "edits": edits,
        "todos": todos_json(&result.5),
        // Görünmez katmanın bilançosu — ön yüz sıradan akışta göstermez.
        "engine": {
            "compressed_messages": engine_count,
            "original_tokens": engine_original,
            "compressed_tokens": engine_compressed,
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_loop_aborts_when_round_budget_exceeded() {
        // 5 × ~32 KB read_file = ~164k karakter > TOOL_RESULT_BUDGET (150k):
        // döngü hata ile durmalı, kullanıcı sessizce büyük faturaya boğulmamalı.
        let tmp = std::env::temp_dir().join(format!("thx_bud_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(
            tmp.join("big.txt"),
            format!("{}\n", "a".repeat(200)).repeat(250),
        )
        .unwrap();
        // Tur içi dedupe'yi aşmak için her çağrı FARKLI offset ister.
        let calls: Vec<Value> = (0..5)
            .map(|i| {
                json!({
                    "id": format!("c{}", i),
                    "type": "function",
                    "function": {"name": "read_file", "arguments": format!("{{\"path\":\"big.txt\",\"offset\":{}}}", i + 1)}
                })
            })
            .collect();
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":calls}}]}),
                json!({"choices":[{"message":{"content":"hepsini okudum"}}]}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let err = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "big.txt oku"})],
            &[],
            std::path::Path::new(&tmp),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap_err();
        assert!(err.contains("budget"), "bütçe hatası beklenirdi: {}", err);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// İlk çağrılarda kuyruğundaki hataları döndüren taşıma; sonra yanıtlar.
    struct FlakyTransport {
        errors: std::sync::Mutex<Vec<String>>,
        responses: std::sync::Mutex<Vec<Value>>,
        seen: std::sync::Mutex<usize>,
    }
    impl Transport for FlakyTransport {
        fn post_json(
            &self,
            _url: &str,
            _h: &[(String, String)],
            _body: &Value,
        ) -> Result<Value, String> {
            let mut n = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            *n += 1;
            let mut errs = self.errors.lock().unwrap_or_else(|e| e.into_inner());
            if !errs.is_empty() {
                return Err(errs.remove(0));
            }
            drop(errs);
            let mut resps = self.responses.lock().unwrap_or_else(|e| e.into_inner());
            if resps.is_empty() {
                return Err("yanıt tükendi".into());
            }
            Ok(resps.remove(0))
        }
    }

    #[test]
    fn tools_disabled_omits_tools_key() {
        let transport = FakeTransport {
            responses: vec![json!({"choices":[{"message":{"content":"kisa cevap"}}]})],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let gen = GenOptions {
            tools_enabled: false,
            ..GenOptions::default()
        };
        let (content, _, _, _, _, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "merhaba"})],
            &[],
            std::path::Path::new("."),
            4,
            None,
            gen,
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        assert_eq!(content, "kisa cevap");
        let seen = transport.seen.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            seen[0].get("tools").is_none(),
            "araç kapalıyken tools anahtari GIDIMEMELI: {}",
            seen[0]
        );
        // Varsayilan (default) acik kalmali.
        assert!(GenOptions::default().tools_enabled);
    }

    #[test]
    fn cached_tokens_accumulate() {
        // Gerçek akış: acc her zaman Null'dan başlar (ilk tur klonla lift eder).
        let mut acc = Value::Null;
        let r1 = json!({"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 60}});
        accumulate_usage(&mut acc, &r1);
        let r2 = json!({"prompt_tokens": 50, "prompt_tokens_details": {"cached_tokens": 30}});
        accumulate_usage(&mut acc, &r2);
        assert_eq!(acc["prompt_tokens"], json!(150));
        assert_eq!(acc["cached_tokens"], json!(90));
        // DeepSeek biçimi: ilk turdan itibaren üst düzeye taşınmalı.
        let mut acc2 = Value::Null;
        let r3 = json!({"prompt_tokens": 10, "prompt_cache_hit_tokens": 7});
        accumulate_usage(&mut acc2, &r3);
        assert_eq!(acc2["cached_tokens"], json!(7));
    }

    #[test]
    fn transient_provider_errors_are_retried() {
        let transport = FlakyTransport {
            errors: std::sync::Mutex::new(vec![
                "HTTP 429: rate limited".to_string(),
                "HTTP 503: try again".to_string(),
            ]),
            responses: std::sync::Mutex::new(vec![
                json!({"choices":[{"message":{"content":"tamam"}}]}),
            ]),
            seen: std::sync::Mutex::new(0),
        };
        let (content, _, rounds, _, _, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "merhaba"})],
            &[],
            std::path::Path::new("."),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        assert_eq!(content, "tamam");
        assert_eq!(*transport.seen.lock().unwrap_or_else(|e| e.into_inner()), 3);
        assert_eq!(rounds, 1);
    }

    #[test]
    fn permanent_provider_errors_are_not_retried() {
        let transport = FlakyTransport {
            errors: std::sync::Mutex::new(vec!["HTTP 401: bad key".to_string()]),
            responses: std::sync::Mutex::new(vec![]),
            seen: std::sync::Mutex::new(0),
        };
        let err = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "merhaba"})],
            &[],
            std::path::Path::new("."),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap_err();
        assert!(err.contains("401"));
        assert_eq!(*transport.seen.lock().unwrap_or_else(|e| e.into_inner()), 1);
    }

    #[test]
    fn recorded_tool_edits_last_per_file() {
        let recs = vec![
            tools::RecordedEdit {
                file: "a.ts".into(),
                new_body: "eski a".into(),
                message: "m1".into(),
            },
            tools::RecordedEdit {
                file: "b.ts".into(),
                new_body: "b gövde".into(),
                message: "m2".into(),
            },
            tools::RecordedEdit {
                file: "a.ts".into(),
                new_body: "yeni a".into(),
                message: "m3".into(),
            },
        ];
        let out = recorded_edits_json(&recs);
        assert_eq!(out.len(), 2, "dosya başına tek kayıt");
        assert_eq!(out[0]["file"], "a.ts");
        assert_eq!(out[0]["new_body"], "yeni a", "son kayıt kazanmalı");
        assert_eq!(out[1]["file"], "b.ts");
    }

    #[test]
    fn dispatch_agent_runs_readonly_subloop() {
        let tmp = std::env::temp_dir().join(format!("thx_sub_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("api.py"), "def login():
    return True
").unwrap();
        // 1) ana tur: dispatch_agent çağrısı
        // 2) alt döngü tur 1: read_file ister
        // 3) alt döngü tur 2: özeti yazar
        // 4) ana tur 2: nihai cevap
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"dispatch_agent","arguments":"{\"task\":\"api.py login?\"}"}}
                ]}}]}),
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[
                    {"id":"s1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"api.py\"}"}}
                ]}}]}),
                json!({"choices":[{"message":{"content":"api.py:3 login() True doner"}}]}),
                json!({"choices":[{"message":{"content":"Login True döndürüyor."}}]}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let (content, _, _, _, edits, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "login'i araştır"})],
            &[],
            std::path::Path::new(&tmp),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        assert_eq!(content, "Login True döndürüyor.");
        assert!(edits.is_empty(), "sub-ajan düzenleme yapamaz");
        let seen = transport.seen.lock().unwrap_or_else(|e| e.into_inner());
        // Alt döngünün kendi istediği araç seti salt-okunur olmalı.
        let sub_req = &seen[1];
        let spec_names: Vec<String> = sub_req["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str().map(String::from))
            .collect();
        assert!(!spec_names.contains(&"edit_file".to_string()));
        assert!(!spec_names.contains(&"dispatch_agent".to_string()));
        assert!(spec_names.contains(&"read_file".to_string()));
        // Alt döngünün mesajlarında subagent sistem sözleşmesi var.
        assert!(sub_req["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("read-only investigation subagent"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn subagent_cannot_chain_edits_or_agents() {
        let tmp = std::env::temp_dir();
        let blocks: Vec<(String, String, String)> = vec![];
        let mut c = tools::ToolCtx::new(&tmp, &blocks);
        c.read_only = true;
        let out = tools::execute(
            "edit_file",
            &serde_json::json!({"path":"x","search":"a","replace":"b"}),
            &c,
        );
        assert!(out.contains("not allowed"), "savunma: {}", out);
        // Alt-ajanda dispatch_agent hiç yok sayılır (derinlik kilidi).
        let out2 = tools::execute("dispatch_agent", &serde_json::json!({"task":"x"}), &c);
        assert!(out2.contains("unknown tool"), "derinlik kilidi: {}", out2);
    }

    #[test]
    fn usage_accumulates_across_tool_rounds() {
        // İki turlu koşu: her tur usage raporlar; toplam dönmeli (fatura
        // gerçeği — bağlam her tur yeniden faturalanır).
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"read_file","arguments":"{}"}}
                ]}}], "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}),
                json!({"choices":[{"message":{"content":"bitti"}}], "usage":{"prompt_tokens":200,"completion_tokens":5,"total_tokens":205}}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let (_, _, _, usage, _, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "oku"})],
            &[],
            std::path::Path::new("."),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        assert_eq!(usage["prompt_tokens"], json!(300));
        assert_eq!(usage["completion_tokens"], json!(15));
        assert_eq!(usage["total_tokens"], json!(315));
    }

    #[test]
    fn project_memory_is_capped() {
        let tmp = std::env::temp_dir().join(format!("thx_mem_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let big = "kural satırı. ".repeat(2_000); // ~28k char
        std::fs::write(tmp.join("AGENTS.md"), &big).unwrap();
        let mem = project_memory(tmp.to_str().unwrap()).unwrap();
        assert!(mem.chars().count() < 8_200, "üst sınır: {}", mem.chars().count());
        assert!(mem.contains("truncated"), "kesildi notu olmalı");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn old_assistant_replies_are_trimmed_in_prepare() {
        let big = "def f():
".repeat(700); // ~7k char assistant yanıtı
        let mut messages = vec![
            json!({"role": "user", "content": "eski soru"}),
            json!({"role": "assistant", "content": big}),
            json!({"role": "user", "content": "yeni soru"}),
            json!({"role": "assistant", "content": "kısa yanıt 1"}),
            json!({"role": "assistant", "content": "kısa yanıt 2"}),
            json!({"role": "user", "content": "son soru"}),
        ];
        trim_old_assistant_messages(&mut messages);
        let trimmed = messages[1]["content"].as_str().unwrap();
        assert!(trimmed.contains("trimmed from this older reply"), "{}", &trimmed[..80.min(trimmed.len())]);
        assert!(trimmed.chars().count() < 4_100);
        // Son 2 asistan mesajı DOKUNULMAZ.
        assert_eq!(messages[3]["content"], "kısa yanıt 1");
        assert_eq!(messages[4]["content"], "kısa yanıt 2");
    }

    #[test]
    fn duplicate_calls_in_round_are_pointers() {
        let tmp = std::env::temp_dir().join(format!("thx_dup_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("d.txt"), "içerik satırı
").unwrap();
        let calls: Vec<Value> = (0..2)
            .map(|i| {
                json!({
                    "id": format!("c{}", i),
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{\"path\":\"d.txt\"}"}
                })
            })
            .collect();
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":calls}}]}),
                json!({"choices":[{"message":{"content":"tamam"}}]}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let (_, _, _, _, _, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "d.txt iki kez oku"})],
            &[],
            std::path::Path::new(&tmp),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        let seen = transport.seen.lock().unwrap_or_else(|e| e.into_inner());
        let second = &seen[1];
        let tool_contents: Vec<&str> = second["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "tool")
            .filter_map(|m| m["content"].as_str())
            .collect();
        assert_eq!(tool_contents.len(), 2);
        assert!(tool_contents[0].contains("içerik satırı"));
        assert!(tool_contents[1].contains("duplicate"), "ikincisi işaretçi: {}", tool_contents[1]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn subagent_usage_flows_into_parent() {
        let tmp = std::env::temp_dir();
        // Ana tur: dispatch_agent; alt döngü tek turda cevap verir (usage 50).
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"dispatch_agent","arguments":"{\"task\":\"bak\"}"}}
                ]}}], "usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}),
                json!({"choices":[{"message":{"content":"alt özet"}}], "usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55}}),
                json!({"choices":[{"message":{"content":"bitti"}}], "usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23}}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let (_, _, _, usage, _, _) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role": "user", "content": "araştır"})],
            &[],
            std::path::Path::new(&tmp),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        // 10 (ana tur 1) + 50 (alt döngü) + 20 (ana tur 2) = 80.
        assert_eq!(usage["prompt_tokens"], json!(80));
        assert_eq!(usage["total_tokens"], json!(90));
    }

    #[test]
    fn old_tool_results_are_trimmed_fresh_kept() {
        let big = "x".repeat(5_000);
        let mut messages = vec![
            json!({"role": "user", "content": "soru"}),
            json!({"role": "tool", "tool_call_id": "a", "content": big.clone()}),
            json!({"role": "tool", "tool_call_id": "b", "content": "kısa sonuç"}),
            json!({"role": "tool", "tool_call_id": "c", "content": big.clone()}),
        ];
        // Güncel tur: son 1 araç sonucu tam kalmalı.
        trim_old_tool_results(&mut messages, 1);
        assert!(
            messages[1]["content"].as_str().unwrap().contains("trimmed"),
            "eski büyük sonuç kırpılmalı"
        );
        assert_eq!(messages[2]["content"].as_str().unwrap(), "kısa sonuç");
        assert_eq!(
            messages[3]["content"].as_str().unwrap(),
            big,
            "güncel turun sonucu tam kalmalı"
        );
    }

    #[test]
    fn big_repeated_json_message_is_compressed_invisibly() {
        let items: Vec<String> = (0..80)
            .map(|i| format!(r#"{{"id":{},"type":"telemetry","status":"ok"}}"#, i))
            .collect();
        let payload = format!("[{}]", items.join(","));
        let mut messages = vec![json!({
            "role": "user",
            "content": format!("Bu telemetry verisini özetle:\n{}", payload),
        })];
        let bpe = tiktoken_rs::cl100k_base().unwrap();
        let (orig, comp, count) = compress_messages_invisibly(&mut messages, &bpe);
        assert!(count >= 1);
        assert!(comp < orig);
        let body = messages[0]["content"].as_str().unwrap();
        assert_ne!(body, format!("Bu telemetry verisini:\n{}", payload));
        assert!(body.contains("@T"));
    }

    #[test]
    fn assistant_messages_stay_natural() {
        let big_repeated = "aynı cümle tekrarı_".repeat(200);
        let mut messages = vec![
            json!({"role": "assistant", "content": big_repeated.clone()}),
            json!({"role": "user", "content": "kısa"}),
        ];
        let bpe = tiktoken_rs::cl100k_base().unwrap();
        let (_, _, count) = compress_messages_invisibly(&mut messages, &bpe);
        assert_eq!(count, 0);
        assert_eq!(messages[0]["content"].as_str().unwrap(), big_repeated);
    }

    #[test]
    fn is_local_endpoint_only_accepts_real_loopback() {
        assert!(is_local_endpoint(
            "http://localhost:11434/v1/chat/completions"
        ));
        assert!(is_local_endpoint(
            "http://127.0.0.1:1234/v1/chat/completions"
        ));
        assert!(is_local_endpoint("http://[::1]:8000/v1/chat/completions"));
        // Eski substring hatası: bu URL'ler YEREL sayılmamalı.
        assert!(!is_local_endpoint("https://evil.com/?x=localhost"));
        assert!(!is_local_endpoint(
            "https://evil.com/localhost/v1/chat/completions"
        ));
        assert!(!is_local_endpoint(
            "https://api.openai.com/v1/chat/completions"
        ));
        assert!(!is_local_endpoint("http://localhost.evil.com/v1"));
        assert!(!is_local_endpoint("http://attacker@127.0.0.1:11434/v1"));
    }

    /// Sıralı yanıtları oynatan sahte taşıma; istek gövdelerini de kaydeder.
    struct FakeTransport {
        responses: Vec<Value>,
        seen: std::sync::Mutex<Vec<Value>>,
    }
    impl Transport for FakeTransport {
        fn post_json(
            &self,
            _url: &str,
            _h: &[(String, String)],
            body: &Value,
        ) -> Result<Value, String> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(body.clone());
            let idx = self.seen.lock().unwrap_or_else(|e| e.into_inner()).len() - 1;
            self.responses
                .get(idx)
                .cloned()
                .ok_or_else(|| "yanıt tükendi".into())
        }
    }

    #[test]
    fn tool_loop_fetches_body_and_answers() {
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"get_code_body","arguments":"{\"name\":\"login\"}"}}
                ]}}]}),
                json!({"choices":[{"message":{"role":"assistant","content":"login fonksiyonu doğru görünüyor."}}]}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let blocks = vec![(
            "b1".to_string(),
            "login".to_string(),
            "def login(u, p): return True".to_string(),
        )];
        let messages = vec![json!({"role":"user","content":"login kontrol et"})];

        let (content, _reasoning, rounds, _usage, _edits, _todos) = run_tool_loop(
            &transport,
            "http://x",
            "key",
            "m",
            messages,
            &blocks,
            std::path::Path::new("."),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();

        assert_eq!(content, "login fonksiyonu doğru görünüyor.");
        assert_eq!(rounds, 2);
        // İkinci istekte gövdenin araç sonucu olarak iletildiğini doğrula
        let seen = transport.seen.lock().unwrap_or_else(|e| e.into_inner());
        let second = &seen[1];
        let tool_msg = &second["messages"][2];
        assert_eq!(tool_msg["role"], "tool");
        assert!(tool_msg["content"].as_str().unwrap().contains("def login"));
    }

    #[test]
    fn unknown_tool_name_reports_not_found() {
        let transport = FakeTransport {
            responses: vec![
                json!({"choices":[{"message":{"tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"get_code_body","arguments":"{\"name\":\"yok\"}"}}
                ]}}]}),
                json!({"choices":[{"message":{"content":"bulamadım"}}]}),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let blocks = vec![(
            "b1".to_string(),
            "login".to_string(),
            "def login(): pass".to_string(),
        )];
        let (content, _reasoning, _, _usage, _edits, _todos) = run_tool_loop(
            &transport,
            "http://x",
            "k",
            "m",
            vec![json!({"role":"user","content":"x"})],
            &blocks,
            std::path::Path::new("."),
            4,
            None,
            GenOptions::default(),
            false,
            false,
            tools::EngineCtx::default(),
        )
        .unwrap();
        assert_eq!(content, "bulamadım");
    }

    #[test]
    fn finalize_edits_applies_search_replace() {
        let blocks = vec![(
            "b1".to_string(),
            "login.py".to_string(),
            "def login(u, p):\n    return False".to_string(),
        )];
        let content = "Düzeltme yaptım:\nlogin.py\n<<<<<<< SEARCH\n    return False\n=======\n    return True\n>>>>>>> REPLACE\n";
        let edits = finalize_edits(content, &blocks);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0]["applied"], Value::Bool(true));
        let nb = edits[0]["new_body"].as_str().unwrap();
        assert!(nb.contains("return True"), "gövde güncellenmeli: {}", nb);
    }

    #[test]
    fn code_context_sends_schema_not_body() {
        // Küçük gövde eşiği altı ham gönderilir; şema iddiası BÜYÜK gövde için.
        let big_sample = crate::engine::code_shrink::SAMPLE.repeat(4);
        let blocks = vec![(
            "b1".into(),
            "sample.py".into(),
            big_sample,
        )];
        let bpe = tiktoken_rs::cl100k_base().unwrap();
        let ctx = build_code_context(&blocks, &bpe).unwrap();
        assert!(ctx.contains("SCHEMA"));
        assert!(ctx.contains("class ConfigurationManager:"));
        // Gövdedeki benzersiz satır şemada OLMAMALI (bağlam tasarrufu kanıtı)
        assert!(!ctx.contains("raise LookupError"));
    }

    #[test]
    fn extract_code_block_parses_fence() {
        let content = "İşte yeni hali:\n```python\ndef f():\n    return 1\n```\n";
        assert_eq!(
            extract_code_block(content).unwrap(),
            "def f():\n    return 1"
        );
    }

    #[test]
    fn whole_file_fallback_returns_new_body() {
        struct S;
        impl Transport for S {
            fn post_json(
                &self,
                _u: &str,
                _h: &[(String, String)],
                _b: &Value,
            ) -> Result<Value, String> {
                Ok(
                    json!({"choices":[{"message":{"content":"Yeni hali:\n```python\ndef f():\n    return 2\n```\n"}}]}),
                )
            }
        }
        let blocks = vec![(
            "b1".to_string(),
            "f.py".to_string(),
            "def f():\n    return 1".to_string(),
        )];
        let out = whole_file_fallback(
            &S,
            "http://x",
            "k",
            "m",
            &[json!({"role":"user","content":"f'yi 2 döndür"})],
            &blocks,
            None,
            GenOptions::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(out[0]["applied"], Value::Bool(true));
        assert!(out[0]["new_body"].as_str().unwrap().contains("return 2"));
    }

    #[test]
    fn fallback_skipped_for_plain_question_with_context_blocks() {
        // Bağlam için code_blocks var ama model SEARCH/REPLACE üretmedi
        // (düz soru-cevap) → yedek DENENMEMELİ: ikinci LLM çağrısı + sahte
        // "applied" olmamalı.
        let edits: Vec<Value> = vec![];
        assert!(!should_try_whole_file_fallback(
            "Cevap: fonksiyon doğru görünüyor, değişiklik gerekmez.",
            &edits,
            true
        ));
    }

    #[test]
    fn fallback_runs_when_edit_attempted_but_failed() {
        // Model düzenleme denedi ama SEARCH bloğu eşleşmedi → yedek denenmeli.
        let edits = vec![json!({"file":"f.py","applied":false,"message":"no match","new_body":null})];
        let content = "f.py\n<<<<<<< SEARCH\n    return 9\n=======\n    return 2\n>>>>>>> REPLACE\n";
        assert!(should_try_whole_file_fallback(content, &edits, true));
    }

    #[test]
    fn fallback_skipped_when_edit_already_applied() {
        let edits = vec![json!({"file":"f.py","applied":true,"message":"ok","new_body":"x"})];
        let content = "f.py\n<<<<<<< SEARCH\n    return 1\n=======\n    return 2\n>>>>>>> REPLACE\n";
        assert!(!should_try_whole_file_fallback(content, &edits, true));
    }

    #[test]
    fn fallback_skipped_without_blocks() {
        let edits: Vec<Value> = vec![];
        let content = "f.py\n<<<<<<< SEARCH\n a\n=======\n b\n>>>>>>> REPLACE\n";
        assert!(!should_try_whole_file_fallback(content, &edits, false));
    }
}

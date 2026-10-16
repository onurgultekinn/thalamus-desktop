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


use crate::engine::{edits, schema};

use super::{tools, BackendState};
use axum::extract::State;

/// Sağlayıcı HTTP taşıması — testlerde stub'lanır.
pub trait Transport: Send + Sync {
    fn post_json(&self, url: &str, headers: &[(String, String)], body: &Value) -> Result<Value, String>;
}

pub struct HttpTransport;

impl Transport for HttpTransport {
    fn post_json(&self, url: &str, headers: &[(String, String)], body: &Value) -> Result<Value, String> {
        let client = reqwest::blocking::Client::new();
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
    pub api_key: String,
    pub model: String,
    pub messages: Value,
    #[serde(default)]
    pub code_blocks: Vec<CodeBlockIn>,
}

fn provider_url(provider: &str, base_url: Option<&str>) -> Result<String, String> {
    match provider {
        "deepseek" => Ok("https://api.deepseek.com/v1/chat/completions".into()),
        "openai" => Ok("https://api.openai.com/v1/chat/completions".into()),
        _ => base_url
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("{}/chat/completions", s.trim_end_matches('/')))
            .ok_or_else(|| format!("bilinmeyen sağlayıcı '{}' ve base_url yok", provider)),
    }
}

/// Kod bağlamı: gövde yerine ŞEMA gönderilir (bağlam tasarrufu);
/// gövde `get_code_body` aracıyla istenir. Düzenlemeler aider tarzı
/// SEARCH/REPLACE blokları olarak beklenir.
fn build_code_context(blocks: &[(String, String, String)]) -> Option<String> {
    if blocks.is_empty() {
        return None;
    }
    let mut out = String::from(
        "Kod bağlamı ŞEMA olarak verilmiştir (imzalar + satır aralıkları + çağrı ilişkileri).\n\
         - Kısa gövdeler şemada TAM OLARAK verilmiştir; uzun gövdeler için get_code_body aracını çağır.\n\
         - \"çağırır:\" notu o tanımın hangi fonksiyonları kullandığını gösterir — bir hatayı araştırıyorsan\n\
         veya değişikliğin etkisini bilmiyorsan İLGİLİ TÜM fonksiyonları fetch et (fetch ucuzdur, eksik bağlam pahalıdır).\n\
         - Değişikliklerini şu formatta döndür (her blok için):\n\
         ```\n\
         <dosya adı>\n\
         <<<<<<< SEARCH\n\
         (değiştirilecek satırların BİREBİR kopyası)\n\
         =======\n\
         (yeni satırlar)\n\
         >>>>>>> REPLACE\n\
         ```\n\
         SEARCH mevcut kodla birebir eşleşmelidir; birden çok blok verebilirsin.\n\nŞEMA:\n",
    );
    for (id, name, body) in blocks {
        let _ = id;
        match schema::extract_schema(body) {
            Some(s) => out.push_str(&format!("--- {} ---\n{}\n", name, schema::render_schema(&s))),
            None => out.push_str(&format!(
                "--- {} (şema çıkarılamadı, tam gövde) ---\n{}\n",
                name, body
            )),
        }
    }
    Some(out)
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
fn whole_file_fallback(
    transport: &dyn Transport,
    url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    blocks: &[(String, String, String)],
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
    let resp = transport.post_json(
        url,
        &[("Authorization".to_string(), format!("Bearer {}", api_key))],
        &json!({"model": model, "messages": msgs}),
    )?;
    let content = resp["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(extract_code_block(&content).map(|code| {
        vec![json!({
            "file": name,
            "applied": true,
            "message": "whole-file yedeği ile uygulandı (SEARCH/REPLACE eşleşmedi)",
            "new_body": code,
        })]
    }))
}

/// Tool-call döngüsü. Araçlar `tools` kayıt sisteminden gelir (dosya/arama/
/// şema); tümü workspace köküne sınırlıdır. Döndürür: (içerik, tur, usage).
pub fn run_tool_loop(
    transport: &dyn Transport,
    url: &str,
    api_key: &str,
    model: &str,
    mut messages: Vec<Value>,
    code_blocks: &[(String, String, String)],
    root: &std::path::Path,
    max_rounds: usize,
) -> Result<(String, usize, Value), String> {
    let tools_json = tools::specs();
    let ctx = tools::ToolCtx { root, code_blocks };
    let headers = vec![("Authorization".to_string(), format!("Bearer {}", api_key))];
    let mut rounds = 0usize;
    let mut usage = Value::Null;

    loop {
        rounds += 1;
        if rounds > max_rounds {
            return Err(format!("tool döngüsü sınırı aşıldı ({} tur)", max_rounds));
        }
        let body = json!({"model": model, "messages": messages, "tools": tools_json});
        let resp = transport.post_json(url, &headers, &body)?;
        if let Some(u) = resp.get("usage") {
            usage = u.clone(); // son yanıtın kullanımı
        }
        let msg = resp["choices"][0]["message"].clone();
        if msg.is_null() {
            return Err("sağlayıcı yanıtı beklenmedik biçimde boş".into());
        }
        let tool_calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
        if tool_calls.is_empty() {
            let content = msg["content"].as_str().unwrap_or("").to_string();
            return Ok((content, rounds, usage));
        }
        messages.push(msg);
        for tc in &tool_calls {
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args_raw = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
            let result = tools::execute(&name, &args, &ctx);
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc["id"].as_str().unwrap_or(""),
                "content": result,
            }));
        }
    }
}

/// Proje belleği: workspace kökündeki AGENTS.md / CLAUDE.md / THALAMUS.md
/// içeriği AI bağlamına eklenir (ZCode ve Claude Code ekolü).
fn project_memory(root: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for name in ["AGENTS.md", "CLAUDE.md", "THALAMUS.md"] {
        let p = std::path::Path::new(root).join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                parts.push(format!("--- {} ---\n{}", name, text.trim()));
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!(
            "PROJE YÖNERGELERİ (bu talimatlara uy):\n{}",
            parts.join("\n\n")
        ))
    }
}

pub async fn ai_chat(
    State(state): State<BackendState>,
    axum::Json(req): axum::Json<AiChatRequest>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let url = provider_url(&req.provider, req.base_url.as_deref())
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    // Local endpoint'ler (Ollama, LM Studio…) anahtarsız kullanılabilir;
    // bulut sağlayıcılar için anahtar zorunludur.
    let is_local_base = url.contains("localhost") || url.contains("127.0.0.1");
    if req.api_key.trim().is_empty() && !is_local_base {
        return Err((axum::http::StatusCode::BAD_REQUEST, "api_key gerekli".into()));
    }
    let messages = req.messages.as_array().cloned().unwrap_or_default();
    if messages.is_empty() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "messages boş olamaz".into()));
    }
    let blocks: Vec<(String, String, String)> = req
        .code_blocks
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.body.clone()))
        .collect();

    // Kod bağlamı + proje belleği sistem mesajları.
    let messages_before_context = messages.clone();
    let mut messages = messages;
    if let Some(ctx) = build_code_context(&blocks) {
        messages.insert(0, json!({"role": "system", "content": ctx}));
    }
    if let Some(mem) = project_memory(&state.workspace_root.read().unwrap_or_else(|e| e.into_inner()).clone()) {
        messages.insert(0, json!({"role": "system", "content": mem}));
    }

    let blocks_for_task = blocks.clone();
    let url_for_task = url.clone();
    let api_key_for_task = req.api_key.clone();
    let model_for_task = req.model.clone();
    let root_for_task = state
        .workspace_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
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
        )
    })
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, e))?;

    let edits = finalize_edits(&result.0, &blocks);

    // Aider stratejisi: SEARCH/REPLACE eşleşmediyse whole-file yedeği dene.
    let all_failed = edits.is_empty() || edits.iter().all(|e| e["applied"] == Value::Bool(false));
    let edits = if all_failed && !blocks.is_empty() {
        let transport = HttpTransport;
        match whole_file_fallback(
            &transport,
            &url,
            &req.api_key,
            &req.model,
            &messages_before_context,
            &blocks,
        ) {
            Ok(Some(fb)) => fb,
            _ => edits,
        }
    } else {
        edits
    };

    Ok(axum::Json(json!({
        "content": result.0,
        "rounds": result.1,
        "usage": result.2,
        "edits": edits,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sıralı yanıtları oynatan sahte taşıma; istek gövdelerini de kaydeder.
    struct FakeTransport {
        responses: Vec<Value>,
        seen: std::sync::Mutex<Vec<Value>>,
    }
    impl Transport for FakeTransport {
        fn post_json(&self, _url: &str, _h: &[(String, String)], body: &Value) -> Result<Value, String> {
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).push(body.clone());
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
        let blocks = vec![("b1".to_string(), "login".to_string(), "def login(u, p): return True".to_string())];
        let messages = vec![json!({"role":"user","content":"login kontrol et"})];

        let (content, rounds, _usage) =
            run_tool_loop(&transport, "http://x", "key", "m", messages, &blocks, std::path::Path::new("."), 4).unwrap();

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
        let blocks = vec![("b1".to_string(), "login".to_string(), "def login(): pass".to_string())];
        let (content, _, _usage) = run_tool_loop(&transport, "http://x", "k", "m", vec![json!({"role":"user","content":"x"})], &blocks, std::path::Path::new("."), 4).unwrap();
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
        let blocks = vec![("b1".into(), "sample.py".into(), crate::engine::code_shrink::SAMPLE.into())];
        let ctx = build_code_context(&blocks).unwrap();
        assert!(ctx.contains("ŞEMA"));
        assert!(ctx.contains("class ConfigurationManager:"));
        // Gövdedeki benzersiz satır şemada OLMAMALI (bağlam tasarrufu kanıtı)
        assert!(!ctx.contains("raise LookupError"));
    }

    #[test]
    fn extract_code_block_parses_fence() {
        let content = "İşte yeni hali:\n```python\ndef f():\n    return 1\n```\n";
        assert_eq!(extract_code_block(content).unwrap(), "def f():\n    return 1");
    }

    #[test]
    fn whole_file_fallback_returns_new_body() {
        struct S;
        impl Transport for S {
            fn post_json(&self, _u: &str, _h: &[(String, String)], _b: &Value) -> Result<Value, String> {
                Ok(json!({"choices":[{"message":{"content":"Yeni hali:\n```python\ndef f():\n    return 2\n```\n"}}]}))
            }
        }
        let blocks = vec![("b1".to_string(), "f.py".to_string(), "def f():\n    return 1".to_string())];
        let out = whole_file_fallback(
            &S,
            "http://x",
            "k",
            "m",
            &[json!({"role":"user","content":"f'yi 2 döndür"})],
            &blocks,
        )
        .unwrap()
        .unwrap();
        assert_eq!(out[0]["applied"], Value::Bool(true));
        assert!(out[0]["new_body"].as_str().unwrap().contains("return 2"));
    }
}

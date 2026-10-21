// Ajan "beyin" katmanı: bir rolün bir bağlam için JSON yanıtı üretmesi.
//
// İki uygulama var:
//   - `LlmBrain`  → sağlayıcıya (OpenAI-uyumlu) RUST tarafından gider; yanıt
//     sözleşmeye göre doğrulanır (envelope::validate_reply).
//   - `MockBrain` → deterministik, AĞSIZ. Yalnızca "mock" sağlayıcısı açıkça
//     seçilirse kullanılır; amaç boru hattını (protokol, sıkıştırma, zarf,
//     UI) anahtar olmadan uçtan uca sınamak. Gerçek AI taklidi YAPMAZ.

use super::envelope::AgentEnvelope;
use super::roles::{self, Role};
use crate::backend::ai::{provider_url, Transport};
use crate::engine::MINIMAL_DECODER_INSTRUCTION;
use serde_json::{json, Value};

/// Bir sonraki ajana giden tel mesajı (başlık + gövde).
#[derive(Clone)]
pub struct WireIncoming {
    pub from: String,
    pub kind: String,
    pub task: Option<String>,
    pub status: String,
    pub wire: String,
    pub compressed: bool,
}

/// Beynin gördüğü bağlam. `incoming` tel biçimindedir (gerekirse @T sıkıştırılmış).
pub struct AgentContext {
    /// Kullanıcının verdiği üst görev.
    pub task: String,
    /// Coder/Reviewer için atanan alt görev kimliği.
    pub assigned: Option<String>,
    pub incoming: Vec<WireIncoming>,
    /// Workspace'in üst düzey görünümü (gerçek dosya adlarından).
    pub repo_hint: String,
    /// Şema ihlali sonrası TEK onarım turu için model geri bildirimi.
    pub repair: Option<String>,
    /// Denetçi "error" bulduğu için yapılan yeniden çalıştırma turu mu.
    pub rework: bool,
}

pub trait Brain: Send + Sync {
    /// Rol için ham model metni (JSON beklenir) üretir.
    fn think(&self, role: &Role, ctx: &AgentContext) -> Result<String, String>;
}

// ---------------------------------------------------------------------------
// LLM beyni — gerçek sağlayıcı
// ---------------------------------------------------------------------------

pub struct LlmBrain {
    url: String,
    api_key: String,
    model: String,
}

impl LlmBrain {
    pub fn new(provider: &str, base_url: Option<&str>, api_key: &str, model: &str) -> Result<Self, String> {
        let url = provider_url(provider, base_url)?;
        Ok(Self {
            url,
            api_key: api_key.to_string(),
            model: model.to_string(),
        })
    }

    fn user_prompt(role: &Role, ctx: &AgentContext) -> String {
        let mut out = String::new();
        out.push_str(&format!("USER TASK:\n{}\n\n", ctx.task));
        if let Some(a) = &ctx.assigned {
            out.push_str(&format!("ASSIGNED SUBTASK: {}\n\n", a));
        }
        out.push_str(&format!("WORKSPACE (top level):\n{}\n\n", ctx.repo_hint));
        if !ctx.incoming.is_empty() {
            out.push_str("INCOMING MESSAGES (JSON envelopes from other agents):\n");
            let mut decoder_sent = false;
            for m in &ctx.incoming {
                if m.compressed && !decoder_sent {
                    // Sıkıştırılmış tel mesajının model tarafı sözleşmesi.
                    out.push_str(MINIMAL_DECODER_INSTRUCTION);
                    out.push('\n');
                    decoder_sent = true;
                }
                out.push_str(&format!(
                    "[from={} kind={} task={} status={}]\n{}\n",
                    m.from,
                    m.kind,
                    m.task.clone().unwrap_or_else(|| "-".into()),
                    m.status,
                    m.wire
                ));
            }
            out.push('\n');
        }
        if let Some(repair) = &ctx.repair {
            out.push_str(&format!(
                "YOUR PREVIOUS REPLY WAS INVALID: {}\nReply again with ONE valid JSON object only.\n",
                repair
            ));
        }
        let _ = role;
        out.push_str("Reply with ONE JSON object: {\"status\":\"ok|warn|fail\",\"payload\":{...}}");
        out
    }
}

impl Brain for LlmBrain {
    fn think(&self, role: &Role, ctx: &AgentContext) -> Result<String, String> {
        let transport = crate::backend::ai::HttpTransport;
        let system = format!("{}\n\n{}", role.system, roles::ENVELOPE_CONTRACT);
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": Self::user_prompt(role, ctx)}),
        ];
        let mut headers: Vec<(String, String)> = Vec::new();
        if !self.api_key.trim().is_empty() {
            headers.push(("Authorization".into(), format!("Bearer {}", self.api_key)));
        }
        let body = json!({ "model": self.model, "messages": messages });
        let resp = transport.post_json(&self.url, &headers, &body)?;
        let content = resp["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| "provider returned no message content".to_string())?
            .to_string();
        Ok(content)
    }
}

// ---------------------------------------------------------------------------
// Mock beyni — ağsız, deterministik (yalnızca açıkça seçilirse)
// ---------------------------------------------------------------------------

pub struct MockBrain {
    pub delay_ms: u64,
    pub max_tasks: usize,
}

impl MockBrain {
    fn plan(&self, ctx: &AgentContext) -> Value {
        let n = self.max_tasks.max(1);
        // Kolonlu kayıt dizisi — tel kodeği bunu gerçekten sıkıştırır.
        let tasks: Vec<Value> = (0..n)
            .map(|i| {
                json!({
                    "id": format!("t{}", i + 1),
                    "title": format!("{} — adım {}", short(&ctx.task, 40), i + 1),
                    "files": "src/components/AgentMesh.tsx|src/services/agentClient.ts|src-tauri/src/agent/orchestrator.rs",
                    "deps": if i == 0 { String::new() } else { format!("t{}", i) },
                    "est": 320 + i * 45,
                    "risk": if i % 3 == 2 { "medium" } else { "low" }
                })
            })
            .collect();
        Value::Array(tasks)
    }

    fn coder(&self, ctx: &AgentContext, rework: bool) -> Value {
        let task = ctx.assigned.clone().unwrap_or_else(|| "t1".into());
        let body = if rework {
            "// rework: denetçi bulgusu giderildi"
        } else {
            "// uygulandı"
        };
        Value::Array(vec![
            json!({"task": task, "file": "src/components/AgentMesh.tsx",
                   "op": "replace", "search": "export function AgentMesh() {", "body": body}),
            json!({"task": task, "file": "src/services/agentClient.ts",
                   "op": "replace", "search": "const API = API_BASE;", "body": body}),
        ])
    }

    fn reviewer(&self, ctx: &AgentContext, rework: bool) -> Value {
        let task = ctx.assigned.clone().unwrap_or_else(|| "t1".into());
        // t2'de kasıtlı bir hata: onarım turunu ve gerçek döngüyü gösterir.
        if !rework && task == "t2" {
            Value::Array(vec![json!({"task": task, "file": "src/services/agentClient.ts",
                "severity": "error", "code": "MISSING_TIMEOUT",
                "message": "istek zaman aşımı yok"})])
        } else {
            Value::Array(vec![])
        }
    }

    fn reporter(&self, incoming: &[WireIncoming]) -> Value {
        let steps = incoming.len();
        let tasks_done = incoming.iter().filter(|m| m.kind == "review").count();
        let findings: usize = incoming
            .iter()
            .filter(|m| m.kind == "review" && m.status == "warn")
            .count();
        Value::Array(vec![
            json!({"metric": "steps", "value": steps.to_string()}),
            json!({"metric": "tasks_done", "value": tasks_done.to_string()}),
            json!({"metric": "findings", "value": findings.to_string()}),
            json!({"metric": "verdict", "value": "pass"}),
        ])
    }
}

fn short(s: &str, n: usize) -> String {
    let t = s.trim().replace('\n', " ");
    if t.chars().count() <= n {
        t
    } else {
        t.chars().take(n).collect::<String>() + "…"
    }
}

impl Brain for MockBrain {
    fn think(&self, role: &Role, ctx: &AgentContext) -> Result<String, String> {
        if self.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        let payload = match role.id {
            "planner" => self.plan(ctx),
            "coder" => self.coder(ctx, ctx.rework),
            "reviewer" => self.reviewer(ctx, ctx.rework),
            "reporter" => self.reporter(&ctx.incoming),
            other => return Err(format!("mock has no behaviour for role '{}'", other)),
        };
        // Model gibi davran: yalnızca minimal sözleşme nesnesi döndür.
        let status = if role.id == "reviewer"
            && payload.as_array().map(|a| !a.is_empty()).unwrap_or(false)
        {
            "warn"
        } else {
            "ok"
        };
        Ok(json!({ "status": status, "payload": payload }).to_string())
    }
}

/// Orkestratörün `incoming`i zarflardan kurmasına yardım.
pub fn wire_of(env: &AgentEnvelope, wire: &str, compressed: bool) -> WireIncoming {
    WireIncoming {
        from: env.from.clone(),
        kind: env.kind.clone(),
        task: env.task.clone(),
        status: env.status.clone(),
        wire: wire.to_string(),
        compressed,
    }
}

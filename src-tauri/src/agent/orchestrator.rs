// Ajan Ağı orkestratörü.
//
// Akış (ribozym'in A2→A5→A7→A3 hattının sadeleştirilmişi):
//   user task → PLANNER (görev DAG'ı) → her alt görev için CODER → REVIEWER
//   → (denetçi "error" bulursa TEK onarım turu) → REPORTER (koddan türetilen sayılar)
//
// Her adım TEK bir JSON zarfı üretir; zarfın tel biçimi kayıpsız @T motorundan
// geçer. Ölçülen bilanço (ham token / tel token / tasarruf) run state'te tutulur
// ve arayüz bunu dürüstçe gösterir.

use super::brain::{wire_of, AgentContext, Brain, LlmBrain, MockBrain, WireIncoming};
use super::envelope::{encode_wire, validate_reply, AgentEnvelope, WirePayload, PROTOCOL_VERSION};
use super::roles::{Role, CODER, PLANNER, REPORTER, REVIEWER};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tiktoken_rs::CoreBPE;

/// Toplam döngü güvenliği: tek bir run'da izin verilen en fazla LLM turu.
const MAX_CALLS: usize = 48;

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub status: String, // idle | thinking | done | error
    pub calls: usize,
    pub tokens_in: usize,
    pub tokens_out: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireMessage {
    pub seq: usize,
    pub ts_ms: u64,
    pub from: String,
    pub to: Vec<String>,
    pub kind: String,
    pub task: Option<String>,
    pub status: String,
    /// Çözülmüş zarf (arayüzün "Doğal" görünümü).
    pub raw: Value,
    /// Tel biçimi — sıkıştırılmışsa @T, değilse ham JSON ("Tel" görünümü).
    pub wire: String,
    pub raw_tokens: usize,
    pub wire_tokens: usize,
    pub compressed: bool,
    pub lossless: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RunMetrics {
    pub raw_tokens: usize,
    pub wire_tokens: usize,
    pub saved_tokens: usize,
    pub savings_pct: f64,
    pub llm_calls: usize,
    pub repairs: usize,
    pub messages: usize,
    pub findings: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunState {
    pub run_id: String,
    pub task: String,
    pub provider: String,
    pub model: String,
    pub status: String, // queued | running | done | failed | cancelled
    pub phase: String,
    pub error: Option<String>,
    pub agents: Vec<AgentInfo>,
    pub messages: Vec<WireMessage>,
    pub metrics: RunMetrics,
    /// Arayüzün "Tel" görünümünde göstereceği dekoder sözleşmesi.
    pub decoder: String,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
}

pub struct AgentRun {
    pub state: RunState,
    pub cancel: Arc<AtomicBool>,
}

pub type SharedRuns = Arc<Mutex<HashMap<String, Arc<Mutex<AgentRun>>>>>;

#[derive(Debug, Deserialize)]
pub struct RunRequest {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    pub task: String,
    #[serde(default)]
    pub max_tasks: Option<usize>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_run_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("r-{}-{}", now_ms(), n)
}

fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Workspace'in üst düzey görünümü — ajanların gerçek dosya adlarını görmesi için.
fn repo_hint(root: &str) -> String {
    let path = std::path::Path::new(root);
    let mut items: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten().take(40) {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            items.push(format!("{}{}", name, if is_dir { "/" } else { "" }));
        }
    }
    items.sort();
    items.truncate(30);
    if items.is_empty() {
        "(workspace root could not be listed)".to_string()
    } else {
        items.join(", ")
    }
}

fn targets(role_id: &str) -> Vec<String> {
    match role_id {
        "planner" => vec!["coder".into()],
        "coder" => vec!["reviewer".into()],
        "reviewer" => vec!["coder".into(), "reporter".into()],
        _ => vec![],
    }
}

fn phase_label(role: &Role, assigned: &Option<String>) -> String {
    match assigned {
        Some(t) => format!("{} · {}", role.id, t),
        None => role.id.to_string(),
    }
}

fn agent_mut<'a>(state: &'a mut RunState, id: &str) -> Option<&'a mut AgentInfo> {
    state.agents.iter_mut().find(|a| a.id == id)
}

/// Payload kolonlu kayıt dizisidir; görev kimlikleri `id` hücresinden okunur.
fn extract_task_ids(payload: &Value, max_tasks: usize) -> Vec<String> {
    let mut ids: Vec<String> = payload
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        // Planlayıcı id vermediyse makine devralır (model değil).
        ids = (1..=max_tasks).map(|i| format!("t{}", i)).collect();
    }
    ids.truncate(max_tasks);
    ids
}

fn has_error_finding(env: &AgentEnvelope) -> bool {
    env.payload
        .as_array()
        .map(|arr| {
            arr.iter()
                .any(|f| f.get("severity").and_then(|s| s.as_str()) == Some("error"))
        })
        .unwrap_or(false)
}

fn recent(history: &[WireIncoming], n: usize) -> Vec<WireIncoming> {
    let start = history.len().saturating_sub(n);
    history[start..].to_vec()
}

/// Tek ajan turu: düşün → doğrula (gerekirse TEK onarım) → zarfla → tele kodla → kaydet.
fn step(
    run: &Arc<Mutex<AgentRun>>,
    brain: &dyn Brain,
    bpe: &CoreBPE,
    role: &Role,
    mut ctx: AgentContext,
) -> Result<(AgentEnvelope, WirePayload), String> {
    {
        let mut r = lock(run);
        if let Some(a) = agent_mut(&mut r.state, role.id) {
            a.status = "thinking".into();
        }
        r.state.phase = phase_label(role, &ctx.assigned);
    }

    let first = brain.think(role, &ctx)?;
    let (status, payload) = match validate_reply(&first) {
        Ok(v) => v,
        Err(err) => {
            // Şema ihlali: TEK onarım turu (ribozym §14 ruhu).
            {
                let mut r = lock(run);
                r.state.metrics.repairs += 1;
                r.state.metrics.llm_calls += 1;
            }
            ctx.repair = Some(err.clone());
            let second = brain.think(role, &ctx)?;
            validate_reply(&second).map_err(|e2| {
                format!("MODEL_SCHEMA_INVALID: {} (first attempt: {})", e2, err)
            })?
        }
    };

    let (run_id, seq) = {
        let r = lock(run);
        (r.state.run_id.clone(), r.state.messages.len() + 1)
    };

    let env = AgentEnvelope {
        v: PROTOCOL_VERSION,
        id: format!("e-{}", seq),
        run: run_id,
        from: role.id.to_string(),
        to: targets(role.id),
        kind: role.kind.to_string(),
        task: ctx.assigned.clone(),
        r#ref: None,
        status: status.clone(),
        payload: payload.clone(),
    };
    let wire = encode_wire(&env, bpe);

    {
        let mut r = lock(run);
        let st = &mut r.state;
        st.metrics.llm_calls += 1;
        st.metrics.messages += 1;
        st.metrics.raw_tokens += wire.raw_tokens;
        st.metrics.wire_tokens += wire.wire_tokens;
        st.metrics.saved_tokens += wire.raw_tokens.saturating_sub(wire.wire_tokens);
        st.metrics.savings_pct = if st.metrics.raw_tokens > 0 {
            100.0 * st.metrics.saved_tokens as f64 / st.metrics.raw_tokens as f64
        } else {
            0.0
        };
        if role.kind == "review" {
            if let Some(arr) = payload.as_array() {
                st.metrics.findings += arr.len();
            }
        }
        st.messages.push(WireMessage {
            seq,
            ts_ms: now_ms(),
            from: env.from.clone(),
            to: env.to.clone(),
            kind: env.kind.clone(),
            task: env.task.clone(),
            status: env.status.clone(),
            raw: serde_json::to_value(&env).unwrap_or(Value::Null),
            wire: wire.wire.clone(),
            raw_tokens: wire.raw_tokens,
            wire_tokens: wire.wire_tokens,
            compressed: wire.compressed,
            lossless: wire.lossless,
        });
        if let Some(a) = agent_mut(st, role.id) {
            a.status = if status == "fail" { "error".into() } else { "done".into() };
            a.calls += 1;
            a.tokens_in += wire.wire_tokens;
            a.tokens_out += wire.raw_tokens;
        }
    }

    Ok((env, wire))
}

fn cancelled(run: &Arc<Mutex<AgentRun>>) -> bool {
    lock(run).cancel.load(Ordering::Relaxed)
}

fn calls_exhausted(run: &Arc<Mutex<AgentRun>>) -> bool {
    lock(run).state.metrics.llm_calls >= MAX_CALLS
}

/// Boru hattını koşturur. Dönen `Err` = run başarısız (state'e yazılır).
pub fn run_pipeline(
    run: Arc<Mutex<AgentRun>>,
    brain: Box<dyn Brain>,
    bpe: Arc<CoreBPE>,
    root: String,
    max_tasks: usize,
) -> Result<(), String> {
    let repo_hint = repo_hint(&root);
    let task_text = {
        let mut r = lock(&run);
        r.state.status = "running".into();
        r.state.task.clone()
    };

    // 1) PLAN
    let ctx = AgentContext {
        task: task_text.clone(),
        assigned: None,
        incoming: vec![],
        repo_hint: repo_hint.clone(),
        repair: None,
        rework: false,
    };
    let (plan_env, plan_wire) = step(&run, brain.as_ref(), &bpe, &PLANNER, ctx)?;
    let mut history: Vec<WireIncoming> = vec![wire_of(&plan_env, &plan_wire.wire, plan_wire.compressed)];

    let task_ids = extract_task_ids(&plan_env.payload, max_tasks);

    // 2) Her alt görev için CODER → REVIEWER (+ gerekirse tek onarım turu)
    for tid in &task_ids {
        if cancelled(&run) || calls_exhausted(&run) {
            return Ok(());
        }

        let ctx = AgentContext {
                task: task_text.clone(),
            assigned: Some(tid.clone()),
            incoming: recent(&history, 4),
            repo_hint: repo_hint.clone(),
            repair: None,
            rework: false,
        };
        let (res_env, res_wire) = step(&run, brain.as_ref(), &bpe, &CODER, ctx)?;
        history.push(wire_of(&res_env, &res_wire.wire, res_wire.compressed));

        let ctx = AgentContext {
                task: task_text.clone(),
            assigned: Some(tid.clone()),
            incoming: recent(&history, 4),
            repo_hint: repo_hint.clone(),
            repair: None,
            rework: false,
        };
        let (rev_env, rev_wire) = step(&run, brain.as_ref(), &bpe, &REVIEWER, ctx)?;
        history.push(wire_of(&rev_env, &rev_wire.wire, rev_wire.compressed));

        // Onarım turu: denetçi gerçek bir "error" bulduysa, BİR kez kodlayıcıya geri dön.
        if has_error_finding(&rev_env) && !cancelled(&run) && !calls_exhausted(&run) {
            let ctx = AgentContext {
                        task: task_text.clone(),
                assigned: Some(tid.clone()),
                incoming: recent(&history, 4),
                repo_hint: repo_hint.clone(),
                repair: None,
                rework: true,
            };
            let (r2, w2) = step(&run, brain.as_ref(), &bpe, &CODER, ctx)?;
            history.push(wire_of(&r2, &w2.wire, w2.compressed));

            let ctx = AgentContext {
                        task: task_text.clone(),
                assigned: Some(tid.clone()),
                incoming: recent(&history, 4),
                repo_hint: repo_hint.clone(),
                repair: None,
                rework: true,
            };
            let (rv2, wv2) = step(&run, brain.as_ref(), &bpe, &REVIEWER, ctx)?;
            history.push(wire_of(&rv2, &wv2.wire, wv2.compressed));
        }
    }

    // 3) RAPOR
    if cancelled(&run) {
        return Ok(());
    }
    let ctx = AgentContext {
        task: task_text.clone(),
        assigned: None,
        incoming: recent(&history, 12),
        repo_hint,
        repair: None,
        rework: false,
    };
    step(&run, brain.as_ref(), &bpe, &REPORTER, ctx)?;

    Ok(())
}

/// Run'ı başlatır (arka plan iş parçacığı); `run_id` döner.
pub fn start_run(
    req: RunRequest,
    bpe: Arc<CoreBPE>,
    root: String,
    runs: SharedRuns,
) -> Result<String, String> {
    if req.task.trim().is_empty() {
        return Err("task cannot be empty".into());
    }
    let provider = req.provider.clone();
    let model = req.model.clone();
    let max_tasks = req.max_tasks.unwrap_or(5).clamp(1, 8);

    let brain: Box<dyn Brain> = if provider == "mock" {
        Box::new(MockBrain {
            delay_ms: 220,
            max_tasks,
        })
    } else {
        Box::new(LlmBrain::new(
            &provider,
            req.base_url.as_deref(),
            &req.api_key,
            &model,
        )?)
    };

    // Yerel modelde tüm koşu boyunca "meşgul" kal: sohbet sonu kapatma
    // talebi ajanın ortasındaki turda süreci öldürmesin.
    let lease = req
        .base_url
        .as_deref()
        .and_then(crate::backend::serve::begin_use);

    let run_id = new_run_id();
    let agents = [&PLANNER, &CODER, &REVIEWER, &REPORTER]
        .iter()
        .map(|r| AgentInfo {
            id: r.id.into(),
            label: r.label.into(),
            status: "idle".into(),
            calls: 0,
            tokens_in: 0,
            tokens_out: 0,
        })
        .collect();

    let state = RunState {
        run_id: run_id.clone(),
        task: req.task.clone(),
        provider,
        model,
        status: "queued".into(),
        phase: "queued".into(),
        error: None,
        agents,
        messages: vec![],
        metrics: RunMetrics::default(),
        decoder: crate::engine::MINIMAL_DECODER_INSTRUCTION.to_string(),
        started_ms: now_ms(),
        finished_ms: None,
    };

    let run = Arc::new(Mutex::new(AgentRun {
        state,
        cancel: Arc::new(AtomicBool::new(false)),
    }));
    lock(&runs).insert(run_id.clone(), run.clone());

    let bpe2 = bpe.clone();
    std::thread::spawn(move || {
        let _lease = lease;
        let result = run_pipeline(run.clone(), brain, bpe2, root, max_tasks);
        let mut r = lock(&run);
        let was_cancelled = r.state.status == "cancelled";
        match result {
            Ok(()) => {
                if !was_cancelled {
                    r.state.status = "done".into();
                }
            }
            Err(e) => {
                r.state.status = "failed".into();
                r.state.error = Some(e);
            }
        }
        r.state.finished_ms = Some(now_ms());
        if r.state.status == "done" {
            r.state.phase = "done".into();
        }
    });

    Ok(run_id)
}

/// Run'ı iptal eder (bir sonraki adım sınırında durur).
pub fn cancel_run(run_id: &str, runs: &SharedRuns) -> bool {
    let handle = lock(runs).get(run_id).cloned();
    if let Some(h) = handle {
        let mut r = lock(&h);
        r.cancel.store(true, Ordering::Relaxed);
        if r.state.status == "queued" || r.state.status == "running" {
            r.state.status = "cancelled".into();
            r.state.finished_ms = Some(now_ms());
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spawn_mock(task: &str, _max_tasks: usize) -> (String, Arc<Mutex<AgentRun>>, SharedRuns) {
        let runs: SharedRuns = Arc::new(Mutex::new(HashMap::new()));
        // Testlerde gecikmesiz mock isteriz: start_run yerine doğrudan kur.
        let run_id = "r-test".to_string();
        let state = RunState {
            run_id: run_id.clone(),
            task: task.into(),
            provider: "mock".into(),
            model: "mock".into(),
            status: "queued".into(),
            phase: "queued".into(),
            error: None,
            agents: [&PLANNER, &CODER, &REVIEWER, &REPORTER]
                .iter()
                .map(|r| AgentInfo {
                    id: r.id.into(),
                    label: r.label.into(),
                    status: "idle".into(),
                    calls: 0,
                    tokens_in: 0,
                    tokens_out: 0,
                })
                .collect(),
            messages: vec![],
            metrics: RunMetrics::default(),
            decoder: crate::engine::MINIMAL_DECODER_INSTRUCTION.into(),
            started_ms: now_ms(),
            finished_ms: None,
        };
        let run = Arc::new(Mutex::new(AgentRun {
            state,
            cancel: Arc::new(AtomicBool::new(false)),
        }));
        lock(&runs).insert(run_id.clone(), run.clone());
        (run_id, run, runs)
    }

    #[test]
    fn mock_pipeline_produces_valid_envelopes_and_savings() {
        let (_id, run, _runs) = spawn_mock("agent mesh paneli ekle", 3);
        let brain: Box<dyn Brain> = Box::new(MockBrain {
            delay_ms: 0,
            max_tasks: 3,
        });
        let bpe = Arc::new(tiktoken_rs::cl100k_base().unwrap());
        run_pipeline(run.clone(), brain, bpe, ".".into(), 3).unwrap();

        let r = lock(&run);
        let st = &r.state;
        // 1 plan + (coder+reviewer)×3 + 1 rework çifti (t2 error) + 1 rapor = 9
        assert!(st.messages.len() >= 9, "mesaj sayısı: {}", st.messages.len());
        assert_eq!(st.agents.len(), 4);
        // Her mesajın zarfı serde ile geri okunabilmeli (tipli tel).
        for m in &st.messages {
            let env: AgentEnvelope = serde_json::from_value(m.raw.clone()).unwrap();
            assert_eq!(env.v, PROTOCOL_VERSION);
            assert!(!env.from.is_empty());
        }
        // Kolonlu plan yükü sayesinde toplamda tasarruf olmalı.
        assert!(st.metrics.raw_tokens > 0);
        assert!(
            st.metrics.wire_tokens < st.metrics.raw_tokens,
            "raw {} wire {}",
            st.metrics.raw_tokens,
            st.metrics.wire_tokens
        );
        assert!(st.metrics.messages >= 9);
    }

    #[test]
    fn reporter_runs_and_findings_counted() {
        let (_id, run, _runs) = spawn_mock("x", 2);
        let brain: Box<dyn Brain> = Box::new(MockBrain {
            delay_ms: 0,
            max_tasks: 2,
        });
        let bpe = Arc::new(tiktoken_rs::cl100k_base().unwrap());
        run_pipeline(run.clone(), brain, bpe, ".".into(), 2).unwrap();
        let r = lock(&run);
        assert_eq!(r.state.messages.last().unwrap().kind, "report");
        // t2'de kasıtlı error bulgusu var → findings sayacı > 0.
        assert!(r.state.metrics.findings > 0);
    }

    #[test]
    fn cancel_stops_before_completion() {
        let (_id, run, runs) = spawn_mock("y", 5);
        assert!(cancel_run("r-test", &runs));
        assert_eq!(lock(&run).state.status, "cancelled");
    }

    #[test]
    fn extract_task_ids_is_bounded() {
        let payload = json!([{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]);
        assert_eq!(extract_task_ids(&payload, 2), vec!["a", "b"]);
        // id yoksa makine üretir.
        assert_eq!(extract_task_ids(&json!([]), 3), vec!["t1", "t2", "t3"]);
    }
}

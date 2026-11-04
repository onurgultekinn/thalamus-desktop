// Ajan Ağı orkestratörü.
//
// Akış (ribozym'in A2→A5→A7→A3 hattının sadeleştirilmişi):
//   user task → PLANNER (görev DAG'ı) → her alt görev için CODER → REVIEWER
//   → (denetçi "error" bulursa TEK onarım turu) → REPORTER (koddan türetilen sayılar)
//
// Her adım TEK bir JSON zarfı üretir; zarfın tel biçimi kayıpsız @T motorundan
// geçer. Ölçülen bilanço (ham token / tel token / tasarruf) run state'te tutulur
// ve arayüz bunu dürüstçe gösterir.

use super::scheduler;
use super::brain::{wire_of, AgentContext, Brain, LlmBrain, MockBrain, WireIncoming};
use super::envelope::{encode_wire, validate_reply, AgentEnvelope, WirePayload, PROTOCOL_VERSION};
use super::roles::{self, Role};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
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
    pub status: String, // idle | queued | thinking | done | error
    /// Bu düğümün işlevi: plan | result | review | report.
    pub kind: String,
    /// Hiyerarşideki üst düğüm (kök için None).
    pub parent: Option<String>,
    /// Düğümün kısa görevi.
    pub mission: String,
    pub calls: usize,
    pub tokens_in: usize,
    pub tokens_out: usize,
    /// Son turun süresi (ms).
    pub last_ms: u64,
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
    /// Uygulanabilir dosya düzenlemesi sayısı (kodlayıcı kayıtları).
    pub edits: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct RunProgress {
    /// Tamamlanan ajan turu (onarım turları dahil).
    pub done: usize,
    /// Planlanan asgari tur sayısı (onarım turları hariç).
    pub total: usize,
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
    pub progress: RunProgress,
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
    /// Doğrudan anahtar (eski/mock akışlar). Normal istemci GÖNDERMEZ;
    /// `use_stored_key` ile backend kasasından çözülür (JS'e key girmez).
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub use_stored_key: bool,
    pub model: String,
    pub task: String,
    #[serde(default)]
    pub max_tasks: Option<usize>,
    /// Kullanıcının ajan şirketi. Boşsa yerleşik hat çalışır.
    #[serde(default)]
    pub org: Option<OrgPlan>,
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


// ---------------------------------------------------------------------------
// Kullanıcı şirketi (frontend `Plan` tipinin eşleniği)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct OrgAgent {
    pub id: String,
    #[serde(default, rename = "parentId", alias = "parent_id")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub mission: String,
    #[serde(default)]
    pub resp: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrgLink {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrgPlan {
    #[serde(default)]
    pub name: String,
    pub agents: Vec<OrgAgent>,
    #[serde(default)]
    pub links: Vec<OrgLink>,
}

/// Düğümün kendi turunda gördüğü mesajlar: yalnızca doğrudan üstünden ve
/// bağlı olduğu düğümlerden gelir. Tüm geçmişi göndermek hem pahalıydı hem
/// yanıltıcıydı — ajan başkasının işini kendi işi sanıyordu.
fn inbox(
    produced: &HashMap<String, Vec<WireIncoming>>,
    ids: &[String],
    limit: usize,
) -> Vec<WireIncoming> {
    let mut out: Vec<WireIncoming> = Vec::new();
    for id in ids {
        if let Some(list) = produced.get(id) {
            for m in list {
                if !out.iter().any(|x| x.seq == m.seq) {
                    out.push(m.clone());
                }
            }
        }
    }
    out.sort_by_key(|m| m.seq);
    let start = out.len().saturating_sub(limit);
    out[start..].to_vec()
}


/// Bir şirkette çalıştırılabilecek en fazla düğüm (model maliyeti sınırı).
const MAX_ORG_AGENTS: usize = 12;
/// Üreticilere gönderilecek dosya başına en fazla karakter.
const FILE_CHARS: usize = 6_000;
/// Üreticilere gönderilecek en fazla dosya.
const MAX_FILES: usize = 3;

#[derive(Clone)]
struct OrgNode {
    role: Role,
    parent: Option<String>,
    children: Vec<String>,
    /// GİDEN bağlar: bu düğümün çıktısını kim alıyor (zarfın `to`su).
    linked: Vec<String>,
    /// GELEN bağlar: çıktısını bu düğüme aktaranlar (bağımlılık + girdi).
    ///
    /// Yönlendirme kusuru düzeltmesi: bağ A→B "A'nın çıktısı B'ye gider"
    /// demektir — yani B, A'yı BEKLER. Eski kod bunu tersine okuyup üreticinin
    /// kendi denetçisini beklemesine neden oluyordu.
    upstream: Vec<String>,
    /// Kullanıcının yazdığı kısa görev (UI satırında gösterilir).
    mission: String,
}

/// Şirketi çalıştırılabilir düğümlere çevirir: kimlik doğrulanır, döngü
/// kırılır, hiyerarşi (BFS) sırası kurulur.
fn build_org(plan: &OrgPlan) -> Vec<OrgNode> {
    let mut ids: Vec<String> = Vec::new();
    for a in plan.agents.iter().take(MAX_ORG_AGENTS) {
        if !a.id.trim().is_empty() && !ids.contains(&a.id) {
            ids.push(a.id.clone());
        }
    }
    let has = |id: &str| ids.iter().any(|x| x == id);

    let mut nodes: HashMap<String, OrgNode> = HashMap::new();
    for a in plan.agents.iter().take(MAX_ORG_AGENTS) {
        if !has(&a.id) {
            continue;
        }
        let parent = a.parent_id.clone().filter(|p| has(p) && p != &a.id);
        let label = if a.name.trim().is_empty() {
            a.id.clone()
        } else {
            a.name.trim().to_string()
        };
        let mission = {
            let mut m = a.mission.trim().to_string();
            let resp = a.resp.trim();
            if !resp.is_empty() {
                if !m.is_empty() {
                    m.push_str(". ");
                }
                m.push_str("Responsibilities: ");
                m.push_str(&resp.replace('\n', "; "));
            }
            m
        };
        let initial_kind = roles::classify(&format!("{} {}", a.role, a.name)).to_string();
        let short_mission = {
            let first = a.mission.trim().lines().next().unwrap_or("").trim();
            if first.is_empty() {
                a.resp.trim().lines().next().unwrap_or("").trim().to_string()
            } else {
                first.chars().take(90).collect::<String>()
            }
        };
        nodes.insert(
            a.id.clone(),
            OrgNode {
                role: roles::org_role(&a.id, &label, &a.role, &mission, &initial_kind),
                parent,
                children: vec![],
                linked: vec![],
                upstream: vec![],
                mission: short_mission,
            },
        );
    }

    // Hiyerarşiyi kur.
    let mut roots: Vec<String> = vec![];
    for id in &ids {
        let parent = nodes.get(id).and_then(|n| n.parent.clone());
        match parent {
            Some(p) if p != *id => {
                if let Some(node) = nodes.get_mut(&p) {
                    node.children.push(id.clone());
                }
            }
            _ => roots.push(id.clone()),
        }
    }
    if roots.is_empty() {
        if let Some(first) = ids.first() {
            roots.push(first.clone());
        }
    }
    // Alt ajanı olanlar plan rolüne yükselir.
    for node in nodes.values_mut() {
        if !node.children.is_empty() {
            node.role.kind = "plan".into();
        }
    }
    // Bağları iki yöne yaz: giden (zarf hedefi) ve gelen (bağımlılık/girdi).
    for l in &plan.links {
        if l.from == l.to || !has(&l.from) || !has(&l.to) {
            continue;
        }
        if let Some(node) = nodes.get_mut(&l.from) {
            if !node.linked.contains(&l.to) {
                node.linked.push(l.to.clone());
            }
        }
        if let Some(node) = nodes.get_mut(&l.to) {
            if !node.upstream.contains(&l.from) {
                node.upstream.push(l.from.clone());
            }
        }
    }

    // BFS sırası: kökten aşağı; ulaşılamayan düğümler sona eklenir.
    let mut order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = roots.clone();
    while let Some(id) = queue.first().cloned() {
        queue.remove(0);
        if !seen.insert(id.clone()) {
            continue;
        }
        order.push(id.clone());
        if let Some(n) = nodes.get(&id) {
            for c in &n.children {
                if !seen.contains(c) {
                    queue.push(c.clone());
                }
            }
        }
    }
    for id in &ids {
        if !seen.contains(id) {
            order.push(id.clone());
        }
    }

    order
        .into_iter()
        .filter_map(|id| nodes.remove(&id))
        .collect()
}

/// Düğüm bağımlılıkları: bir düğüm, ebeveyni ve GELEN bağların kaynakları
/// bitmeden çalışmaz. Ayrıca tür kuralları (üretici planı bekler, denetçi
/// denetlediği üreticileri bekler, rapor ekibin tamamını bekler).
fn build_deps(nodes: &[OrgNode]) -> HashMap<String, HashSet<String>> {
    let by_id: HashMap<&str, &OrgNode> = nodes.iter().map(|n| (n.role.id.as_str(), n)).collect();
    let plan_ids: Vec<String> = nodes
        .iter()
        .filter(|n| n.role.kind == "plan")
        .map(|n| n.role.id.clone())
        .collect();
    let producers: Vec<(String, Option<String>)> = nodes
        .iter()
        .filter(|n| n.role.kind == "result")
        .map(|n| (n.role.id.clone(), n.parent.clone()))
        .collect();

    let plan_ancestor = |n: &OrgNode| -> Option<String> {
        let mut cur = n.parent.clone();
        let mut hops = 0;
        while let Some(id) = cur {
            if hops > 32 {
                return None;
            }
            hops += 1;
            match by_id.get(id.as_str()) {
                Some(node) => {
                    if node.role.kind == "plan" {
                        return Some(id);
                    }
                    cur = node.parent.clone();
                }
                None => return None,
            }
        }
        None
    };

    let mut deps: HashMap<String, HashSet<String>> = HashMap::new();
    for n in nodes {
        let id = n.role.id.clone();
        let mut set: HashSet<String> = HashSet::new();
        if let Some(p) = &n.parent {
            set.insert(p.clone());
        }
        // GELEN bağlar bağımlılıktır (A→B: B, A'nın çıktısını bekler).
        for u in &n.upstream {
            if u != &id && by_id.contains_key(u.as_str()) {
                set.insert(u.clone());
            }
        }
        match n.role.kind.as_str() {
            "result" => {
                if let Some(p) = plan_ancestor(n) {
                    set.insert(p);
                }
                if n.parent.is_none() {
                    for p in &plan_ids {
                        set.insert(p.clone());
                    }
                }
            }
            "review" => {
                let mut targets: Vec<String> = n
                    .upstream
                    .iter()
                    .filter(|l| producers.iter().any(|(p, _)| p == *l))
                    .cloned()
                    .collect();
                if targets.is_empty() {
                    targets = producers
                        .iter()
                        .filter(|(_, parent)| parent.is_some() && *parent == n.parent)
                        .map(|(p, _)| p.clone())
                        .collect();
                }
                if targets.is_empty() {
                    targets = producers.iter().map(|(p, _)| p.clone()).collect();
                }
                for t in targets {
                    if t != id {
                        set.insert(t);
                    }
                }
            }
            "report" => {
                for other in nodes {
                    if other.role.id != id && other.role.kind != "report" {
                        set.insert(other.role.id.clone());
                    }
                }
            }
            _ => {}
        }
        set.remove(&id);
        deps.insert(id, set);
    }

    // Döngü kırma.
    let ids: Vec<String> = deps.keys().cloned().collect();
    for id in &ids {
        let mut stack: Vec<String> = deps.get(id).cloned().unwrap_or_default().into_iter().collect();
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur.clone()) {
                continue;
            }
            let entry: Option<(bool, Vec<String>)> = deps
                .get(&cur)
                .map(|set| (set.contains(id), set.iter().cloned().collect()));
            if let Some((found, next)) = entry {
                if found {
                    if let Some(s) = deps.get_mut(&cur) {
                        s.remove(id);
                    }
                }
                stack.extend(next);
            }
        }
    }
    deps
}

/// Koşu başına dosya okuma önbelleği: aynı dosya iki kez okunmaz; başarısız
/// okuma da önbelleklenir (tekrar denemek turu yavaşlatır).
fn read_files_cached(
    root: &str,
    hints: &[String],
    cache: &mut HashMap<String, Option<String>>,
) -> Vec<(String, String)> {
    for rel in hints.iter().take(MAX_FILES) {
        let rel_norm = rel.replace('\\', "/");
        if rel_norm.starts_with('/') || rel_norm.contains("..") || rel_norm.contains(':') {
            continue;
        }
        if !cache.contains_key(&rel_norm) {
            let path = std::path::Path::new(root).join(&rel_norm);
            let body = match std::fs::metadata(&path) {
                Ok(m) if m.is_file() && m.len() <= (FILE_CHARS as u64) * 8 => {
                    std::fs::read_to_string(&path).ok().map(|text| {
                        if text.chars().count() > FILE_CHARS {
                            text.chars().take(FILE_CHARS).collect::<String>() + "\n…(truncated)"
                        } else {
                            text
                        }
                    })
                }
                _ => None,
            };
            cache.insert(rel_norm.clone(), body);
        }
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for rel in hints {
        if out.len() >= MAX_FILES {
            break;
        }
        let rel_norm = rel.replace('\\', "/");
        if let Some(Some(body)) = cache.get(&rel_norm) {
            if !out.iter().any(|(p, _)| p == &rel_norm) {
                out.push((rel_norm, body.clone()));
            }
        }
    }
    out
}

/// Workspace'in önem-sıralı şema haritası: planlayıcıya GERÇEK dosya adları.
fn build_repo_map_for(root: &str, bpe: &CoreBPE, budget: usize) -> String {
    let Ok(base) = std::path::Path::new(root).canonicalize() else {
        return String::new();
    };
    let ignore = crate::backend::repo::load_ignore(&base);
    let cache: crate::backend::repo::FileCache =
        std::sync::Mutex::new(std::collections::HashMap::new());
    let mut files: Vec<crate::engine::repo_map::RepoFile> = Vec::new();
    crate::backend::repo::walk(&base, &base, 0, &cache, &ignore, &mut files);
    if files.len() > 600 {
        files.truncate(600);
    }
    if files.is_empty() {
        return String::new();
    }
    let res = crate::engine::repo_map::build_repo_map(&files, bpe, budget, None);
    if res.tokens == 0 {
        return String::new();
    }
    format!(
        "{}\n[repo map: {}/{} files, ~{} tokens]",
        res.map, res.included, res.total, res.tokens
    )
}

/// Son `review` zarfında gerçekten `error` şiddetinde bulgu var mı?
fn last_review_has_error(run: &Arc<Mutex<AgentRun>>, review_id: &str) -> bool {
    let r = lock(run);
    r.state
        .messages
        .iter()
        .rev()
        .find(|m| m.from == review_id)
        .and_then(|m| m.raw.get("payload").and_then(|p| p.as_array()).cloned())
        .map(|arr| {
            arr.iter()
                .any(|f| f.get("severity").and_then(|s| s.as_str()) == Some("error"))
        })
        .unwrap_or(false)
}

/// Kullanıcı şirketini BAĞIMLILIK GRAFİĞİNE göre çalıştırır.
///
/// Dalgalar `scheduler` modülünden gelir: bağımsız düğümler paralel koşar,
/// eşzamanlılık `MAX_PARALLEL` ile sınırlıdır, sonuçlar düğüm sırasına göre
/// (deterministik) birleştirilir. Orkestratör yalnızca POLİTİKA ile ilgilenir:
/// kim, hangi bağlamla, hangi dosyalarla koşar.
fn run_org(
    run: &Arc<Mutex<AgentRun>>,
    brain: &dyn Brain,
    bpe: &CoreBPE,
    root: &str,
    plan: &OrgPlan,
    max_tasks: usize,
) -> Result<(), String> {
    let repo = repo_hint(root);
    let repo_map = build_repo_map_for(root, bpe, 700);
    let task_text = {
        let mut r = lock(run);
        r.state.status = "running".into();
        r.state.task.clone()
    };
    let nodes = build_org(plan);
    if nodes.is_empty() {
        return Err("org has no usable agents".into());
    }
    let deps = build_deps(&nodes);
    let index: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.role.id.clone(), i))
        .collect();
    let kind_of: HashMap<String, String> = nodes
        .iter()
        .map(|n| (n.role.id.clone(), n.role.kind.clone()))
        .collect();

    let mut produced: HashMap<String, Vec<WireIncoming>> = HashMap::new();
    let mut plan_files: HashMap<String, Vec<String>> = HashMap::new();
    let mut file_cache: HashMap<String, Option<String>> = HashMap::new();

    {
        let mut r = lock(run);
        r.state.progress.total = nodes.len();
        r.state.progress.done = 0;
        for a in r.state.agents.iter_mut() {
            a.status = "queued".into();
        }
    }

    let names = |n: &OrgNode| -> Vec<String> {
        let mut v = n.linked.clone();
        for c in &n.children {
            if !v.contains(c) {
                v.push(c.clone());
            }
        }
        v
    };
    let inputs_for = |n: &OrgNode| -> Vec<String> {
        let mut input: Vec<String> = Vec::new();
        if let Some(p) = &n.parent {
            input.push(p.clone());
        }
        // GELEN bağlar girdidir (A→B: A'nın çıktısı B'nin prompt'una girer).
        for u in &n.upstream {
            if !input.contains(u) {
                input.push(u.clone());
            }
        }
        if n.role.kind == "result" {
            for d in deps.get(&n.role.id).cloned().unwrap_or_default() {
                if kind_of.get(&d).map(|k| k == "plan").unwrap_or(false) && !input.contains(&d) {
                    input.push(d);
                }
            }
        }
        input
    };

    // DALGALAR: mekanik katman scheduler'da.
    let idx_deps: Vec<HashSet<usize>> = nodes
        .iter()
        .map(|n| {
            deps.get(&n.role.id)
                .map(|set| set.iter().filter_map(|d| index.get(d).copied()).collect())
                .unwrap_or_default()
        })
        .collect();
    let waves = scheduler::compute_waves(nodes.len(), &idx_deps);

    for wave_idx in &waves {
        if enough(run) {
            return Ok(());
        }
        let wave: Vec<&OrgNode> = wave_idx.iter().filter_map(|i| nodes.get(*i)).collect();
        if wave.is_empty() {
            continue;
        }

        // Bağlamlar dalga başında kurulur; paralel iş parçacıkları yalnızca
        // KENDİ bağlamlarını okur.
        let mut prepared: Vec<(usize, Role, Vec<String>, AgentContext)> = Vec::new();
        for node in &wave {
            let input = inputs_for(node);
            let hints: Vec<String> = match node.role.kind.as_str() {
                "result" | "review" => {
                    let mut h: Vec<String> = Vec::new();
                    for src in &input {
                        if let Some(list) = plan_files.get(src) {
                            for f in list {
                                if !h.contains(f) {
                                    h.push(f.clone());
                                }
                            }
                        }
                    }
                    if h.is_empty() {
                        plan_files.values().flatten().cloned().collect()
                    } else {
                        h
                    }
                }
                _ => vec![],
            };
            let files = read_files_cached(root, &hints, &mut file_cache);
            let ctx = AgentContext {
                task: task_text.clone(),
                assigned: if node.role.kind == "result" || node.role.kind == "review" {
                    Some(node.role.label.clone())
                } else {
                    None
                },
                incoming: inbox(&produced, &input, 8),
                repo_hint: repo.clone(),
                repair: None,
                rework: false,
                files,
                repo_map: if matches!(node.role.kind.as_str(), "plan" | "result") {
                    repo_map.clone()
                } else {
                    String::new()
                },
            };
            // Plan düğümünün prompt'u GERÇEK alt görev bütçesini taşır.
            let role = if node.role.kind == "plan" {
                roles::with_budget(node.role.clone(), max_tasks)
            } else {
                node.role.clone()
            };
            prepared.push((
                *index.get(&node.role.id).unwrap_or(&0),
                role,
                names(node),
                ctx,
            ));
        }

        // Sınırlı eşzamanlılık: dalga MAX_PARALLEL'lık parçalara bölünür.
        let mut first_err: Option<String> = None;
        for chunk in prepared.chunks(scheduler::MAX_PARALLEL) {
            if enough(run) {
                return Ok(());
            }
            let mut results: Vec<(usize, String, Result<(AgentEnvelope, WirePayload), String>)> =
                Vec::with_capacity(chunk.len());
            std::thread::scope(|scope| {
                let mut handles = Vec::with_capacity(chunk.len());
                for (idx, role, to, ctx) in chunk.iter() {
                    let role = role.clone();
                    let to = to.clone();
                    let ctx = ctx.clone();
                    let idx = *idx;
                    let id = role.id.clone();
                    handles.push((
                        idx,
                        id,
                        scope.spawn(move || step(run, brain, bpe, &role, to, ctx)),
                    ));
                }
                for (idx, id, h) in handles {
                    match h.join() {
                        Ok(v) => results.push((idx, id, v)),
                        Err(_) => results.push((idx, id, Err("agent thread panicked".into()))),
                    }
                }
            });

            // Deterministik birleştirme: düğüm sırası, tamamlanma sırası değil.
            // Hata olsa da KARDEŞ SONUÇLAR işlenir — eski `?` erken dönüşü
            // aynı parçadaki başarılı sonuçları kaybediyordu.
            results.sort_by_key(|(idx, _, _)| *idx);
            for (_idx, id, res) in results {
                match res {
                    Ok((env, w)) => {
                        if kind_of.get(&id).map(|k| k == "plan").unwrap_or(false) {
                            let hints = collect_file_hints(&env.payload);
                            if !hints.is_empty() {
                                plan_files.insert(id.clone(), hints);
                            }
                        }
                        produced
                            .entry(id.clone())
                            .or_default()
                            .push(wire_of(&env, &w.wire, w.compressed));
                    }
                    Err(e) => {
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                }
            }
        }
        if let Some(e) = first_err {
            return Err(e);
        }
    }

    // Onarım: denetçi "error" bulduysa denetlediği üreticiyi BİR kez yeniden
    // çalıştır. Üretici bulguyu VE kendi önceki çıktısını görür; ardından aynı
    // denetçi yeni çıktıyı DOĞRULAR (yoksa koşu çözülmemiş hatayla biterdi).
    let review_ids: Vec<String> = nodes
        .iter()
        .filter(|n| n.role.kind == "review")
        .map(|n| n.role.id.clone())
        .collect();
    let mut reworked: HashSet<String> = HashSet::new();
    for review_id in &review_ids {
        if enough(run) {
            return Ok(());
        }
        if !last_review_has_error(run, review_id) {
            continue;
        }
        let target = deps.get(review_id).and_then(|set| {
            nodes
                .iter()
                .find(|n| {
                    set.contains(&n.role.id)
                        && n.role.kind == "result"
                        && !reworked.contains(&n.role.id)
                })
                .map(|n| n.role.clone())
        });
        let Some(target_role) = target else {
            continue;
        };
        if enough(run) {
            return Ok(());
        }
        reworked.insert(target_role.id.clone());

        let mut input: Vec<String> = vec![review_id.clone()];
        if produced.contains_key(&target_role.id) {
            input.push(target_role.id.clone());
        }
        let hints: Vec<String> = plan_files.values().flatten().cloned().collect();
        let ctx = AgentContext {
            task: task_text.clone(),
            assigned: Some(target_role.label.clone()),
            incoming: inbox(&produced, &input, 6),
            repo_hint: repo.clone(),
            repair: None,
            rework: true,
            files: read_files_cached(root, &hints, &mut file_cache),
            repo_map: String::new(),
        };
        let (env, w) = step(run, brain, bpe, &target_role, vec![review_id.clone()], ctx)?;
        produced
            .entry(target_role.id.clone())
            .or_default()
            .push(wire_of(&env, &w.wire, w.compressed));

        // DOĞRULAMA turu.
        if enough(run) {
            return Ok(());
        }
        if let Some(reviewer_role) = nodes
            .iter()
            .find(|n| n.role.id == *review_id)
            .map(|n| n.role.clone())
        {
            let verify_input: Vec<String> = vec![target_role.id.clone()];
            let hints: Vec<String> = plan_files.values().flatten().cloned().collect();
            let vctx = AgentContext {
                task: task_text.clone(),
                assigned: Some(target_role.label.clone()),
                incoming: inbox(&produced, &verify_input, 6),
                repo_hint: repo.clone(),
                repair: None,
                rework: false,
                files: read_files_cached(root, &hints, &mut file_cache),
                repo_map: String::new(),
            };
            let (renv, rw) = step(run, brain, bpe, &reviewer_role, vec![], vctx)?;
            produced
                .entry(review_id.clone())
                .or_default()
                .push(wire_of(&renv, &rw.wire, rw.compressed));
        }
    }

    if produced.is_empty() {
        return Err("org produced no messages (no plan/result/review/report agent)".into());
    }
    Ok(())
}

/// Tek ajan turu: düşün → doğrula (gerekirse TEK onarım) → zarfla → tele kodla → kaydet.
fn step(
    run: &Arc<Mutex<AgentRun>>,
    brain: &dyn Brain,
    bpe: &CoreBPE,
    role: &Role,
    to: Vec<String>,
    mut ctx: AgentContext,
) -> Result<(AgentEnvelope, WirePayload), String> {
    let t0 = now_ms();
    {
        let mut r = lock(run);
        if let Some(a) = agent_mut(&mut r.state, &role.id) {
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
        from: role.id.clone(),
        to,
        kind: role.kind.clone(),
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
        if role.kind == "result" {
            if let Some(arr) = payload.as_array() {
                st.metrics.edits += arr
                    .iter()
                    .filter(|e| e.get("file").is_some_and(|f| f.is_string()))
                    .count();
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
        st.progress.done += 1;
        if let Some(a) = agent_mut(st, &role.id) {
            a.status = if status == "fail" { "error".into() } else { "done".into() };
            a.calls += 1;
            a.tokens_in += wire.wire_tokens;
            a.tokens_out += wire.raw_tokens;
            a.last_ms = now_ms().saturating_sub(t0);
        }
    }

    Ok((env, wire))
}

fn cancelled(run: &Arc<Mutex<AgentRun>>) -> bool {
    lock(run).cancel.load(Ordering::Relaxed)
}

/// Görev kimliklerini/hücrelerini yükten çıkarır (dosya ipuçları için).
fn collect_file_hints(payload: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = payload.as_array() {
        for rec in arr {
            for key in ["file", "files"] {
                if let Some(cell) = rec.get(key).and_then(|c| c.as_str()) {
                    for part in cell.split('|') {
                        let p = part.trim();
                        if !p.is_empty() && !out.iter().any(|x| x == p) {
                            out.push(p.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Döngü güvenliği: iptal ya da tur bütçesi tükendi mi?
fn enough(run: &Arc<Mutex<AgentRun>>) -> bool {
    cancelled(run) || calls_exhausted(run)
}

fn calls_exhausted(run: &Arc<Mutex<AgentRun>>) -> bool {
    lock(run).state.metrics.llm_calls >= MAX_CALLS
}

/// Boru hattını koşturur. Dönen `Err` = run başarısız (state'e yazılır).
pub fn builtin_roles() -> (Role, Role, Role, Role) {
    (roles::planner(), roles::coder(), roles::reviewer(), roles::reporter())
}

fn run_pipeline(
    run: Arc<Mutex<AgentRun>>,
    brain: Box<dyn Brain>,
    bpe: Arc<CoreBPE>,
    root: String,
    max_tasks: usize,
) -> Result<(), String> {
    let (planner, coder, reviewer, reporter) = builtin_roles();
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
        files: vec![],
        repo_map: String::new(),
    };
    let (plan_env, plan_wire) = step(&run, brain.as_ref(), &bpe, &planner, vec![coder.id.clone()], ctx)?;
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
            files: vec![],
            repo_map: String::new(),
        };
        let (res_env, res_wire) = step(&run, brain.as_ref(), &bpe, &coder, vec![reviewer.id.clone()], ctx)?;
        history.push(wire_of(&res_env, &res_wire.wire, res_wire.compressed));

        let ctx = AgentContext {
                task: task_text.clone(),
            assigned: Some(tid.clone()),
            incoming: recent(&history, 4),
            repo_hint: repo_hint.clone(),
            repair: None,
            rework: false,
            files: vec![],
            repo_map: String::new(),
        };
        let (rev_env, rev_wire) = step(&run, brain.as_ref(), &bpe, &reviewer, vec![coder.id.clone(), reporter.id.clone()], ctx)?;
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
                files: vec![],
                repo_map: String::new(),
            };
            let (r2, w2) = step(&run, brain.as_ref(), &bpe, &coder, vec![reviewer.id.clone()], ctx)?;
            history.push(wire_of(&r2, &w2.wire, w2.compressed));

            let ctx = AgentContext {
                        task: task_text.clone(),
                assigned: Some(tid.clone()),
                incoming: recent(&history, 4),
                repo_hint: repo_hint.clone(),
                repair: None,
                rework: true,
                files: vec![],
                repo_map: String::new(),
            };
            let (rv2, wv2) = step(&run, brain.as_ref(), &bpe, &reviewer, vec![coder.id.clone(), reporter.id.clone()], ctx)?;
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
        files: vec![],
        repo_map: String::new(),
    };
    step(&run, brain.as_ref(), &bpe, &reporter, vec![], ctx)?;

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
    let org = req.org.clone().filter(|o| !o.agents.is_empty());

    let brain: Box<dyn Brain> = if provider == "mock" {
        Box::new(MockBrain {
            delay_ms: 220,
            max_tasks,
        })
    } else {
        // Anahtar: açıkça verilmişse o, yoksa kasa (DPAPI). Hata mesajında
        // anahtar değeri asla yer almaz.
        let resolved_key = if !req.api_key.trim().is_empty() {
            req.api_key.trim().to_string()
        } else if req.use_stored_key {
            crate::secrets::imp::secret_get(req.provider.trim())
                .map_err(|e| format!("key vault read failed: {}", e))?
                .ok_or_else(|| format!("no stored key for connection '{}'", req.provider))?
        } else {
            String::new()
        };
        Box::new(LlmBrain::new(
            &provider,
            req.base_url.as_deref(),
            &resolved_key,
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
    // Ajan şeridi: şirket varsa GERÇEK düğümler; yoksa yerleşik dört rol.
    let agents: Vec<AgentInfo> = match &org {
        Some(plan) => build_org(plan)
            .iter()
            .map(|n| AgentInfo {
                id: n.role.id.clone(),
                label: n.role.label.clone(),
                status: "queued".into(),
                kind: n.role.kind.clone(),
                parent: n.parent.clone(),
                mission: n.mission.clone(),
                calls: 0,
                tokens_in: 0,
                tokens_out: 0,
                last_ms: 0,
            })
            .collect(),
        None => {
            let (planner, coder, reviewer, reporter) = builtin_roles();
            [&planner, &coder, &reviewer, &reporter]
                .iter()
                .map(|r| AgentInfo {
                    id: r.id.clone(),
                    label: r.label.clone(),
                    status: "idle".into(),
                    kind: r.kind.clone(),
                    parent: None,
                    mission: match r.kind.as_str() {
                        "plan" => "Break the task into steps",
                        "result" => "Implement each step",
                        "review" => "Check the result",
                        _ => "Summarize the run",
                    }
                    .into(),
                    calls: 0,
                    tokens_in: 0,
                    tokens_out: 0,
                    last_ms: 0,
                })
                .collect()
        }
    };

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
        decoder: super::envelope::wire_decoder_contract(),
        progress: RunProgress::default(),
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
        let result = match &org {
            Some(plan) => run_org(&run, brain.as_ref(), &bpe2, &root, plan, max_tasks),
            None => run_pipeline(run.clone(), brain, bpe2, root, max_tasks),
        };
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
        // Bitmemiş düğümler "sırada/düşünüyor" olarak asılı kalmasın.
        let final_status = r.state.status.clone();
        for a in r.state.agents.iter_mut() {
            if a.status == "queued" || a.status == "thinking" {
                a.status = if final_status == "cancelled" { "cancelled" } else { "idle" }.into();
            }
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
            agents: vec![],
            messages: vec![],
            metrics: RunMetrics::default(),
            decoder: super::super::envelope::wire_decoder_contract(),
            progress: RunProgress::default(),
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

    fn org_fixture() -> OrgPlan {
        serde_json::from_value(json!({
            "name": "Team",
            "agents": [
                {"id":"lead","parent_id":null,"name":"Lead","role":"Strategy","mission":"own direction","resp":""},
                {"id":"dev","parent_id":"lead","name":"Backend","role":"Backend","mission":"write the API","resp":""},
                {"id":"qa","parent_id":"lead","name":"QA","role":"QA","mission":"audit the API","resp":""}
            ],
            "links": []
        }))
        .unwrap()
    }

    fn bpe() -> Arc<CoreBPE> {
        Arc::new(tiktoken_rs::cl100k_base().unwrap())
    }

    fn mock_brain(max_tasks: usize) -> Box<dyn Brain> {
        Box::new(MockBrain { delay_ms: 0, max_tasks })
    }

    #[test]
    fn org_pipeline_runs_the_users_own_nodes() {
        let (id, run, _runs) = spawn_mock("ekle", 3);
        run_org(&run, mock_brain(3).as_ref(), &bpe(), ".", &org_fixture(), 3).unwrap();
        let r = lock(&run);
        assert_eq!(r.state.run_id, id);
        let kinds: Vec<&str> = r.state.messages.iter().map(|m| m.kind.as_str()).collect();
        assert_eq!(kinds.first(), Some(&"plan"));
        assert!(kinds.contains(&"result"));
        assert!(kinds.contains(&"review"));
        for m in &r.state.messages {
            let env: AgentEnvelope = serde_json::from_value(m.raw.clone()).unwrap();
            let back = super::super::envelope::decode_wire_envelope(&m.wire).unwrap();
            assert_eq!(back, env);
        }
    }

    #[test]
    fn link_direction_makes_producer_run_before_reviewer() {
        let plan: OrgPlan = serde_json::from_value(json!({
            "agents": [
                {"id":"lead","parent_id":null,"name":"Lead","role":"Lead"},
                {"id":"api","parent_id":"lead","name":"API","role":"Backend"},
                {"id":"qa","parent_id":"lead","name":"QA","role":"QA"}
            ],
            "links": [{"from":"api","to":"qa","label":"reviews"}]
        }))
        .unwrap();
        let (_id, run, _runs) = spawn_mock("yon", 2);
        run_org(&run, mock_brain(2).as_ref(), &bpe(), ".", &plan, 2).unwrap();
        let seq: Vec<String> = lock(&run).state.messages.iter().map(|m| m.from.clone()).collect();
        let pos = |id: &str| seq.iter().position(|x| x == id).unwrap();
        assert!(pos("api") < pos("qa"), "uretici denetciDEN once kosmali; sira: {seq:?}");
    }

    #[test]
    fn reviewer_inbox_contains_the_producer_result() {
        struct CaptureBrain {
            review_from: Arc<Mutex<Vec<Vec<String>>>>,
        }
        impl Brain for CaptureBrain {
            fn think(&self, role: &Role, ctx: &AgentContext) -> Result<String, String> {
                if role.kind == "review" {
                    lock(&self.review_from)
                        .push(ctx.incoming.iter().map(|m| m.from.clone()).collect());
                }
                let payload = match role.kind.as_str() {
                    "plan" => json!([{"id":"t1","title":"x","files":"","deps":"","est":1,"risk":"low"}]),
                    "result" => json!([{"task":"t1","file":"f.md","op":"create","search":"","body":"x"}]),
                    _ => json!([]),
                };
                Ok(json!({"status":"ok","payload":payload}).to_string())
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let brain = CaptureBrain { review_from: seen.clone() };
        let plan: OrgPlan = serde_json::from_value(json!({
            "agents": [
                {"id":"lead","parent_id":null,"name":"Lead","role":"Lead"},
                {"id":"api","parent_id":"lead","name":"API","role":"Backend"},
                {"id":"qa","parent_id":"lead","name":"QA","role":"QA"}
            ],
            "links": [{"from":"api","to":"qa","label":"reviews"}]
        }))
        .unwrap();
        let (_id, run, _runs) = spawn_mock("girdi", 2);
        run_org(&run, &brain, &bpe(), ".", &plan, 2).unwrap();
        let froms = lock(&seen);
        assert!(!froms.is_empty(), "denetci cagrilmali");
        let last = &froms[froms.len() - 1];
        assert!(
            last.iter().any(|f| f == "api"),
            "denetcinin girdisi ureticinin sonucunu icermeli: {last:?}"
        );
    }

    #[test]
    fn independent_workers_run_concurrently() {
        use std::sync::atomic::{AtomicUsize, Ordering as Ao};
        struct SlowBrain {
            in_flight: Arc<AtomicUsize>,
            peak: Arc<AtomicUsize>,
        }
        impl Brain for SlowBrain {
            fn think(&self, role: &Role, _ctx: &AgentContext) -> Result<String, String> {
                let cur = self.in_flight.fetch_add(1, Ao::SeqCst) + 1;
                self.peak.fetch_max(cur, Ao::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(120));
                self.in_flight.fetch_sub(1, Ao::SeqCst);
                let payload = if role.kind == "plan" {
                    json!([{"id":"t1","title":"x","files":"","deps":"","est":1,"risk":"low"}])
                } else {
                    json!([])
                };
                Ok(json!({"status":"ok","payload":payload}).to_string())
            }
        }
        let plan: OrgPlan = serde_json::from_value(json!({
            "agents": [
                {"id":"root","parent_id":null,"name":"Root","role":"Lead"},
                {"id":"w1","parent_id":"root","name":"W1","role":"Backend"},
                {"id":"w2","parent_id":"root","name":"W2","role":"Backend"},
                {"id":"w3","parent_id":"root","name":"W3","role":"Backend"}
            ],
            "links": []
        }))
        .unwrap();
        let peak = Arc::new(AtomicUsize::new(0));
        let brain = SlowBrain { in_flight: Arc::new(AtomicUsize::new(0)), peak: peak.clone() };
        let (_id, run, _runs) = spawn_mock("paralel", 3);
        run_org(&run, &brain, &bpe(), ".", &plan, 3).unwrap();
        let peak = peak.load(Ao::SeqCst);
        assert!(peak >= 2, "bagimsiz ureticiler ayni anda kosmali (olculen: {peak})");
    }

    #[test]
    fn sibling_results_survive_a_failing_node() {
        struct HalfBroken;
        impl Brain for HalfBroken {
            fn think(&self, role: &Role, _ctx: &AgentContext) -> Result<String, String> {
                if role.id == "bad" {
                    return Ok("this is not json at all".to_string());
                }
                let payload = if role.kind == "plan" {
                    json!([{"id":"t1","title":"x","files":"","deps":"","est":1,"risk":"low"}])
                } else {
                    json!([])
                };
                Ok(json!({"status":"ok","payload":payload}).to_string())
            }
        }
        let plan: OrgPlan = serde_json::from_value(json!({
            "agents": [
                {"id":"lead","parent_id":null,"name":"Lead","role":"Lead"},
                {"id":"bad","parent_id":"lead","name":"Bad","role":"Backend"},
                {"id":"good","parent_id":"lead","name":"Good","role":"Frontend"}
            ],
            "links": []
        }))
        .unwrap();
        let (_id, run, _runs) = spawn_mock("yarim", 2);
        let out = run_org(&run, &HalfBroken, &bpe(), ".", &plan, 2);
        assert!(out.is_err(), "kalici hata kosuyu basarisiz bitirmeli");
        let r = lock(&run);
        let froms: Vec<&str> = r.state.messages.iter().map(|m| m.from.as_str()).collect();
        assert!(
            froms.contains(&"good"),
            "kardesin basarili sonucu kaybolmamali; sira: {froms:?}"
        );
    }

    #[test]
    fn progress_tracks_done_and_total() {
        let (_id, run, _runs) = spawn_mock("x", 2);
        run_org(&run, mock_brain(2).as_ref(), &bpe(), ".", &org_fixture(), 2).unwrap();
        let p = lock(&run).state.progress;
        assert_eq!(p.total, 3, "3 dugumlu sirkette 3 tur planlanir");
        assert!(p.done >= p.total);
    }

    #[test]
    fn mock_edits_never_target_real_source_files() {
        let (_id, run, _runs) = spawn_mock("x", 2);
        run_org(&run, mock_brain(2).as_ref(), &bpe(), ".", &org_fixture(), 2).unwrap();
        let r = lock(&run);
        let mut seen = 0;
        for m in &r.state.messages {
            if m.kind != "result" {
                continue;
            }
            for rec in m.raw["payload"].as_array().into_iter().flatten() {
                let file = rec["file"].as_str().unwrap_or_default();
                assert!(
                    file.starts_with("agent-demo/"),
                    "mock gercek dosya hedeflememeli: {file}"
                );
                seen += 1;
            }
        }
        assert!(seen > 0, "mock en az bir duzenleme uretmeli");
    }


    const AGENT_TERMINAL: [&str; 3] = ["done", "failed", "cancelled"];

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
        // Ajan şeridi `start_run` tarafından kurulur; bu test boru hattını
        // doğrudan çağırdığı için şerit boştur. Zarfların rol dağılımına bak.
        let froms: std::collections::HashSet<&str> =
            st.messages.iter().map(|m| m.from.as_str()).collect();
        assert!(froms.contains("planner") && froms.contains("coder"));
        assert!(froms.contains("reviewer") && froms.contains("reporter"));
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

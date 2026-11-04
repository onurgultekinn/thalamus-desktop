// Ajan rolleri — her rolün sözleşmesi (system prompt) ve beklenen yük şeması.
//
// Sözleşmenin özü: model SERBEST METİN yazmaz. Yalnızca tek bir JSON nesnesi
// döndürür: `{"status":"ok|warn|fail","payload":{...}}`. Zarfın kimlik/rota
// alanlarını orkestratör yazar (bkz. envelope.rs). Payload'lar LİSTELİ ve
// DÜZGÜN ANAHTARLI tasarlanır — mevcut @T motorunun en iyi sıkıştırdığı biçim.
//
// İki kaynak var:
//   - Yerleşik hat (planlayıcı → kodlayıcı → denetçi → raportör).
//   - Kullanıcının kendi ajan şirketi: her düğüm adını/görevini taşır, yük
//     şeması düğümün işlevine göre (plan / result / review) seçilir.

/// Tüm rollere ortak sözleşme metni.
pub const ENVELOPE_CONTRACT: &str = "\
You are one node in a multi-agent mesh. You DO NOT write prose, explanations, \
greetings, or markdown around data. Reply with EXACTLY ONE JSON object and \
nothing else, matching:\n\
{\"status\":\"ok|warn|fail\",\"payload\":<payload-schema>}\n\
Rules: (1) no text outside the JSON; (2) payload MUST be a top-level ARRAY of \
records with IDENTICAL keys on every record (columnar); (3) use only string, \
number, boolean or null cell values — NEVER nested arrays/objects; (4) join any \
list into one string with '|' (e.g. files); (5) keep string values short and \
factual; (6) never invent files that are not in the input.";

/// Rol tanımı. Alanlar sahipli `String`: yerleşik rollerin yanı sıra
/// kullanıcının planından gelen dinamik ajanlar da aynı tipte temsil edilir.
#[derive(Debug, Clone)]
pub struct Role {
    pub id: String,
    pub label: String,
    /// Bu rolün ürettiği zarf türü (kind).
    pub kind: String,
    pub system: String,
}

fn role(id: &str, label: &str, kind: &str, system: &str) -> Role {
    Role {
        id: id.to_string(),
        label: label.to_string(),
        kind: kind.to_string(),
        system: system.to_string(),
    }
}

pub fn planner() -> Role {
    role(
        "planner",
        "Planlayıcı",
        "plan",
        "You are the PLANNER agent. Decompose the user task into an ordered \
list of small, independently verifiable subtasks.\n\
payload-schema (array of records): \
[{\"id\":\"t1\",\"title\":\"short\",\"files\":\"a.ts|b.ts\",\"deps\":\"\",\
\"est\":400,\"risk\":\"low\"}]\n\
risk is low|medium|high. Use at most {max_tasks} records, ids t1..tN in \
dependency order. Name only files that appear in the REPO MAP.",
    )
}

pub fn coder() -> Role {
    role(
        "coder",
        "Kodlayıcı",
        "result",
        "You are the CODER agent. Implement the ASSIGNED task only, producing \
concrete minimal edits.\n\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"op\":\"replace\",\
\"search\":\"exact existing lines\",\"body\":\"replacement lines\"}]\n\
Every record must reference a file that appears in the task. Keep edits minimal.",
    )
}

pub fn reviewer() -> Role {
    role(
        "reviewer",
        "Denetçi",
        "review",
        "You are the REVIEWER agent. Check the coder result against the task. \
Report only real problems; if the result is sound, return an EMPTY ARRAY.\n\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"severity\":\"error\",\
\"code\":\"SHORT_CODE\",\"message\":\"short\"}]\n\
severity is info|warn|error. Use \"error\" ONLY when requirements are genuinely unmet.",
    )
}

pub fn reporter() -> Role {
    role(
        "reporter",
        "Raportör",
        "report",
        "You are the REPORTER agent. Summarize the run from the messages you \
received. Numbers must be countable facts from the input, not estimates.\n\
payload-schema (array of records): \
[{\"metric\":\"steps\",\"value\":\"6\"},{\"metric\":\"tasks_done\",\"value\":\"3\"},\
{\"metric\":\"findings\",\"value\":\"2\"},{\"metric\":\"verdict\",\"value\":\"pass\"}]",
    )
}

// ---------------------------------------------------------------------------
// Kullanıcı şirketinden gelen ajanlar
// ---------------------------------------------------------------------------

/// Yük şeması seçenekleri. Aynı sözleşme metni, üç farklı yük biçimi.
pub const SCHEMA_PLAN: &str = "\
payload-schema (array of records): \
[{\"id\":\"t1\",\"title\":\"short\",\"files\":\"a.ts|b.ts\",\"deps\":\"\",\
\"est\":400,\"risk\":\"low\"}]\n\
Decompose YOUR mission only. risk is low|medium|high. ids t1..tN in dependency \
order. Use at most {max_tasks} records and name only files that appear in the \
REPO MAP.";

pub const SCHEMA_RESULT: &str = "\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"op\":\"replace|create\",\
\"search\":\"exact existing lines (empty for create)\",\"body\":\"new lines\"}]\n\
Produce the smallest edits that fulfil YOUR mission. Only files visible in the input.";

pub const SCHEMA_REVIEW: &str = "\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"severity\":\"error|warn|info\",\
\"code\":\"SHORT_CODE\",\"message\":\"short\"}]\n\
Check the work against the mission. Return an EMPTY ARRAY when it is sound; \
use \"error\" only when the requirement is genuinely unmet.";

pub const SCHEMA_REPORT: &str = "\
payload-schema (array of records): \
[{\"metric\":\"steps\",\"value\":\"6\"},{\"metric\":\"done\",\"value\":\"3\"},\
{\"metric\":\"findings\",\"value\":\"2\"},{\"metric\":\"verdict\",\"value\":\"pass\"}]";

/// Rol metninden işlevi çıkarır: denetim mi, rapor mu, üretim mi?
/// Yalnızca metin eşlemesi yapılır; model çağrılmaz, ek token harcanmaz.
pub fn classify(kind_hint: &str) -> &'static str {
    let k = kind_hint.to_lowercase();
    const REVIEW: &[&str] = &[
        "review", "qa", "test", "audit", "verify", "check", "denet", "kontrol",
    ];
    const REPORT: &[&str] = &["report", "summary", "lead", "chief", "rapor", "özet", "lider"];
    if REVIEW.iter().any(|w| k.contains(w)) {
        "review"
    } else if REPORT.iter().any(|w| k.contains(w)) {
        "report"
    } else {
        "result"
    }
}

/// Kullanıcı şirketindeki bir düğümden rol üretir.
///
/// `kind` "plan" ise düğümün alt ajanları vardır (işi bölüştürür); aksi halde
/// yük şeması `classify` sonucuna göre seçilir.
pub fn org_role(id: &str, name: &str, role_text: &str, mission: &str, kind: &str) -> Role {
    let identity = format!(
        "You are `{}` — {} — one node in a multi-agent team. \
Your mission: {}. Stay inside that mission; other nodes cover the rest.",
        name,
        if role_text.trim().is_empty() {
            "team member"
        } else {
            role_text.trim()
        },
        if mission.trim().is_empty() {
            "(no mission given; infer it from the user task)"
        } else {
            mission.trim()
        }
    );
    let schema = match kind {
        "plan" => SCHEMA_PLAN,
        "review" => SCHEMA_REVIEW,
        "report" => SCHEMA_REPORT,
        _ => SCHEMA_RESULT,
    };
    role(id, name, kind, &format!("{}\n{}", identity, schema))
}

/// Prompt'taki `{max_tasks}` yer tutucusunu GERÇEK bütçeyle değiştirir.
///
/// Kusur düzeltmesi: yer tutucu hiç ikame edilmiyordu — model literal
/// "{max_tasks}" görüyor, alt görev sınırı hiç iletilmiyordu.
pub fn with_budget(mut role: Role, max: usize) -> Role {
    role.system = role.system.replace("{max_tasks}", &max.to_string());
    role
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_roles_without_model_calls() {
        assert_eq!(classify("QA Engineer"), "review");
        assert_eq!(classify("Denetim"), "review");
        assert_eq!(classify("Backend"), "result");
        assert_eq!(classify("Lead"), "report");
        assert_eq!(classify(""), "result");
    }

    #[test]
    fn org_role_carries_identity_and_schema() {
        let r = org_role("a1", "Reviewer Bot", "QA", "check the API", "review");
        assert_eq!(r.id, "a1");
        assert_eq!(r.kind, "review");
        assert!(r.system.contains("Reviewer Bot"));
        assert!(r.system.contains("check the API"));
        assert!(r.system.contains("severity"));
    }

    #[test]
    fn with_budget_replaces_the_placeholder() {
        let r = with_budget(planner(), 4);
        assert!(r.system.contains("at most 4 records"));
        assert!(!r.system.contains("{max_tasks}"));
        // Şirket plan düğümü şeması da aynı yer tutucuyu taşır.
        let org = with_budget(org_role("x", "X", "Lead", "m", "plan"), 3);
        assert!(org.system.contains("at most 3 records"));
        assert!(!org.system.contains("{max_tasks}"));
    }
}

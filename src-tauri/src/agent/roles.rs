// Ajan rolleri — her rolün sözleşmesi (system prompt) ve beklenen yük şeması.
//
// Sözleşmenin özü: model SERBEST METİN yazmaz. Yalnızca tek bir JSON nesnesi
// döndürür: `{"status":"ok|warn|fail","payload":{...}}`. Zarfın kimlik/rota
// alanlarını orkestratör yazar (bkz. envelope.rs). Payload'lar LİSTELİ ve
// DÜZGÜN ANAHTARLI tasarlanır — mevcut @T motorunun en iyi sıkıştırdığı biçim.

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

#[derive(Debug, Clone, Copy)]
pub struct Role {
    pub id: &'static str,
    pub label: &'static str,
    /// Bu rolün ürettiği zarf türü (kind).
    pub kind: &'static str,
    pub system: &'static str,
}

pub const PLANNER: Role = Role {
    id: "planner",
    label: "Planlayıcı",
    kind: "plan",
    system: "You are the PLANNER agent. Decompose the user task into an ordered \
list of small, independently verifiable subtasks.\n\
payload-schema (array of records): \
[{\"id\":\"t1\",\"title\":\"short\",\"files\":\"a.ts|b.ts\",\"deps\":\"\",\
\"est\":400,\"risk\":\"low\"}]\n\
risk is low|medium|high. Use at most {max_tasks} records, ids t1..tN in \
dependency order.",
};

pub const CODER: Role = Role {
    id: "coder",
    label: "Kodlayıcı",
    kind: "result",
    system: "You are the CODER agent. Implement the ASSIGNED task only, producing \
concrete minimal edits.\n\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"op\":\"replace\",\
\"search\":\"exact existing lines\",\"body\":\"replacement lines\"}]\n\
Every record must reference a file that appears in the task. Keep edits minimal.",
};

pub const REVIEWER: Role = Role {
    id: "reviewer",
    label: "Denetçi",
    kind: "review",
    system: "You are the REVIEWER agent. Check the coder result against the task. \
Report only real problems; if the result is sound, return an EMPTY ARRAY.\n\
payload-schema (array of records): \
[{\"task\":\"t1\",\"file\":\"path\",\"severity\":\"error\",\
\"code\":\"SHORT_CODE\",\"message\":\"short\"}]\n\
severity is info|warn|error. Use \"error\" ONLY when requirements are genuinely unmet.",
};

pub const REPORTER: Role = Role {
    id: "reporter",
    label: "Raportör",
    kind: "report",
    system: "You are the REPORTER agent. Summarize the run from the messages you \
received. Numbers must be countable facts from the input, not estimates.\n\
payload-schema (array of records): \
[{\"metric\":\"steps\",\"value\":\"6\"},{\"metric\":\"tasks_done\",\"value\":\"3\"},\
{\"metric\":\"findings\",\"value\":\"2\"},{\"metric\":\"verdict\",\"value\":\"pass\"}]",
};


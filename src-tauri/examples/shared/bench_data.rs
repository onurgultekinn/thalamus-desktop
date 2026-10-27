// bench_public ve bench_dump tarafindan paylasilan sentetik veri ureteci.
//
// Tum veri tohumlu bir LCG ile uretilir: ayni tohum ayni baytlari verir, gercek
// kisi ya da ozel veri YOKTUR. Her veri seti, metniyle birlikte veriden
// HESAPLANMIS soru/cevap ciftlerini de tasir; sorularin beklenen cevabi elle
// yazilmaz.
//
// Bu dosya `examples/shared/` altinda durur: cargo yalnizca `examples/`
// kokundeki .rs dosyalarini ornek olarak derler, alt dizinleri degil.

use std::fmt::Write as _;

/// Kucuk, deterministik LCG (Numerical Recipes sabitleri).
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    pub fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
    pub fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[self.below(items.len() as u32) as usize]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Json,
    Jsonl,
    Csv,
    Logfmt,
    MdTable,
    Xml,
    Sql,
    Ini,
    Toml,
    Yaml,
    Prose,
    Code,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Json => "json",
            Kind::Jsonl => "jsonl",
            Kind::Csv => "csv",
            Kind::Logfmt => "logfmt",
            Kind::MdTable => "md-table",
            Kind::Xml => "xml",
            Kind::Sql => "sql",
            Kind::Ini => "ini",
            Kind::Toml => "toml",
            Kind::Yaml => "yaml",
            Kind::Prose => "prose",
            Kind::Code => "code",
        }
    }
    /// ingest katmanindan gecen (kanonik JSON'a normallesen) turler.
    #[allow(dead_code)]
    pub fn structural(self) -> bool {
        matches!(self, Kind::Jsonl | Kind::Csv | Kind::Logfmt | Kind::MdTable)
    }
    #[allow(dead_code)]
    pub fn plain(self) -> bool {
        matches!(
            self,
            Kind::Xml | Kind::Sql | Kind::Ini | Kind::Toml | Kind::Yaml
        )
    }
}

/// Sayiyi kararli bicimde yazar: tam sayiysa ".0" yok, degilse 2 hane.
fn num(v: f64) -> String {
    if (v - v.round()).abs() < f64::EPSILON {
        format!("{}", v.round() as i64)
    } else {
        format!("{:.2}", v)
    }
}

#[allow(dead_code)] // bench_public sorulari okumaz, bench_dump okur.
pub struct Question {
    /// lookup | count | max | sum
    pub kind: &'static str,
    pub text: String,
    pub expected: String,
}

#[allow(dead_code)] // alanlarin kullanimi ornege gore degisir.
pub struct Dataset {
    pub name: &'static str,
    pub kind: Kind,
    pub text: String,
    /// Kontrol setlerinde (duz yazi/kod) bos.
    pub questions: Vec<Question>,
}

fn q(kind: &'static str, text: impl Into<String>, expected: impl Into<String>) -> Question {
    Question {
        kind,
        text: text.into(),
        expected: expected.into(),
    }
}

fn json_array() -> Dataset {
    let mut rng = Lcg::new(42);
    let statuses = ["active", "trial", "paused"];
    let mut rows: Vec<(u32, &str, f64)> = Vec::with_capacity(200);
    let mut text_rows = Vec::with_capacity(200);
    for i in 0..200 {
        let status = rng.pick(&statuses);
        let amount = (rng.below(900) + 10) as f64 + 0.5;
        rows.push((i, status, amount));
        text_rows.push(format!(
            r#"{{"id":{i},"name":"item-{i:03}","status":"{status}","amount":{amount:.2},"created_at":"2024-01-{:02}T10:00:00Z"}}"#,
            rng.below(28) + 1
        ));
    }
    let max_amount = rows.iter().map(|r| r.2).fold(f64::MIN, f64::max);
    let sum_amount: f64 = rows.iter().map(|r| r.2).sum();
    let q0_status = rows[0].1;
    Dataset {
        name: "JSON records",
        kind: Kind::Json,
        text: format!("[{}]", text_rows.join(",")),
        questions: vec![
            q("count", "How many records are in the JSON array?", "200"),
            q(
                "lookup",
                "What is the status of the record with id 0?",
                q0_status,
            ),
            q("max", "What is the largest amount value?", num(max_amount)),
            q(
                "sum",
                "What is the sum of all amount values?",
                num(sum_amount),
            ),
        ],
    }
}

fn jsonl() -> Dataset {
    let mut rng = Lcg::new(7);
    let levels = ["info", "info", "info", "warn", "error"];
    let services = ["api", "worker", "gateway"];
    let statuses = ["200", "200", "200", "404", "500"];
    let mut rows: Vec<(&str, &str, &str)> = Vec::with_capacity(500);
    let mut lines = Vec::with_capacity(500);
    for i in 0..500 {
        let level = rng.pick(&levels);
        let service = rng.pick(&services);
        let status = rng.pick(&statuses);
        rows.push((level, service, status));
        lines.push(format!(
            r#"{{"ts":"2024-01-01T10:{:02}:{:02}Z","level":"{level}","service":"{service}","status":{status},"path":"/v1/items/{i}"}}"#,
            i % 60,
            rng.below(60)
        ));
    }
    let errors = rows.iter().filter(|r| r.0 == "error").count();
    let status_of_10 = rows[10].2;
    Dataset {
        name: "JSONL access log",
        kind: Kind::Jsonl,
        text: lines.join("\n"),
        questions: vec![
            q("count", "How many log lines are there?", "500"),
            q(
                "count",
                "How many lines have level \"error\"?",
                errors.to_string(),
            ),
            q(
                "lookup",
                "What is the status value on the line with path /v1/items/10?",
                status_of_10,
            ),
        ],
    }
}

fn csv() -> Dataset {
    let mut rng = Lcg::new(99);
    let statuses = ["shipped", "pending", "cancelled", "pending"];
    let mut rows: Vec<(&str, u32)> = Vec::with_capacity(300);
    let mut s = String::from("id,customer,status,total,created_at\n");
    for i in 0..300u32 {
        let status = rng.pick(&statuses);
        let total = rng.below(500) + 10;
        rows.push((status, total));
        let _ = writeln!(
            s,
            "{i},customer-{i:03},{status},{total}.90,2024-02-{:02}",
            rng.below(28) + 1
        );
    }
    let sum_id: u32 = (0..300).sum();
    let first_status = rows[0].0;
    Dataset {
        name: "CSV orders",
        kind: Kind::Csv,
        text: s,
        questions: vec![
            q("count", "How many order rows are there?", "300"),
            q(
                "lookup",
                "What is the status of the order with id 0?",
                first_status,
            ),
            q(
                "sum",
                "What is the sum of all id values?",
                sum_id.to_string(),
            ),
        ],
    }
}

fn logfmt() -> Dataset {
    let mut rng = Lcg::new(1234);
    let levels = ["info", "info", "warn", "error"];
    let services = ["api", "worker", "gateway"];
    let methods = ["GET", "POST", "GET"];
    let statuses = ["200", "200", "404", "500"];
    let mut rows: Vec<(&str, &str)> = Vec::with_capacity(300);
    let mut lines = Vec::with_capacity(300);
    for i in 0..300 {
        let level = rng.pick(&levels);
        let service = rng.pick(&services);
        let method = rng.pick(&methods);
        let status = rng.pick(&statuses);
        rows.push((level, status));
        lines.push(format!(
            "ts=2024-01-01T10:00:{:02}Z level={level} service={service} method={method} path=\"/v1/items/{i}\" status={status}",
            i % 60
        ));
    }
    let errors = rows.iter().filter(|r| r.0 == "error").count();
    let status_of_5 = rows[5].1;
    Dataset {
        name: "logfmt lines",
        kind: Kind::Logfmt,
        text: lines.join("\n"),
        questions: vec![
            q("count", "How many logfmt lines are there?", "300"),
            q(
                "count",
                "How many lines have level=error?",
                errors.to_string(),
            ),
            q(
                "lookup",
                "What is the status on the line with path /v1/items/5?",
                status_of_5,
            ),
        ],
    }
}

fn md_table() -> Dataset {
    let mut rng = Lcg::new(555);
    let mut populations: Vec<u32> = Vec::with_capacity(100);
    let mut s = String::from("| id | city | region | population |\n|---|---|---|---|\n");
    for i in 0..100u32 {
        let population = 100_000 + i * 137;
        populations.push(population);
        let _ = writeln!(
            s,
            "| {i} | city-{i:03} | region-{} | {population} |",
            rng.below(8)
        );
    }
    let sum: u32 = populations.iter().sum();
    let max = populations.iter().copied().max().unwrap_or(0);
    Dataset {
        name: "Markdown table",
        kind: Kind::MdTable,
        text: s,
        questions: vec![
            q("count", "How many table rows are there?", "100"),
            q(
                "sum",
                "What is the sum of the population column?",
                sum.to_string(),
            ),
            q(
                "max",
                "What is the largest population value?",
                max.to_string(),
            ),
        ],
    }
}

fn xml() -> Dataset {
    let mut rng = Lcg::new(2024);
    let mut rows: Vec<(u32, u32)> = Vec::with_capacity(150); // (price, category)
    let mut s = String::from("<catalog>\n");
    for i in 0..150u32 {
        let price = rng.below(90) + 10;
        let category = rng.below(6);
        rows.push((price, category));
        let _ = write!(
            s,
            "  <item id=\"{i}\" available=\"true\">\n    <title>Product {i:03}</title>\n    <price>{price}.99</price>\n    <category>cat-{category}</category>\n  </item>\n"
        );
    }
    s.push_str("</catalog>\n");
    let sum_id: u32 = (0..150).sum();
    let max_price = rows.iter().map(|r| r.0).max().unwrap_or(0);
    Dataset {
        name: "XML catalog",
        kind: Kind::Xml,
        text: s,
        questions: vec![
            q("count", "How many item elements are there?", "150"),
            q(
                "lookup",
                "What is the title of the item with id 7?",
                "Product 007",
            ),
            q(
                "max",
                "What is the largest price value (the number before .99)?",
                max_price.to_string(),
            ),
            q(
                "sum",
                "What is the sum of all id values?",
                sum_id.to_string(),
            ),
        ],
    }
}

fn sql() -> Dataset {
    let mut rng = Lcg::new(31337);
    let statuses = ["shipped", "pending", "cancelled"];
    let mut rows: Vec<(&str, u32)> = Vec::with_capacity(200);
    let mut s = String::from("INSERT INTO orders (id, customer, status, total) VALUES\n");
    for i in 0..200u32 {
        let status = rng.pick(&statuses);
        let total = rng.below(500) + 10;
        rows.push((status, total));
        let sep = if i + 1 == 200 { ";" } else { "," };
        let _ = writeln!(s, "({i}, 'customer-{i:03}', '{status}', {total}.90){sep}");
    }
    let sum_id: u32 = (0..200).sum();
    let status_of_5 = rows[5].0;
    Dataset {
        name: "SQL inserts",
        kind: Kind::Sql,
        text: s,
        questions: vec![
            q(
                "count",
                "How many rows does the INSERT statement have?",
                "200",
            ),
            q(
                "lookup",
                "What is the status of the order with id 5?",
                status_of_5,
            ),
            q(
                "sum",
                "What is the sum of all id values?",
                sum_id.to_string(),
            ),
        ],
    }
}

fn ini() -> Dataset {
    let text: String = (0..16)
        .map(|i| {
            format!(
                "[profile_{i:02}]\nhost = db-{i:02}.internal\nport = 5432\nsslmode = require\n\n"
            )
        })
        .collect();
    Dataset {
        name: "INI profiles",
        kind: Kind::Ini,
        text,
        questions: vec![
            q("count", "How many profile sections are there?", "16"),
            q(
                "lookup",
                "What is the host of section profile_05?",
                "db-05.internal",
            ),
        ],
    }
}

fn toml() -> Dataset {
    let text: String = (0..16)
        .map(|i| {
            format!(
                "[[dependency.{i}]]\nname = \"crate-{i:02}\"\nversion = \"1.4\"\noptional = false\n\n"
            )
        })
        .collect();
    Dataset {
        name: "TOML deps",
        kind: Kind::Toml,
        text,
        questions: vec![
            q("count", "How many dependency entries are there?", "16"),
            q("lookup", "What is the name of dependency 3?", "crate-03"),
        ],
    }
}

fn yaml() -> Dataset {
    let mut rng = Lcg::new(8080);
    let mut replicas: Vec<u32> = Vec::with_capacity(12);
    let mut s = String::from("workers:\n");
    for i in 0..12u32 {
        let r = rng.below(4) + 1;
        replicas.push(r);
        let _ = write!(
            s,
            "  - id: {i}\n    name: worker-{i:03}\n    replicas: {r}\n    active: {}\n",
            if i % 2 == 0 { "true" } else { "false" }
        );
    }
    let sum: u32 = replicas.iter().sum();
    let max = replicas.iter().copied().max().unwrap_or(0);
    Dataset {
        name: "YAML workers",
        kind: Kind::Yaml,
        text: s,
        questions: vec![
            q("count", "How many workers are listed?", "12"),
            q(
                "sum",
                "What is the sum of the replicas values?",
                sum.to_string(),
            ),
            q(
                "max",
                "What is the largest replicas value?",
                max.to_string(),
            ),
        ],
    }
}

/// KONTROL: ~2000 karakter duz yazi. Beklenen tasarruf ≈ 0.
fn prose() -> Dataset {
    let sentence = "Thalamus runs locally and rewrites only structure, never prose. \
                    Each candidate is decoded again and compared before it is used. ";
    Dataset {
        name: "CONTROL prose",
        kind: Kind::Prose,
        text: sentence.repeat(20),
        questions: vec![],
    }
}

/// KONTROL: fenced kod blogu. Beklenen: dokunulmaz.
fn code() -> Dataset {
    Dataset {
        name: "CONTROL code",
        kind: Kind::Code,
        text: "```python\ndef total(rows):\n    return sum(r['amount'] for r in rows)\n\nprint(total([{'amount': 3}, {'amount': 4}]))\n```".to_string(),
        questions: vec![],
    }
}

pub fn datasets() -> Vec<Dataset> {
    vec![
        json_array(),
        jsonl(),
        csv(),
        logfmt(),
        md_table(),
        xml(),
        sql(),
        ini(),
        toml(),
        yaml(),
        prose(),
        code(),
    ]
}

/// `package.json` iceren ust dizini (repo koku) bulur; bulunamazsa cwd.
pub fn repo_root() -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    for dir in cwd.ancestors() {
        if dir.join("package.json").is_file() {
            return dir.to_path_buf();
        }
    }
    cwd
}

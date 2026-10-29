// "Context window'u ortadan kaldırma" iddiasının kanıt deneyi.
//
//   cargo run --example context_soak --release
//
// Soru: 200 turluk bir oturumda, bağlama yalnız HARİTA + son tur giderse,
// eski turlardaki bilgiye hâlâ ulaşılabiliyor mu ve maliyet ne oluyor?
//
// Üç koşul karşılaştırılır (hepsi aynı veri üzerinde):
//
//   BUGUN    : eski turlar silinir (sliding window: son 24 mesaj tutulur)
//   PENCERE  : tüm geçmiş bağlama doldurulur (büyük pencere varsayımı)
//   HARITA   : ContextStore + map + recall (önerilen)
//
// Metrik: (a) eski bilgiye erişim (0/1), (b) bağlama giden bayt,
//         (c) deponun kapladığı bayt, (d) round-trip doğrulaması.

use app_lib::engine::context_store::{ContextStore, Kind};
use serde_json::{json, Value};

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
}

/// Turda saklanan "gizli bilgi": her turda bir kod üretilir, sonra sorulur.
struct TurnData {
    secret_code: String,
    tool_payload: Value,
    /// Aynı dosya her 7 turda tekrar okunur (dedup fırsatı).
    file_key: String,
}

fn make_turn(rng: &mut Lcg, t: usize) -> TurnData {
    let secret_code = format!("CODE-{:04}-{}", t, 1000 + rng.below(9000));
    let rows: Vec<Value> = (0..30)
        .map(|r| {
            let n = t * 100 + r;
            let severity = ["ok", "warn", "error"][n % 3];
            json!({
                "id": n,
                "file": format!("src/m{:02}/h.rs", n % 7),
                "line": 100 + r * 5,
                "severity": severity,
                "elapsed_ms": 5 + (n % 80),
            })
        })
        .collect();
    TurnData {
        secret_code,
        tool_payload: Value::Array(rows),
        file_key: format!("file:{}", t % 7),
    }
}

fn main() {
    let turns = 200usize;
    let mut rng = Lcg::new(77);
    let data: Vec<TurnData> = (0..turns).map(|t| make_turn(&mut rng, t)).collect();

    // ── Önerilen: her turu depoya yaz ─────────────────────────────────────
    let mut store = ContextStore::new();
    let mut secret_ids: Vec<u32> = Vec::new();
    let mut all_bare_bytes = 0usize;
    for (t, d) in data.iter().enumerate() {
        // gizli bilgi kullanıcı mesajında
        let user = json!(format!("Tur {t}: kod {}", d.secret_code));
        secret_ids.push(store.push(t as u32, Kind::User, "user", &user, None, None));
        // ağır araç yükü
        all_bare_bytes += serde_json::to_string(&d.tool_payload).unwrap().len();
        store.push(t as u32, Kind::Tool, "tool_result", &d.tool_payload, None, None);
        // aynı dosya tekrar tekrar
        let file_body = json!({"path": format!("src/m{}/h.rs", t % 7), "body": "x".repeat(2000)});
        store.push(t as u32, Kind::File, "read_file", &file_body, Some(d.file_key.clone()), None);
    }
    let stats = store.stats();

    // ── Erişim testi: rastgele 40 eski turun gizli kodunu geri çağır ──────
    let mut rng2 = Lcg::new(11);
    let probes: Vec<usize> = (0..40).map(|_| rng2.below(turns as u32) as usize).collect();
    let mut recall_ok = 0usize;
    for &t in &probes {
        if let Some(v) = store.recall(secret_ids[t]) {
            let text = v.as_str().unwrap_or("");
            if text.contains(&data[t].secret_code) {
                recall_ok += 1;
            }
        }
    }

    // ── Bugünkü davranış: son 24 mesaj tutulur ────────────────────────────
    // Mesaj sayısı = tur başına 3 (user + tool + file)
    const KEEP: usize = 24;
    let total_msgs = turns * 3;
    let kept_from = total_msgs.saturating_sub(KEEP);
    let mut sliding_ok = 0usize;
    for &t in &probes {
        // Bu turun mesaj indeksleri: 3t, 3t+1, 3t+2
        if 3 * t >= kept_from {
            sliding_ok += 1;
        }
    }

    // ── Maliyet: bağlama giden bayt ───────────────────────────────────────
    // BUGUN: yalnız son 24 mesaj
    let mut sliding_bytes = 0usize;
    for t in (kept_from / 3)..turns {
        let d = &data[t];
        sliding_bytes += serde_json::to_string(&json!({"role":"user","content":format!("Tur {t}: kod {}", d.secret_code)})).unwrap().len();
        sliding_bytes += serde_json::to_string(&d.tool_payload).unwrap().len();
        sliding_bytes += 2 * 2000;
    }
    // PENCERE: tüm geçmiş
    let mut window_bytes = 0usize;
    for (t, d) in data.iter().enumerate() {
        window_bytes += serde_json::to_string(&json!({"role":"user","content":format!("Tur {t}: kod {}", d.secret_code)})).unwrap().len();
        window_bytes += serde_json::to_string(&d.tool_payload).unwrap().len();
        window_bytes += 2 * 2000;
    }
    // HARITA: son tur (tam) + harita
    let map_text = store.map(None, 900);
    let last_turn_bytes = serde_json::to_string(&data[turns - 1].tool_payload).unwrap().len();
    let map_total = map_text.len() + last_turn_bytes;

    println!("=== {turns} turluk oturum · 40 rastgele eski tur sorgusu ===\n");
    println!("{:14} {:>14} {:>16} {:>12}", "koşul", "eski bilgi", "bağlama giden", "doğrulama");
    println!("{}", "-".repeat(62));
    println!(
        "{:14} {:>9}/40 ({:>3.0}%) {:>16} {:>12}",
        "BUGUN", sliding_ok, 100.0 * sliding_ok as f64 / 40.0, sliding_bytes, "—"
    );
    println!(
        "{:14} {:>9}/40 ({:>3.0}%) {:>16} {:>12}",
        "PENCERE", 40, 100.0, window_bytes, "—"
    );
    println!(
        "{:14} {:>9}/40 ({:>3.0}%) {:>16} {:>12}",
        "HARITA", recall_ok, 100.0 * recall_ok as f64 / 40.0, map_total,
        if recall_ok == 40 { "kayıpsız" } else { "KAYIP VAR" }
    );

    println!("\n=== Depo istatistikleri ===");
    println!("  harita satırı        : {}", stats.items);
    println!("  saklanan artefakt    : {} (dedup sonrası)", stats.artifacts);
    println!("  ham bayt             : {}", stats.raw_bytes);
    println!("  depoda kaplanan      : {}", stats.stored_bytes);
    println!("  sıkıştırma tasarrufu : %{:.1}", stats.savings_pct());
    println!("  dedup tasarrufu      : {} bayt", stats.dedup_saved_bytes);
    println!("  doğrulanamayan       : {}", stats.unverified);

    println!("\n=== Bağlama giden bayt (HARITA) ===");
    println!("  harita metni (~{} token): {} bayt", map_text.len() / 4, map_text.len());
    println!("  son tur (tam)        : {} bayt", last_turn_bytes);
    println!("  toplam               : {} bayt", map_total);
    println!(
        "  PENCERE'ye göre      : %{:.1} küçük",
        100.0 * (window_bytes as f64 - map_total as f64) / window_bytes as f64
    );
    println!(
        "  ham veriye göre      : %{:.1} küçük",
        100.0 * (all_bare_bytes as f64 - map_total as f64) / all_bare_bytes as f64
    );

    println!("\n=== Harita örneği (ilk 12 satır) ===");
    for line in map_text.lines().take(12) {
        println!("{}", line);
    }
}

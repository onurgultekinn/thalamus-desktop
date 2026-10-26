// Yöntem sertifikasyonu — "anlama geçtiyse entegre et" kuralının kodu.
//
// Bir temsil üretime ancak üç eşik birlikte sağlandığında girer:
//   1) TASARRUF   : ölçülen token kazancı >= MIN_SAVINGS_PCT
//   2) ANLAMA     : eşleştirilmiş probda delta >= -COMPREHENSION_TOLERANCE_POINTS
//   3) ÖRNEKLEM   : en az MIN_PAIRED_QUESTIONS eşleştirilmiş soru
//
// Bu sabitler yazarın ayrı tuttuğu ölçüm harness'ı tarafından ölçüm
// sonuçlarıyla karşılaştırılır. Harness ve korpuslar bu depoda yayınlanmaz;
// buradaki `evidence` alanları (ör. TRIALS-019) o iç ölçüm günlüğüne atıftır.
// "Sertifikalı" etiketi elle yazılmış bir iddia değil, eşik kuralına bağlıdır.
use crate::engine::plain_table::PlainKind;

pub const MIN_SAVINGS_PCT: f64 = 25.0;
pub const COMPREHENSION_TOLERANCE_POINTS: f64 = 2.0;
pub const MIN_PAIRED_QUESTIONS: usize = 40;

#[derive(Debug, Clone, Copy)]
pub struct Certification {
    pub method: &'static str,
    pub min_savings_pct: f64,
    pub comprehension_delta: f64,
    pub paired_questions: usize,
    pub evidence: &'static str,
}

/// XML/SQL/INI/TOML/YAML düz tablosu — TRIALS-019: %57 toplam tasarruf,
/// 53 eşleştirilmiş soruda 0,0 delta (19 vaka, 0 kayıpsız hata).
pub const PLAIN_TABLE: Certification = Certification {
    method: "plain_table",
    min_savings_pct: MIN_SAVINGS_PCT,
    comprehension_delta: 0.0,
    paired_questions: 53,
    evidence: "TRIALS-019 / D-032",
};

impl Certification {
    /// Anlama eşiğini geçmiş mi? (delta toleransın altına düşmemiş)
    pub fn comprehension_ok(&self) -> bool {
        self.comprehension_delta >= -COMPREHENSION_TOLERANCE_POINTS
            && self.paired_questions >= MIN_PAIRED_QUESTIONS
    }

    /// Runtime kapısı: bu aday, ölçülen tasarruf oranıyla kabul edilir mi?
    pub fn savings_ok(&self, savings_pct: f64) -> bool {
        savings_pct >= self.min_savings_pct
    }
}

/// `plain_table` belirli bir tür/tasarruf için üretime uygun mu?
pub fn plain_table_ok(_kind: PlainKind, savings_pct: f64) -> bool {
    PLAIN_TABLE.comprehension_ok() && PLAIN_TABLE.savings_ok(savings_pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_table_is_certified() {
        assert!(PLAIN_TABLE.comprehension_ok());
        assert!(plain_table_ok(PlainKind::Xml, 60.0));
        assert!(plain_table_ok(PlainKind::Sql, 30.0));
    }

    #[test]
    fn thin_margin_is_rejected_at_runtime() {
        // %25 eşiğinin altındaki kazanç üretime girmez (sınırDA değil).
        assert!(!plain_table_ok(PlainKind::Xml, 24.9));
        assert!(plain_table_ok(PlainKind::Xml, 25.0));
    }
}

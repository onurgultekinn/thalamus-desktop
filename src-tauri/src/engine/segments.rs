// Katmanlı prompt segmentasyonu — kesinden belirsize doğru:
//
//   Katman 1 — markdown fenced bloklar (```lang ... ```): en kesin sinyal.
//       İçerik kelimesi kelimesine korunur; yalnızca dili `json` olan
//       blokların içeriği JSON adayı olarak işaretlenir.
//   Katman 2 — inline kod aralıkları (`...`, aynı satır): içerik korunur.
//   Katman 3 — kalan metinde dengeli-parantez JSON taraması (JsonExtractor).
//   Katman 4 — karar verilemeyen her şey: Text (kelimesi kelimesine taşınır).
//
// Segment sırası girdi sırasını birebir korur; hiçbir kayıplı işlem yoktur.
// "Kodu yazı gibi yazan" kullanıcı için güvenli davranış: sınıflandırılamayan
// her şey metindir ve dokunulmaz.

use crate::engine::plain_table::{self, PlainKind};
use crate::engine::sanitize_json_string;
use serde_json::Value;

#[derive(Debug, PartialEq, Clone)]
pub enum Segment<'a> {
    /// Fenced/inline kod — kelimesi kelimesine taşınır, sıkıştırılmaz.
    Verbatim(&'a str),
    /// Geçerli JSON adayı — sıkıştırma kararı karar motorunda verilir.
    Json(&'a str),
    /// Yapısal metin bloğu (JSONL/CSV/logfmt/md-tablo): `raw` orijinal satırlar,
    /// `json` ayrıştırılmış Value'nun kanonik serileştirmesi — sıkıştırma ve
    /// kayıpsızlık doğrulaması bu JSON üzerinden yürür, reddedilirse `raw` kalır.
    Data { raw: &'a str, json: String },
    /// Kayıpsız düz-tablo adayı (XML/SQL). `compressed` üretimde önceden
    /// üretilmiş ve doğrulanmıştır; karar motoru yalnız kabul/ret verir.
    Structured {
        raw: &'a str,
        compressed: String,
        kind: PlainKind,
    },
    /// Düz metin (talimat/prose) — asla dönüştürülmez, kelimesi kelimesine taşınır.
    Text(&'a str),
}

pub struct PromptSegmenter;

impl PromptSegmenter {
    pub fn segment(input: &str) -> Vec<Segment<'_>> {
        // 1) Önce "kesin" bölgeleri topla (fence'ler).
        let protected = Self::collect_fences(input);

        // 2) Korunan bölgeler arasında kalan boşluklarda inline span + JSON tara.
        let mut out: Vec<Segment<'_>> = Vec::new();
        let mut cursor = 0usize;
        for p in &protected {
            if p.start > cursor {
                Self::scan_gap(input, cursor, p.start, &mut out);
            }
            out.push(match p.kind {
                ProtectedKind::Verbatim => Segment::Verbatim(&input[p.start..p.end]),
                ProtectedKind::JsonContent => Segment::Json(&input[p.start..p.end]),
            });
            cursor = p.end.max(cursor);
        }
        if cursor < input.len() {
            Self::scan_gap(input, cursor, input.len(), &mut out);
        }
        out
    }

    /// BEKÇİ (kayıpsızlık değişmezi): segmentlerin girdiyi BİREBİR ve sırayla
    /// kapladığını doğrular — boşluk ya da örtüşme varsa `false`.
    ///
    /// Neden gerekli: birleştirme aşaması segmentleri sırayla yazdığı için,
    /// kapsanmayan tek bir karakter (ör. bir satır sonu) sessizce kaybolur.
    /// Gerçek kod dosyalarında (içinde `{...}` geçen `use` satırları, boş
    /// satırlar) segmente edilemeyen bölgeler bu boşluğu üretiyordu: motor
    /// metni bozup "sıkıştırılmadı" diyebiliyordu. Bu bekçi, garanti
    /// verilemeyen durumda sıkıştırmayı tamamen iptal etmeye izin verir.
    pub fn tiles_exactly(segments: &[Segment<'_>], input: &str) -> bool {
        let base = input.as_ptr() as usize;
        let mut expect = 0usize;
        for seg in segments {
            let slice = match seg {
                Segment::Verbatim(t) | Segment::Text(t) | Segment::Json(t) => *t,
                Segment::Data { raw, .. } | Segment::Structured { raw, .. } => *raw,
            };
            if slice.is_empty() {
                continue;
            }
            let start = match (slice.as_ptr() as usize).checked_sub(base) {
                Some(v) if v <= input.len() => v,
                _ => return false, // girdinin dışında bir dilim → tiling bozuk
            };
            if start != expect {
                return false;
            }
            expect = start + slice.len();
        }
        expect == input.len()
    }

    /// Fence bölgelerini (başlangıç, bitiş, tür) toplar.
    fn collect_fences(input: &str) -> Vec<Protected> {
        let mut protected: Vec<Protected> = Vec::new();
        let mut fence_open: Option<(usize, usize, usize, bool)> = None; // (start, content_start, tick_len, is_json)

        let mut pos = 0usize;
        for line in input.split('\n') {
            let line_start = pos;
            let line_end = pos + line.len(); // '\n' hariç
            pos = line_end + 1;

            let t = line.trim_end_matches('\r').trim();
            match fence_open {
                None => {
                    let ticks = t.chars().take_while(|&c| c == '`').count();
                    if ticks >= 3 {
                        let info = t[ticks..].trim();
                        fence_open = Some((
                            line_start,
                            (line_end + 1).min(input.len()),
                            ticks,
                            info.eq_ignore_ascii_case("json"),
                        ));
                    }
                }
                Some((open_start, content_start, tick_len, is_json)) => {
                    let ticks = t.chars().take_while(|&c| c == '`').count();
                    let rest = &t[ticks.min(t.len())..];
                    if ticks >= tick_len && rest.trim().is_empty() {
                        if is_json {
                            protected.push(Protected {
                                start: open_start,
                                end: content_start,
                                kind: ProtectedKind::Verbatim,
                            });
                            if content_start < line_start {
                                protected.push(Protected {
                                    start: content_start,
                                    end: line_start,
                                    kind: ProtectedKind::JsonContent,
                                });
                            }
                            protected.push(Protected {
                                start: line_start,
                                end: (line_end + 1).min(input.len()),
                                kind: ProtectedKind::Verbatim,
                            });
                        } else {
                            protected.push(Protected {
                                start: open_start,
                                end: (line_end + 1).min(input.len()),
                                kind: ProtectedKind::Verbatim,
                            });
                        }
                        fence_open = None;
                    }
                }
            }
        }

        // Kapanmamış fence: satır sonuna kadar tamamı korunan kod.
        if let Some((open_start, _content_start, _ticks, _is_json)) = fence_open {
            protected.push(Protected {
                start: open_start,
                end: input.len(),
                kind: ProtectedKind::Verbatim,
            });
        }

        protected.sort_by_key(|p| p.start);
        protected
    }

    /// Korunan bölge dışındaki metinde: yapısal satır-run'ları (JSONL/CSV/
    /// logfmt/md-tablo), inline kod aralıkları ve JSON adaylarını ayırır.
    fn scan_gap<'a>(input: &'a str, start: usize, end: usize, out: &mut Vec<Segment<'a>>) {
        // Satır aralıkları
        let mut lines: Vec<(usize, usize)> = Vec::new();
        let mut pos = start;
        while pos < end {
            match input[pos..end].find('\n') {
                Some(off) => {
                    lines.push((pos, pos + off));
                    pos += off + 1;
                }
                None => {
                    lines.push((pos, end));
                    break;
                }
            }
        }

        // Greedy yapısal run tespiti
        let mut i = 0;
        let mut chunk_start = 0;
        // Son tüketilen bloğun bitişi: kuyruk (satır sonları) buradan başlar.
        let mut consumed_end = start;
        while i < lines.len() {
            let (s, e) = lines[i];
            if input[s..e].trim().is_empty() {
                i += 1;
                continue;
            }
            // SIRA ÖNEMLİ: düz-tablo tespiti ÖNCE. INI/TOML satırları
            // (key = value) logfmt ingest'ine de uyar; önce Data'ya düşerse
            // düz-tablo adaptörü hiç çalışmaz.
            if let Some((take, compressed, kind)) =
                Self::try_plain_block(input, &lines[i..])
            {
                Self::emit_chunk(input, lines[chunk_start].0, s, out);
                let raw_end = lines[i + take - 1].1;
                consumed_end = raw_end;
                out.push(Segment::Structured {
                    raw: &input[s..raw_end],
                    compressed,
                    kind,
                });
                i += take;
                chunk_start = i;
            } else if let Some((take, ingested)) = Self::try_structured_run(input, &lines[i..]) {
                Self::emit_chunk(input, lines[chunk_start].0, s, out);
                let raw_end = lines[i + take - 1].1;
                consumed_end = raw_end;
                out.push(Segment::Data {
                    raw: &input[s..raw_end],
                    json: ingested.value.to_string(),
                });
                i += take;
                chunk_start = i;
            } else {
                i += 1;
            }
        }
        let tail_start = if chunk_start > 0 {
            // Önceki satırın bitişi, aradaki satır sonunu da kapsar.
            lines[chunk_start - 1].1
        } else {
            start
        };
        if chunk_start < lines.len() {
            Self::emit_chunk(input, tail_start, end, out);
        } else if consumed_end < end {
            // SON BLOK SONRASI (satir sonlari): yapisal run tum satirlari
            // yuttugunda bu kuyruk segmensiz kalıyordu → tiling bozuluyor ve
            // kayipsizlik bekcisi TUM sikistirmayi iptal ediyordu.
            out.push(Segment::Text(&input[consumed_end..end]));
        }
    }

    /// Verilen satırdan başlayan art arda yapısal bloğu tespit eder.
    /// Ayrıştırma bozulana kadar büyütür; son başarılı uzunluğu döndürür.
    fn try_structured_run(
        input: &str,
        lines: &[(usize, usize)],
    ) -> Option<(usize, crate::engine::ingest::Ingested)> {
        let strs: Vec<&str> = lines
            .iter()
            .map(|(s, e)| input[*s..*e].trim_end_matches('\r'))
            .collect();
        let mut best: Option<(usize, crate::engine::ingest::Ingested)> = None;
        for take in 3..=strs.len() {
            match crate::engine::ingest::try_ingest(&strs[..take]) {
                Some(ing) => best = Some((take, ing)),
                None => break,
            }
        }
        best
    }

    /// XML belgesi veya çok satırlı INSERT bloğu: yalnız `plain_table::compress`
    /// kayıpsız bir temsil ürettiğinde kabul edilir. Aksi halde None → metin
    /// olarak kalır. Bu kontrol, yapısal satır-run'ından ÖNCE çalışır.
    fn try_plain_block(
        input: &str,
        lines: &[(usize, usize)],
    ) -> Option<(usize, String, PlainKind)> {
        let first = input[lines[0].0..lines[0].1].trim();
        let upper = first.to_ascii_uppercase();

        let take = if upper.starts_with("INSERT INTO ") && upper.contains(" VALUES") {
            let mut n = 1usize;
            let mut terminated = false;
            while n < lines.len() {
                n += 1;
                if input[lines[n - 1].0..lines[n - 1].1].trim_end().ends_with(';') {
                    terminated = true;
                    break;
                }
            }
            if !terminated || n < 5 {
                return None;
            }
            n
        } else if first.starts_with("<?xml") || (first.starts_with('<') && !first.starts_with("</")) {
            // Açılış etiketini (ve varsa <?xml satırını) bul, kapanışını ara.
            let mut root_line = 0usize;
            if first.starts_with("<?xml") {
                root_line = 1;
                while root_line < lines.len()
                    && input[lines[root_line].0..lines[root_line].1].trim().is_empty()
                {
                    root_line += 1;
                }
            }
            let root = input
                .get(lines.get(root_line)?.0..lines.get(root_line)?.1)?
                .trim();
            if !root.starts_with('<') || root.starts_with("</") || root.starts_with("<?") {
                return None;
            }
            let tag: String = root[1..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ':')
                .collect();
            if tag.is_empty() {
                return None;
            }
            let close = format!("</{}>", tag);
            let mut n = root_line + 1;
            let mut found = None;
            while n < lines.len() {
                if input[lines[n].0..lines[n].1].trim() == close {
                    found = Some(n + 1);
                    break;
                }
                n += 1;
            }
            let n = found?;
            if n < 4 {
                return None;
            }
            n
        } else if (first.starts_with('[') && first.ends_with(']'))
            || (first.starts_with("[[") && first.ends_with("]]"))
        {
            // INI/TOML: bölüm başlıkları + key=value satırları.
            let mut n = 1usize;
            let mut last_good = 1usize;
            while n < lines.len() {
                let t = input[lines[n].0..lines[n].1].trim();
                if t.is_empty() {
                    n += 1;
                    continue;
                }
                let is_section = t.starts_with('[') && t.ends_with(']');
                let is_kv = t.contains('=') && !t.starts_with('[');
                if !(is_section || is_kv) {
                    break;
                }
                n += 1;
                last_good = n;
            }
            if last_good < 4 {
                return None;
            }
            last_good
        } else if first.starts_with("- ") {
            // YAML düz liste: "- key: value" + daha girintili devam satırları.
            let base_indent = {
                let raw = &input[lines[0].0..lines[0].1];
                raw.len() - raw.trim_start().len()
            };
            let mut n = 1usize;
            let mut last_good = 1usize;
            while n < lines.len() {
                let raw = &input[lines[n].0..lines[n].1];
                let t = raw.trim();
                if t.is_empty() {
                    n += 1;
                    continue;
                }
                let ind = raw.len() - raw.trim_start().len();
                if ind < base_indent {
                    break;
                }
                if !(t.starts_with("- ") || t.contains(": ")) {
                    break;
                }                n += 1;
                last_good = n;
            }
            if last_good < 4 {
                return None;
            }
            last_good
        } else {
            return None;
        };

        let span = &input[lines[0].0..lines[take - 1].1];
        let (compressed, kind) = plain_table::compress(span)?;
        Some((take, compressed, kind))
    }

    /// Yapısal run dışındaki metinde: inline kod aralıklarını ayır,
    /// kalan parçalarda JSON tara.
    fn emit_chunk<'a>(input: &'a str, start: usize, end: usize, out: &mut Vec<Segment<'a>>) {
        if start >= end {
            return;
        }
        let bytes = input.as_bytes();
        let mut chunk_start = start;
        let mut i = start;
        while i < end {
            if bytes[i] == b'`' {
                // Aynı satırda kapanış backtick'ini ara (inline span kuralı).
                let mut j = i + 1;
                while j < end && bytes[j] != b'`' && bytes[j] != b'\n' {
                    j += 1;
                }
                if j < end && bytes[j] == b'`' {
                    if i > chunk_start {
                        Self::scan_json(input, chunk_start, i, out);
                    }
                    out.push(Segment::Verbatim(&input[i..=j]));
                    chunk_start = j + 1;
                    i = j + 1;
                    continue;
                }
            }
            i += 1;
        }
        if chunk_start < end {
            Self::scan_json(input, chunk_start, end, out);
        }
    }

    /// Düz metin parçasında dengeli-parantez JSON adaylarını bulur.
    fn scan_json<'a>(input: &'a str, start: usize, end: usize, out: &mut Vec<Segment<'a>>) {
        for piece in JsonExtractor::extract(&input[start..end]) {
            match piece {
                Piece::Text(t) => out.push(Segment::Text(t)),
                Piece::Json(j) => {
                    if !j.trim().is_empty() {
                        out.push(Segment::Json(j));
                    }
                }
            }
        }
    }
}

struct Protected {
    start: usize,
    end: usize,
    kind: ProtectedKind,
}

enum ProtectedKind {
    Verbatim,
    JsonContent,
}

// ---------------------------------------------------------------------------
// JsonExtractor: düz metni metin/JSON parçalarına böler (dengeli parantez +
// parse doğrulaması). Fence/inline korunduğu için buraya yalnızca "güvenli"
// bölgeler gelir.
// ---------------------------------------------------------------------------

pub(crate) enum Piece<'a> {
    Text(&'a str),
    Json(&'a str),
}

pub(crate) struct JsonExtractor;

impl JsonExtractor {
    pub fn extract(input: &str) -> Vec<Piece<'_>> {
        let mut pieces = Vec::new();
        let mut last_idx = 0;

        let char_indices: Vec<(usize, char)> = input.char_indices().collect();
        let mut idx = 0;

        while idx < char_indices.len() {
            let (i, c) = char_indices[idx];
            if c == '[' || c == '{' {
                if let Some(match_end) = Self::find_matching_bracket(&input[i..], c) {
                    let absolute_end = i + match_end;
                    let potential_json = &input[i..=absolute_end];

                    // Yalnızca geçerli (veya temizlenebilir) JSON ise ayır.
                    let sanitized = sanitize_json_string(potential_json);
                    if serde_json::from_str::<Value>(&sanitized).is_ok() {
                        if i > last_idx {
                            pieces.push(Piece::Text(&input[last_idx..i]));
                        }
                        pieces.push(Piece::Json(potential_json));

                        let next_byte_idx = absolute_end + 1;
                        last_idx = next_byte_idx;

                        while idx < char_indices.len() && char_indices[idx].0 < next_byte_idx {
                            idx += 1;
                        }
                        continue;
                    }
                }
            }
            idx += 1;
        }

        if last_idx < input.len() {
            pieces.push(Piece::Text(&input[last_idx..]));
        }

        pieces
    }

    fn find_matching_bracket(slice: &str, open_char: char) -> Option<usize> {
        let close_char = if open_char == '[' { ']' } else { '}' };
        let mut depth = 0;
        let mut in_string = false;
        let mut escaped = false;

        for (i, c) in slice.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if c == '\\' {
                escaped = true;
                continue;
            }
            if c == '"' {
                in_string = !in_string;
                continue;
            }
            if !in_string {
                if c == open_char {
                    depth += 1;
                } else if c == close_char {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(input: &str) -> Vec<Segment<'_>> {
        PromptSegmenter::segment(input)
    }

    #[test]
    fn fenced_code_is_verbatim_even_with_json_inside() {
        let input = "önce\n```python\nx = {\"a\": 1, \"b\": 2}\n```\nsonra";
        let segs = kinds(input);
        assert!(segs.iter().all(|s| !matches!(s, Segment::Json(_))));
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Verbatim(v) if v.contains("x = {\"a\": 1, \"b\": 2}"))));
    }

    #[test]
    fn json_fence_content_is_json_candidate() {
        let input = "```json\n[{\"a\":1},{\"b\":2}]\n```";
        let segs = kinds(input);
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Json(j) if j.contains("{\"a\":1}"))));
    }

    #[test]
    fn unclosed_fence_is_verbatim_to_end() {
        let input = "a\n```\n{\n\"x\": 1\n";
        let segs = kinds(input);
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Verbatim(v) if v.contains("\"x\": 1"))));
        assert!(!segs.iter().any(|s| matches!(s, Segment::Json(_))));
    }

    #[test]
    fn inline_code_is_protected() {
        let big = format!(
            "[{}]",
            (0..40)
                .map(|i| format!(r#"{{"id":{},"t":"a"}}"#, i))
                .collect::<Vec<_>>()
                .join(",")
        );
        let input = format!("şablon: `{}`", big);
        let segs = kinds(&input);
        assert!(!segs.iter().any(|s| matches!(s, Segment::Json(_))));
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Verbatim(v) if v.contains("\"id\":39"))));
    }

    #[test]
    fn json_between_text_is_detected_in_order() {
        let input = "selam {\"a\":1,\"b\":2} hoşça kal";
        let segs = kinds(input);
        assert_eq!(segs.len(), 3);
        assert!(matches!(segs[0], Segment::Text(t) if t.contains("selam")));
        assert!(matches!(segs[1], Segment::Json(_)));
        assert!(matches!(segs[2], Segment::Text(t) if t.contains("hoşça kal")));
    }

}

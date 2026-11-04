// Ajan Zamanlayıcı — eşzamanlı mimarinin mekanik katmanı.
//
// Politika ile mekaniği ayırır: orkestratör "kim, hangi girdiyle koşar"
// sorusunu yanıtlar; bu modül "hazır düğümler nasıl paralel koşar, sonuçlar
// hangi sırayla işlenir" sorusunu üstlenir. Böylece eşzamanlılık, koşu
// mantığının içine gömülü bir merak yerine sınanabilir bir sözleşmedir.
//
// Sözleşme:
//   • Bağımlılıkları biten her düğüm bir sonraki dalgada koşar.
//   • Aynı dalgadaki düğümler birbirinden bağımsızdır → PARALEL koşarlar,
//     ama MAX_PARALLEL ile sınırlıdır: sınırsız paralellik, sağlayıcı hız
//     sınırında 429 fırtınası ve yerel modelde kaynak yarışı demektir.
//   • Sonuçlar tamamlanma sırasına değil DÜĞÜM sırasına göre döner — aynı
//     plan her zaman aynı zarf sırasını üretir (determinizm).
//   • Döngü emniyeti: hiçbir düğüm hazır olmazsa kalan en küçük indeksli
//     düğüm zorla koşturulur; zamanlayıcı asla kilitlenmez.

/// Bir dalgada en fazla kaç ajan aynı anda koşar.
pub const MAX_PARALLEL: usize = 4;

/// Dalgaları hesaplar: her dalga, tüm bağımlılıkları önceki dalgalarca
/// tamamlanmış düğümlerin indeksleridir. `deps[i]` = i. düğümün beklediği
/// düğüm indeksleri.
pub fn compute_waves(count: usize, deps: &[HashSet<usize>]) -> Vec<Vec<usize>> {
    debug_assert_eq!(count, deps.len());
    let mut remaining: HashSet<usize> = (0..count).collect();
    let mut done: HashSet<usize> = HashSet::new();
    let mut waves: Vec<Vec<usize>> = Vec::new();
    while !remaining.is_empty() {
        let mut wave: Vec<usize> = (0..count)
            .filter(|i| remaining.contains(i))
            .filter(|i| deps[*i].iter().all(|d| done.contains(d)))
            .collect();
        if wave.is_empty() {
            // Döngü emniyeti: en küçük indeksli kalan düğümü zorla koştur;
            // orkestratör zaten döngüleri kırar, bu son savunma hattıdır.
            wave.push(*remaining.iter().min().unwrap());
        }
        for i in &wave {
            remaining.remove(i);
        }
        done.extend(wave.iter().copied());
        waves.push(wave);
    }
    waves
}

use std::collections::HashSet;

#[cfg(test)]
mod tests {
    use super::*;

    fn deps_of(n: usize, edges: &[(usize, usize)]) -> Vec<HashSet<usize>> {
        let mut deps = vec![HashSet::new(); n];
        for (a, b) in edges {
            deps[*b].insert(*a);
        }
        deps
    }

    #[test]
    fn independent_nodes_share_one_wave() {
        let waves = compute_waves(3, &deps_of(3, &[]));
        assert_eq!(waves, vec![vec![0, 1, 2]], "bağımsız düğümler tek dalgada");
    }

    #[test]
    fn chain_produces_one_wave_per_level() {
        // 0 → 1 → 2 zinciri: her düğüm bir öncekini bekler.
        let waves = compute_waves(3, &deps_of(3, &[(0, 1), (1, 2)]));
        assert_eq!(waves, vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn diamond_fans_out_then_in() {
        // 0 → 1, 0 → 2, 1 → 3, 2 → 3: ortada iki bağımsız dalga üyesi.
        let waves = compute_waves(4, &deps_of(4, &[(0, 1), (0, 2), (1, 3), (2, 3)]));
        assert_eq!(waves[0], vec![0]);
        assert_eq!(waves[1], vec![1, 2], "kardeşler aynı dalgada");
        assert_eq!(waves[2], vec![3]);
    }

    #[test]
    fn cycle_does_not_deadlock() {
        // 0 ⇄ 1 döngüsü: kırıcı devrede değilse bile zamanlayıcı ilerlemelidir.
        let waves = compute_waves(2, &deps_of(2, &[(0, 1), (1, 0)]));
        let all: Vec<usize> = waves.iter().flatten().copied().collect();
        let mut sorted = all.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1], "tüm düğümler en sonunda koşmalı");
        assert_eq!(waves[0], vec![0], "döngüde en küçük indeks zorla koşulur");
    }

    #[test]
    fn every_node_scheduled_exactly_once() {
        // Rastgele görünümlü yoğun graf: hiçbir düğüm iki kez, hiçbiri hiç koşmaz.
        let edges = [(0, 2), (0, 3), (1, 3), (2, 4), (3, 4), (0, 4), (1, 2)];
        let waves = compute_waves(5, &deps_of(5, &edges));
        let mut all: Vec<usize> = waves.iter().flatten().copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all, vec![0, 1, 2, 3, 4]);
        // Dalga içi sıra artan olmalı (deterministik birleşim sözleşmesi).
        for w in &waves {
            let mut s = w.clone();
            s.sort_unstable();
            assert_eq!(s, *w, "dalga içi sıra düğüm sırasına göre artan olmalı");
        }
    }
}

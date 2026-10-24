// Donanim profili ve motor plani.
//
// Amac: ayni binary her makinede kendi hiz planini secsin. Derleme zamani
// hedef CPU'ya bagimlilik (target-cpu=native) YOK; tum kararlar calisma
// zamaninda verilir. Zayif makinede paralellik getirisi gurultuye donusmesin
// diye tek is parcaciga inilir, guclu makinede fiziksel cekirdekler kullanilir.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Small,
    Medium,
    Large,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Small => "small",
            Tier::Medium => "medium",
            Tier::Large => "large",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HwProfile {
    pub logical_cores: usize,
    pub avx2: bool,
    pub avx512: bool,
}

impl HwProfile {
    pub fn detect() -> Self {
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        let (avx2, avx512) = (
            is_x86_feature_detected!("avx2"),
            is_x86_feature_detected!("avx512f"),
        );
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        let (avx2, avx512) = (false, false);

        Self {
            logical_cores,
            avx2,
            avx512,
        }
    }

    /// SMT varsayimi: mantiksal/2 fiziksel cekirdege yakin bir tahmindir.
    pub fn physical_cores(&self) -> usize {
        (self.logical_cores / 2).max(1)
    }

    pub fn tier(&self) -> Tier {
        if self.logical_cores <= 4 {
            Tier::Small
        } else if self.logical_cores <= 8 {
            Tier::Medium
        } else {
            Tier::Large
        }
    }

    /// Segment analizini yurutecel is parcacigi sayisi.
    /// `TLM_ENGINE_WORKERS` ile gecici olarak ezilebilir (olcum/teshis icin;
    /// yalnizca zamanlamayi etkiler, cikti aynidir).
    pub fn engine_workers(&self) -> usize {
        if let Ok(raw) = std::env::var("TLM_ENGINE_WORKERS") {
            if let Ok(n) = raw.trim().parse::<usize>() {
                if n >= 1 {
                    return n.min(64);
                }
            }
        }
        match self.tier() {
            // Zayif makinede is parcacigi acmak toplam sureyi kotulestirebilir.
            Tier::Small => 1,
            Tier::Medium => (self.logical_cores / 4).max(1),
            Tier::Large => self.physical_cores().min(16),
        }
    }

    /// Token sayimi onbellegi icin kayit sayisi (RAM baskisina gore).
    pub fn token_cache_entries(&self) -> usize {
        match self.tier() {
            Tier::Small => 2_048,
            Tier::Medium => 16_384,
            Tier::Large => 65_536,
        }
    }
}

pub fn profile() -> &'static HwProfile {
    static PROFILE: OnceLock<HwProfile> = OnceLock::new();
    PROFILE.get_or_init(HwProfile::detect)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_and_workers_are_monotonic() {
        let weak = HwProfile {
            logical_cores: 4,
            avx2: true,
            avx512: false,
        };
        let mid = HwProfile {
            logical_cores: 8,
            avx2: true,
            avx512: false,
        };
        let strong = HwProfile {
            logical_cores: 32,
            avx2: true,
            avx512: true,
        };

        assert_eq!(weak.tier(), Tier::Small);
        assert_eq!(mid.tier(), Tier::Medium);
        assert_eq!(strong.tier(), Tier::Large);

        assert_eq!(weak.engine_workers(), 1);
        assert!(mid.engine_workers() >= 1);
        assert!(strong.engine_workers() <= 16);
        assert!(weak.token_cache_entries() < strong.token_cache_entries());
    }

    #[test]
    fn detect_returns_sane_values() {
        let p = profile();
        assert!(p.logical_cores >= 1);
        assert!(p.engine_workers() >= 1);
    }
}

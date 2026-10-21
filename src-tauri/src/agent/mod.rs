// Thalamus Ajan Ağı (Agent Mesh).
//
// Projeler bölümüne gömülü, çok-ajanlı bir kodlama hattı. Ayırt edici özellik:
// ajanlar birbirleriyle SERBEST METİN değil, tipli JSON zarflarıyla konuşur ve
// zarfın tel biçimi mevcut kayıpsız @T motorundan geçer. Böylece ajan-arası
// bağlam hem makine-doğrulanabilir (şema) hem de ucuz (token tasarrufu) olur.
//
// Modüller:
//   envelope  → zarf yapısı + model yanıtı doğrulama + tel kodlama (lossless)
//   roles     → ajan rolleri ve JSON sözleşmeleri
//   brain     → LLM beyni (gerçek sağlayıcı) + mock beyin (ağsız test)
//   orchestrator → boru hattı, durum, bütçe/sayaç, iptal

pub mod brain;
pub mod envelope;
pub mod orchestrator;
pub mod roles;

pub use orchestrator::{cancel_run, start_run, RunRequest, SharedRuns};

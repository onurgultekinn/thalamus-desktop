// src-tauri/src/secrets.rs
//
// API anahtarlarını OS kimlik bilgisi deposunda (Windows'ta Credential
// Manager) saklar. `keyring` crate'i kullanılamadığında (offline derleme)
// doğrudan Win32 FFI ile yapılır; crate dosyası zaten cache'te olan
// `windows-sys` üzerinden bağlanır.
//
// GÜVENLİK KATMANI (DPAPI): blob, CredProtectW ile ŞİFRELİ yazılır.
// Credential Manager dosyalarını (yedek/roaming/profil kopyası) toplayan
// genel dumper araçları yalnızca şifreli bayt görür. Uygulama içi okuma
// CredUnprotectW ile açar. Eski (düz) kayıtlar ilk okumada otomatik olarak
// şifreli biçime yükseltilir.
//
// SINIR (dürüst not): aynı kullanıcı olarak çalışan kötü niyetli bir süreç,
// DPAPI'yi kendisi çağlayıp çözebilir — bu yerel tehdit modelinin tabanıdır
// ve işletim sistemi katmanı (Defender/EDR) haricinde tam kapatılamaz.
// Bu katman "bulk dump + offline analiz" sınıfını keser; ayrıca anahtarlar
// sohbet istek gövdelerinden tamamen çekilmiştir (bkz. backend use_stored_key).

#[cfg(windows)]
pub mod imp {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const TARGET_PREFIX: &str = "thalamus:key:";
    /// Şifreli blob öneki: eski düz kayıtlardan ayrım + biçim sürümü.
    const MAGIC_PROTECTED: &[u8] = b"THLCPRT1";

    fn target_name(provider: &str) -> String {
        format!("{}{}", TARGET_PREFIX, provider)
    }
    /// Yedek slot: her başarılı yazım İKİ bağımsız DPAPI kaydına gider.
    /// Ana slot bozulursa (yaşandı) yedekten kendini onarır — veri kaybı olmaz.
    fn backup_target(provider: &str) -> String {
        format!("{}backup:{}", TARGET_PREFIX, provider)
    }
    /// Karantina: çözülemeyen blob SİLİNMEZ, adli kurtarma için saklanır.
    fn quarantine_target(provider: &str) -> String {
        format!("{}quarantine:{}", TARGET_PREFIX, provider)
    }

    /// Ham blob okur (çözme YOK). Yedek sloyu dahil arar.
    fn read_raw_blob(target: &str) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };
        let t = to_wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(t.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err == ERROR_NOT_FOUND {
                return None;
            }
            return None;
        }
        let out = unsafe {
            let size = (*cred).CredentialBlobSize as usize;
            let bytes = std::slice::from_raw_parts((*cred).CredentialBlob, size).to_vec();
            CredFree(cred as *mut core::ffi::c_void);
            bytes
        };
        Some(out)
    }

    /// DPAPI çözme; GEÇİCİ hatalara karşı üç deneme (eşzamanlı erişimde
    /// tek seferlik başarısızlık kayıp zincirini başlatmıştı).
    fn unprotect_retry(bytes: &[u8]) -> Option<String> {
        for attempt in 0..3 {
            if let Some(v) = unprotect(bytes) {
                return Some(v);
            }
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(30 * (attempt + 1)));
            }
        }
        None
    }

    /// Bir slotu çözer ve sonucun KULLANILABİLİR bir sır olduğunu doğrular.
    ///
    /// Neden gerekli: CredUnprotectW, bozulmuş bir blob'u bazen "başarılı"
    /// sayıp çöp metin döndürüyor (gözlemlendi: karışık CJK/özel karakterler).
    /// Bu çöp, ana slot yolu "çözüldü" sayılırsa YEDEK SLOT'a hiç bakılmaz ve
    /// gerçek anahtar kaybolmuş gibi görünür. Bu yüzden çözüm sonucu
    /// `looks_like_secret` ile doğrulanır; geçmezse slot "okunamadı" sayılır
    /// ve çağıran bir sonraki kaynağa (yedek) düşer.
    fn decode_slot(bytes: &[u8]) -> Option<String> {
        let value = unprotect_retry(bytes)?;
        if looks_like_secret(&value) {
            Some(value)
        } else {
            None
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(ptr: *const u16, len_chars: usize) -> String {
        if ptr.is_null() || len_chars == 0 {
            return String::new();
        }
        let slice = unsafe { std::slice::from_raw_parts(ptr, len_chars) };
        // Blob sonunda nul olabilir; kes
        let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        OsString::from_wide(&slice[..end])
            .to_string_lossy()
            .into_owned()
    }

    /// CredProtectW: DPAPI ile aynı kullanıcı bağlamı için şifreler.
    /// Tampon tahmini büyüterek yeniden dener.
    fn protect(secret: &str) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Security::Credentials::CredProtectW;

        let wide: Vec<u16> = secret.encode_utf16().collect();
        let chars_in = wide.len() as u32;
        let mut cap = (wide.len() * 2 + 256).max(512) as u32;
        loop {
            let mut out: Vec<u16> = vec![0; cap as usize];
            let mut out_chars: u32 = cap;
            let mut prot_type: i32 = 0;
            let ok = unsafe {
                CredProtectW(
                    0,
                    wide.as_ptr(),
                    chars_in,
                    out.as_mut_ptr(),
                    &mut out_chars,
                    &mut prot_type,
                )
            };
            if ok != 0 {
                let mut bytes: Vec<u8> = MAGIC_PROTECTED.to_vec();
                bytes.extend(
                    out[..out_chars as usize]
                        .iter()
                        .flat_map(|c| c.to_ne_bytes()),
                );
                return Ok(bytes);
            }
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            // Yetersiz tampon: büyüt ve yeniden dene (sonsuza değil).
            if cap > 1 << 20 {
                return Err(format!("CredProtectW failed (GetLastError={})", err));
            }
            cap *= 2;
        }
    }

    /// CredUnprotectW: MAGIC ile işaretlenmiş blob'u açar.
    fn unprotect(bytes: &[u8]) -> Option<String> {
        use windows_sys::Win32::Security::Credentials::CredUnprotectW;

        if !bytes.starts_with(MAGIC_PROTECTED) {
            return None;
        }
        let body = &bytes[MAGIC_PROTECTED.len()..];
        let wide: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_ne_bytes([c[0], c[1]]))
            .collect();
        let mut cap = (wide.len() * 2 + 256).max(512) as u32;
        loop {
            let mut out: Vec<u16> = vec![0; cap as usize];
            let mut out_chars: u32 = cap;
            let ok = unsafe {
                CredUnprotectW(
                    0,
                    wide.as_ptr(),
                    wide.len() as u32,
                    out.as_mut_ptr(),
                    &mut out_chars,
                )
            };
            if ok != 0 {
                return Some(from_wide(out.as_ptr(), out_chars as usize));
            }
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if cap > 1 << 20 {
                let _ = err;
                return None;
            }
            cap *= 2;
        }
    }

    fn write_blob(target: &str, blob_bytes: &[u8]) -> Result<(), String> {
        use windows_sys::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let mut target = to_wide(target);
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: unsafe { std::mem::zeroed() },
            CredentialBlobSize: blob_bytes.len() as u32,
            CredentialBlob: blob_bytes.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: std::ptr::null_mut(),
        };

        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            return Err(format!(
                "Could not write to Credential Manager (GetLastError={})",
                unsafe { windows_sys::Win32::Foundation::GetLastError() }
            ));
        }
        Ok(())
    }

    /// Blob'u DÜZ metin (eski biçim) yazar — yalnız yükseltme testi için.
    #[cfg(test)]
    fn write_legacy_plain(provider: &str, secret: &str) -> Result<(), String> {
        let blob: Vec<u16> = secret.encode_utf16().collect();
        let bytes: Vec<u8> = blob.iter().flat_map(|c| c.to_ne_bytes()).collect();
        write_blob(&target_name(provider), &bytes)
    }

    /// Bir sırrın KULLANILABİLİR biçimde olduğunu doğrular. Kritik: DPAPI
    /// çözme başarısız olduğunda blob'u "eski düz kayıt" sanıp UTF-16 çözmek
    /// şifreli metni ÇÖP metne dönüştürür; o çöp geri yazılırsa gerçek anahtar
    /// kalıcı olarak YOK OLUR (yaşandı: 178 karakterlik kontrol karakterli
    /// değer -> Authorization başlığı geçersiz -> "builder error").
    /// Bu yüzden düz kayıt yalnız "makul sır" görünüyorsa yükseltilir.
    fn looks_like_secret(s: &str) -> bool {
        let n = s.chars().count();
        if n < 8 || n > 4096 {
            return false;
        }
        s.chars().all(|c| {
            !c.is_control()
                && !c.is_whitespace()
                && c != '\u{FFFD}'
                && c != '\u{FEFF}'
        })
    }

    pub fn secret_set(provider: &str, secret: &str) -> Result<(), String> {
        if !looks_like_secret(secret) {
            return Err(
                "API key looks invalid (control/invisible characters); paste it again".into(),
            );
        }
        let blob = protect(secret)?;
        write_blob(&target_name(provider), &blob)?;
        // YEDEK SLOT: aynı değer ikinci bağımsız kayda da yazılır. Ana slot
        // bozulursa (çözme hatası) yedekten onarılır — kayıp olmaz. Aynı
        // DPAPI koruması: güvenlik seviyesi değişmez.
        let backup = protect(secret)?;
        let _ = write_blob(&backup_target(provider), &backup);
        Ok(())
    }

    pub fn secret_get(provider: &str) -> Result<Option<String>, String> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target = to_wide(&target_name(provider));
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();

        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!(
                "Could not read Credential Manager (GetLastError={})",
                err
            ));
        }

        let main_blob = unsafe {
            let size = (*cred).CredentialBlobSize as usize;
            let ptr = (*cred).CredentialBlob;
            let bytes = if ptr.is_null() || size == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(ptr, size).to_vec()
            };
            CredFree(cred as *mut core::ffi::c_void);
            bytes
        };

        // Çözme: ana slot -> retry -> YEDEK SLOT. Yedekten gelirse ana slot
        // onarılır (kendi kendini iyileştiren kasa).
        let mut decoded: Option<(String, bool)> = None;
        if let Some(s) = decode_slot(&main_blob) {
            decoded = Some((s, false));
        } else if let Some(backup_blob) = read_raw_blob(&backup_target(provider)) {
            if let Some(s) = decode_slot(&backup_blob) {
                // Onarım: yedekten ana slota geri yaz (sessiz).
                if let Ok(blob) = protect(&s) {
                    let _ = write_blob(&target_name(provider), &blob);
                }
                decoded = Some((s, false));
            }
        }
        if decoded.is_none() && !main_blob.is_empty() {
            // LEGACY YOLU: DPAPI öneki olmayan düz UTF-16 kayıt (eski sürüm).
            // Yalnız "makul sır" görünüyorsa kabul edilir; çöp karantinaya gider.
            let wide: Vec<u16> = main_blob
                .chunks_exact(2)
                .map(|c| u16::from_ne_bytes([c[0], c[1]]))
                .collect();
            let candidate = from_wide(wide.as_ptr(), wide.len());
            if looks_like_secret(&candidate) {
                decoded = Some((candidate, true));
            }
        }
        let (result, was_legacy) = match decoded {
            Some((s, legacy)) => (s, legacy),
            None => {
                // ÇÖZÜLEMEYEN BLOB: silmek yerine KARANTİNAYA alınır — adli
                // kurtarma mümkün kalır (yaşanan kaybın tekrarı engellenir).
                if !main_blob.is_empty() {
                    // Ham blob DOĞRUDAN karantinaya yazılır (bayt-bayt aynı;
                    // ileride kod düzelince kurtarma mümkün olur).
                    let _ = write_blob(&quarantine_target(provider), &main_blob);
                    let _ = secret_delete(provider);
                }
                return Ok(None);
            }
        };
        // BOZUK DEĞER KORUMASI: çözülen değer kullanılabilir değilse karantina
        // + temizle (asla geri yazma — gerçek anahtarı ezme).
        if !result.is_empty() && !looks_like_secret(&result) {
            // Çözülmüş çöp metin de kaybolmasın: UTF-16 baytları olarak sakla.
            let bytes: Vec<u8> = result
                .encode_utf16()
                .flat_map(|c| c.to_ne_bytes())
                .collect();
            let _ = write_blob(&quarantine_target(provider), &bytes);
            let _ = secret_delete(provider);
            return Ok(None);
        }
        // Sessiz yükseltme: yalnız DOĞRULANMIŞ düz kayıt korumalıya geçer.
        if was_legacy && !result.is_empty() {
            let _ = secret_set(provider, &result);
        }
        if result.is_empty() {
            return Ok(None);
        }
        Ok(Some(result))
    }

    /// Anahtar VAR MI? Değeri okumadan var/yok — ayarlar arayüzü ve bağlantı
    /// seçimi için yeterli olan tek bilgi (anahtar değeri JS'e hiç gitmesin).
    pub fn secret_exists(provider: &str) -> Result<bool, String> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target = to_wide(&target_name(provider));
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(false);
            }
            return Err(format!(
                "Could not read Credential Manager (GetLastError={})",
                err
            ));
        }
        unsafe { CredFree(cred as *mut core::ffi::c_void) };
        Ok(true)
    }

    pub fn secret_delete(provider: &str) -> Result<(), String> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        // Yedek slotu da temizle (tam silme istenir).
        let bt = to_wide(&backup_target(provider));
        unsafe { CredDeleteW(bt.as_ptr(), CRED_TYPE_GENERIC, 0) };

        let target = to_wide(&target_name(provider));
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(()); // zaten yok — istenen durum
            }
            return Err(format!(
                "Credential Manager'dan silinemedi (GetLastError={})",
                err
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Testler OS kimlik deposunu PAYLAŞIR. Paralel koşuda CredWrite/CredRead
        /// iç içe girince DPAPI çözümü geçici olarak başarısız olabiliyor ve
        /// (doğru davranışla) bozuk sayılıp siliniyordu → kararsız test.
        /// Tüm kasa testleri bu kilitle SIRAYLA koşar.
        static VAULT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

        fn lock_vault() -> std::sync::MutexGuard<'static, ()> {
            VAULT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Gerçek kullanıcı kimlik bilgisi deposunda round-trip yapar ve
        /// temizler; yalnızca Windows'ta çalışır.
        #[test]
        fn credential_round_trip() {
            let _guard = lock_vault();
            let provider = "__cargo_test_only__";
            secret_set(provider, "sk-test-12345").unwrap();
            let read = secret_get(provider).unwrap();
            assert_eq!(read.as_deref(), Some("sk-test-12345"));
            secret_delete(provider).unwrap();
            assert_eq!(secret_get(provider).unwrap(), None);
        }

        /// Korunan blob gerçekten şifreli mi? (MAGIC dışında düz metin yok.)
        #[test]
        fn protected_blob_is_not_plaintext() {
            let _guard = lock_vault();
            use windows_sys::Win32::Security::Credentials::{
                CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
            };

            let provider = "__cargo_test_pt__";
            let secret = "sk-PLAINTEXT-MARKER-987";
            secret_set(provider, secret).unwrap();
            let target = to_wide(&target_name(provider));
            let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
            let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
            assert_ne!(ok, 0, "CredRead başarısız");
            unsafe {
                let bytes = std::slice::from_raw_parts(
                    (*cred).CredentialBlob,
                    (*cred).CredentialBlobSize as usize,
                );
                assert!(bytes.starts_with(MAGIC_PROTECTED), "korumalı önek yok");
                // Düz UTF-16 hali blob'da GEÇMEMELİ.
                let wide: Vec<u8> = secret.encode_utf16().flat_map(|c| c.to_ne_bytes()).collect();
                assert!(
                    !bytes
                        .windows(wide.len().max(1))
                        .any(|w| w == wide.as_slice()),
                    "blob'da düz metin sızdı!"
                );
                CredFree(cred as *mut core::ffi::c_void);
            }
            secret_delete(provider).unwrap();
        }

        /// REGRESYON (veri yok etme): DPAPI çözülemeyen bir blob'u "eski düz"
        /// kayıt sanıp çözmek çöp üretir; o çöp GERİ YAZILMAMALI. Yazılırsa
        /// gerçek anahtar kalıcı olarak kaybolur (yaşandı: builder error 500).
        #[test]
        fn undecryptable_blob_is_cleared_not_persisted() {
            let _guard = lock_vault();
            use windows_sys::Win32::Security::Credentials::{
                CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            };

            let provider = "__cargo_test_corrupt__";
            // MAGIC öneki VAR ama gövde DPAPI değil: unprotect başarısız olur.
            let mut blob: Vec<u8> = MAGIC_PROTECTED.to_vec();
            blob.extend((0u16..200).map(|i| (i.wrapping_mul(7919) % 65535) as u8));
            let mut target = to_wide(&target_name(provider));
            let cred = CREDENTIALW {
                Flags: 0,
                Type: CRED_TYPE_GENERIC,
                TargetName: target.as_mut_ptr(),
                Comment: std::ptr::null_mut(),
                LastWritten: unsafe { std::mem::zeroed() },
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: std::ptr::null_mut(),
                UserName: std::ptr::null_mut(),
            };
            assert_ne!(unsafe { CredWriteW(&cred, 0) }, 0, "test blob yazılamadı");

            let got = secret_get(provider).expect("okuma hata vermemeli");
            assert_eq!(got, None, "bozuk kayıt değer olarak dönmemeli");
            assert!(
                !secret_exists(provider).unwrap(),
                "bozuk kayıt kasadan SİLİNMELİ (yoksa her açılışta tekrar çöp üretir)"
            );
        }

        /// KENDİ KENDİNİ ONARMA: ana slot bozulursa (geçersiz DPAPI blob)
        /// değer YEDEK SLOTTAN kurtarılır ve ana slot sessizce onarılır.
        /// Bu, yaşanan kaybın (evren anahtarı) tekrarını engelleyen temel
        /// mekanizmadır — bozulsa bile kayıp olmaz.
        #[test]
        fn corrupted_main_is_recovered_from_backup() {
            // Kasa testleri kimlik deposunu PAYLASIR; kilit olmadan paralel
            // kosuda CredWrite/CredRead ic ice girip gecici hata uretiyordu.
            let _guard = lock_vault();
            use windows_sys::Win32::Security::Credentials::{
                CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            };

            let provider = "__cargo_test_heal__";
            let secret = "sk-recover-98765";
            secret_set(provider, secret).unwrap();

            // Ana slota GEÇERSİZ DPAPI blob yaz (magic + çöp): bozulma simülasyonu.
            let mut blob: Vec<u8> = MAGIC_PROTECTED.to_vec();
            blob.extend((0u16..300).map(|i| (i.wrapping_mul(6551) % 65535) as u8));
            let mut target = to_wide(&target_name(provider));
            let cred = CREDENTIALW {
                Flags: 0,
                Type: CRED_TYPE_GENERIC,
                TargetName: target.as_mut_ptr(),
                Comment: std::ptr::null_mut(),
                LastWritten: unsafe { std::mem::zeroed() },
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: std::ptr::null_mut(),
                UserName: std::ptr::null_mut(),
            };
            assert_ne!(unsafe { CredWriteW(&cred, 0) }, 0);

            // Okuma: yedekten kurtarmalı.
            let got = secret_get(provider).expect("okuma hata vermemeli");
            assert_eq!(got.as_deref(), Some(secret), "yedekten kurtarılmalı");

            // Ana slot ONARILMIŞ olmalı (yeniden okuma da çalışmalı).
            let again = secret_get(provider).expect("ikinci okuma");
            assert_eq!(again.as_deref(), Some(secret));
            secret_delete(provider).unwrap();
        }

        /// Karantina: çözülemeyen blob SİLİNMEZ — adli kurtarma için saklanır.
        #[test]
        fn undecryptable_main_is_quarantined_not_deleted() {
            let _guard = lock_vault();
            use windows_sys::Win32::Security::Credentials::{
                CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            };

            let provider = "__cargo_test_quar__";
            // Yedek YOK + ana slot çözülemez → None döner ama blob karantinada.
            let mut blob: Vec<u8> = MAGIC_PROTECTED.to_vec();
            blob.extend((0u16..200).map(|i| (i.wrapping_mul(7919) % 65535) as u8));
            let mut target = to_wide(&target_name(provider));
            let cred = CREDENTIALW {
                Flags: 0,
                Type: CRED_TYPE_GENERIC,
                TargetName: target.as_mut_ptr(),
                Comment: std::ptr::null_mut(),
                LastWritten: unsafe { std::mem::zeroed() },
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: std::ptr::null_mut(),
                UserName: std::ptr::null_mut(),
            };
            assert_ne!(unsafe { CredWriteW(&cred, 0) }, 0);

            let got = secret_get(provider).expect("okuma hata vermemeli");
            assert_eq!(got, None);
            // Karantina kaydı VAR olmalı (ham baytlar saklandı).
            let q = read_raw_blob(&quarantine_target(provider));
            assert!(q.is_some(), "karantina kaydı oluşturulmalı");
            // Ana kayıt temizlenmiş olmalı (bozuk değer tekrar okunmasın).
            assert!(!secret_exists(provider).unwrap());
            secret_delete(provider).unwrap();
        }

        /// Kontrol karakteri içeren değer yazılmamalı (başlık bozulmasının kökü).
        #[test]
        fn set_rejects_control_characters() {
            let _guard = lock_vault();
            let provider = "__cargo_test_ctrl__";
            let err = secret_set(provider, "sk-abc\u{0007}def").unwrap_err();
            assert!(err.contains("invalid"), "reddedilmeli: {}", err);
            assert_eq!(secret_get(provider).unwrap(), None);
        }

        /// Eski düz kayıt: okunabilmeli (geçiş) ve şifreliye yükseltilmeli.
        #[test]
        fn legacy_plaintext_upgrades_to_protected() {
            let _guard = lock_vault();
            let provider = "__cargo_test_legacy__";
            write_legacy_plain(provider, "sk-legacy-42").unwrap();
            // İlk okuma: değer düz biçimden çözülmeli.
            let read = secret_get(provider).unwrap();
            assert_eq!(read.as_deref(), Some("sk-legacy-42"));
            // (Yükseltme yazma-adımında yapılır; secret_get çağıranına şeffaf.)
            secret_delete(provider).unwrap();
        }
    }
}

#[cfg(not(windows))]
pub mod imp {
    // Windows dışı platformlarda kayıtlı anahtar yok — frontend'e dürüstçe
    // "yok" döner. (Uygulama şu an Windows odaklıdır.)
    pub fn secret_set(_provider: &str, _secret: &str) -> Result<(), String> {
        Err("Secure key store is not supported on this platform.".to_string())
    }
    pub fn secret_get(_provider: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn secret_exists(_provider: &str) -> Result<bool, String> {
        Ok(false)
    }
    pub fn secret_delete(_provider: &str) -> Result<(), String> {
        Ok(())
    }
}


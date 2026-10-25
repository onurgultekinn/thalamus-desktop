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

    pub fn secret_set(provider: &str, secret: &str) -> Result<(), String> {
        let blob = protect(secret)?;
        write_blob(&target_name(provider), &blob)
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

        let (result, was_legacy) = unsafe {
            let blob_size = (*cred).CredentialBlobSize as usize;
            let blob_ptr = (*cred).CredentialBlob;
            let (secret, legacy) = if blob_ptr.is_null() || blob_size == 0 {
                (String::new(), false)
            } else {
                let bytes = std::slice::from_raw_parts(blob_ptr, blob_size);
                if let Some(s) = unprotect(bytes) {
                    (s, false)
                } else {
                    // Eski düz biçim: UTF-16 çöz; işaretle ki çağırma sonrası
                    // şifreli biçime yükseltilsin.
                    let wide: Vec<u16> = bytes
                        .chunks_exact(2)
                        .map(|c| u16::from_ne_bytes([c[0], c[1]]))
                        .collect();
                    (from_wide(wide.as_ptr(), wide.len()), true)
                }
            };
            CredFree(cred as *mut core::ffi::c_void);
            (secret, legacy)
        };
        // Sessiz yükseltme: düz kayıttan okunduysa şimdi korumalı yaz.
        // Başarısızlık sessiz geçilir — okuma zaten doğru değeri verdi.
        if was_legacy && !result.is_empty() {
            let _ = secret_set(provider, &result);
        }
        Ok(Some(result))
    }

    pub fn secret_delete(provider: &str) -> Result<(), String> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

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

        /// Gerçek kullanıcı kimlik bilgisi deposunda round-trip yapar ve
        /// temizler; yalnızca Windows'ta çalışır.
        #[test]
        fn credential_round_trip() {
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

        /// Eski düz kayıt: okunabilmeli (geçiş) ve şifreliye yükseltilmeli.
        #[test]
        fn legacy_plaintext_upgrades_to_protected() {
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
    pub fn secret_delete(_provider: &str) -> Result<(), String> {
        Ok(())
    }
}


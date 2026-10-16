// src-tauri/src/secrets.rs
//
// API anahtarlarını OS kimlik bilgisi deposunda (Windows'ta Credential
// Manager) saklar. `keyring` crate'i kullanılamadığında (offline derleme)
// doğrudan Win32 FFI ile yapılır; crate dosyası zaten cache'te olan
// `windows-sys` üzerinden bağlanır.

#[cfg(windows)]
pub mod imp {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const TARGET_PREFIX: &str = "thalamus:key:";

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
        OsString::from_wide(&slice[..end]).to_string_lossy().into_owned()
    }

    pub fn secret_set(provider: &str, secret: &str) -> Result<(), String> {
        use windows_sys::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let mut target = to_wide(&target_name(provider));
        let blob: Vec<u16> = secret.encode_utf16().collect();
        let blob_bytes: Vec<u8> = blob.iter().flat_map(|c| c.to_ne_bytes()).collect();

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
                "Credential Manager'a yazılamadı (GetLastError={})",
                unsafe { windows_sys::Win32::Foundation::GetLastError() }
            ));
        }
        Ok(())
    }

    pub fn secret_get(provider: &str) -> Result<Option<String>, String> {
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CredReadW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target = to_wide(&target_name(provider));
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();

        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("Credential Manager okunamadı (GetLastError={})", err));
        }

        let result = unsafe {
            let blob_size = (*cred).CredentialBlobSize as usize;
            let blob_ptr = (*cred).CredentialBlob;
            let secret = if blob_ptr.is_null() || blob_size == 0 {
                String::new()
            } else {
                let bytes = std::slice::from_raw_parts(blob_ptr, blob_size);
                let wide: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_ne_bytes([c[0], c[1]]))
                    .collect();
                from_wide(wide.as_ptr(), wide.len())
            };
            CredFree(cred as *mut core::ffi::c_void);
            secret
        };
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
    }
}

#[cfg(not(windows))]
pub mod imp {
    // Windows dışı platformlarda kayıtlı anahtar yok — frontend'e dürüstçe
    // "yok" döner. (Uygulama şu an Windows odaklıdır.)
    pub fn secret_set(_provider: &str, _secret: &str) -> Result<(), String> {
        Err("Bu platformda güvenli anahtar deposu desteklenmiyor.".to_string())
    }
    pub fn secret_get(_provider: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn secret_delete(_provider: &str) -> Result<(), String> {
        Ok(())
    }
}

/**
 * API key store.
 *
 * On desktop (Tauri) keys are written to the OS credential vault —
 * Credential Manager on Windows — and are not kept as plain text in the
 * webview. In the browser dev preview there is no secure store, so it
 * falls back to localStorage (dev only).
 *
 * Migration: in Tauri, if a legacy `tlm_key_<id>` localStorage entry is
 * found, it is moved to the vault on first read and removed from
 * localStorage.
 */
import { invoke } from '@tauri-apps/api/core';
import { keyStorageKey } from './providers';

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function getStoredKey(providerId: string): Promise<string> {
  if (isTauri()) {
    try {
      const stored = await invoke<string | null>('secret_get', { provider: providerId });
      if (stored) return stored;
      const legacy = localStorage.getItem(keyStorageKey(providerId));
      if (legacy) {
        await invoke('secret_set', { provider: providerId, secret: legacy });
        localStorage.removeItem(keyStorageKey(providerId));
        return legacy;
      }
      return '';
    } catch (err) {
      console.error('Key vault read failed, falling back to localStorage:', err);
      return localStorage.getItem(keyStorageKey(providerId)) || '';
    }
  }
  return localStorage.getItem(keyStorageKey(providerId)) || '';
}

export async function setStoredKey(providerId: string, key: string): Promise<void> {
  if (isTauri()) {
    try {
      if (key) {
        await invoke('secret_set', { provider: providerId, secret: key });
      } else {
        await invoke('secret_delete', { provider: providerId });
      }
      // If it was written to the vault, don't leave a plain-text copy behind.
      localStorage.removeItem(keyStorageKey(providerId));
      return;
    } catch (err) {
      console.error('Key vault write failed, falling back to localStorage:', err);
    }
  }
  if (key) localStorage.setItem(keyStorageKey(providerId), key);
  else localStorage.removeItem(keyStorageKey(providerId));
}

export async function clearStoredKeys(providerIds: string[]): Promise<void> {
  await Promise.all(providerIds.map((id) => setStoredKey(id, '')));
}

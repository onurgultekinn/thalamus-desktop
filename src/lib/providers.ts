/**
 * Storage key helpers for provider/connection settings.
 *
 * Connections themselves (name, base URL, model list) live in
 * `lib/connections.ts` (`tlm_connections_v1`). API keys are stored in the OS
 * credential vault via the `secret_get/secret_set/secret_delete` Tauri
 * commands, keyed by the connection id; the browser dev preview falls back
 * to `tlm_key_<id>` in localStorage.
 */
export const keyStorageKey = (id: string) => `tlm_key_${id}`;
export const baseStorageKey = (id: string) => `tlm_base_${id}`;
/** Remembers the "active" connection selected in Settings. */
export const activeProviderStorageKey = 'tlm_active_provider';

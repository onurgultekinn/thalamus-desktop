/**
 * Connection-aware model registry.
 *
 * The model actually used for a request lives in `tlm_model_<connectionId>`
 * so every connection keeps its own choice. When nothing is stored we fall
 * back to the connection's own model list (fetched via the connection test)
 * — never to a global marketing name.
 */
import { getConnection, isLocalBaseUrl } from './connections';
import { isLocalProvider, localModelsFor } from './localModels';
import { API_BASE, localFetch } from '../services/ThalamusClient';

/**
 * Sağlayıcının GERÇEK model listesini sessizce çeker (toast/DOM yok).
 * Form, "Test"e basmadan listeyi doldurmak için bunu kullanır.
 */
export async function fetchModelList(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return [];
  const response = await localFetch(`${API_BASE}/api/ai/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: base, api_key: apiKey }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
  }
  return Array.isArray(data.models)
    ? data.models.filter((m: unknown): m is string => typeof m === 'string' && m.trim() !== '')
    : [];
}

export interface ModelChoice {
  /** Model id exactly as the provider's API expects it. */
  id: string;
  /** Human label; falls back to the id when omitted. */
  label?: string;
}

export const modelStorageKey = (providerId: string) => `tlm_model_${providerId}`;

/** The model a connection will be called with (stored override → discovered/list). */
export function getProviderModel(providerId: string): string {
  let stored = '';
  try {
    stored = (localStorage.getItem(modelStorageKey(providerId)) || '').trim();
  } catch { /* noop */ }
  if (stored) return stored;
  const conn = getConnection(providerId);
  if (!conn) return '';
  // Yerel bağlantıda, bilgisayarda BULUNAN ilk model sabit listeden daha
  // doğrudur (ör. Ollama'da "llama3.1" yerine gerçekten indirilmiş model).
  if (isLocalBaseUrl(conn.baseUrl)) {
    const discovered = localModelsFor(providerId, conn.baseUrl);
    if (discovered.length > 0) return discovered[0];
  }
  return conn.models?.[0] || '';
}

/** Persists the choice and lets every listener re-resolve the connection. */
export function setProviderModel(providerId: string, model: string): void {
  const value = model.trim();
  try {
    if (value) localStorage.setItem(modelStorageKey(providerId), value);
    else localStorage.removeItem(modelStorageKey(providerId));
  } catch { /* noop */ }
  try {
    window.dispatchEvent(new Event('thalamus_config_changed'));
  } catch { /* noop */ }
}

/** Picker list for a connection: current first, then discovered, then cached. */
export function modelChoices(providerId: string): { id: string; label: string }[] {
  const conn = getConnection(providerId);
  const current = getProviderModel(providerId);
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const push = (id: string, label?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label || id });
  };
  if (current) push(current, current);
  // Yerel bağlantıda önce BİLGİSAYARDA BULUNAN modeller gelir.
  if (conn && isLocalProvider(providerId)) {
    for (const id of localModelsFor(providerId, conn.baseUrl)) push(id);
  }
  for (const id of conn?.models || []) push(id);
  return out;
}

/**
 * Model `reasoning_effort` kabul ediyor mu? Bağlantı, reddeden modelleri
 * açıkça listeler (ör. EVREN/gemma-4-31b → HTTP 400); listelemeyen her model
 * parametreyi kabul eder sayılır (serbest metin kimlikler için).
 */
export function supportsReasoningEffort(providerId: string, modelId: string): boolean {
  const conn = getConnection(providerId);
  return !(conn?.reasoningOffModels || []).includes(modelId);
}

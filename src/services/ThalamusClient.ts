import { t } from '../lib/i18n';

// thalamus_desktop/src/services/ThalamusClient.ts
//
// The frontend now talks to the local HTTP backend (axum) instead of Tauri IPC
// for compression and health checks. This way the same code runs both on the
// desktop and in the browser preview (`npm run dev` + a running backend).
//
// Default address is 127.0.0.1:8277; can be changed with `VITE_BACKEND_URL`.

const API_BASE: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_BACKEND_URL?: string } }).env?.VITE_BACKEND_URL) ||
  'http://127.0.0.1:8277';

export { API_BASE };

/** fetch + timeout (manual for AbortSignal.timeout TS/WebView compatibility). */
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface CompressionMetrics {
  original_prompt: string;
  processed_prompt: string;
  is_compressed: boolean;
  original_tokens: number;
  compressed_tokens: number;
  saved_tokens: number;
  savings_percentage: number;
  execution_time_ms: number;
  /**
   * D2: true yalnızca normal yolda (motor her segmenti kayipsizlik
   * dogrulamasindan gecirdi). `veto_override` ile üretilen ciktilarda false —
   * UI "verified lossless" rozetini buna göre yakar. Eski backend'lerden
   * alan gelmezse (undefined) normal yol varsayilir.
   */
  lossless_verified?: boolean;
  /**
   * True when the backend is unreachable. In this case the result is not real
   * engine output but a safe raw-text passthrough — the UI must honestly
   * inform the user of this (a silent illusion of success is forbidden).
   */
  degraded?: boolean;
  /** Human-readable reason if `degraded` is true. */
  error?: string;
}

export interface EngineStatus {
  is_ready: boolean;
  model_loaded: boolean;
  model_path: string | null;
  info: string;
}

interface HealthResponse {
  ok?: boolean;
  engine?: string;
  info?: string;
}

export class ThalamusClient {
  /**
   * Checks engine status (HTTP backend — the local engine is always ready
   * when the server is reachable).
   */
  async checkEngineStatus(): Promise<EngineStatus> {
    try {
      const res = await fetchTimeout(`${API_BASE}/api/health`, { method: 'GET' }, 3000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthResponse;
      return {
        is_ready: data.ok !== false,
        model_loaded: true,
        model_path: null,
        info: data.info || t('eng.active'),
      };
    } catch {
      return {
        is_ready: false,
        model_loaded: false,
        model_path: null,
        info: t('eng.noConnection'),
      };
    }
  }

  /**
   * Compresses the prompt via the HTTP backend and returns live token
   * savings metrics. If the backend is unreachable, returns the raw text as
   * a safe passthrough.
   */
  async compressPrompt(prompt: string, vetoOverride = false): Promise<CompressionMetrics> {
    try {
      const res = await fetchTimeout(
        `${API_BASE}/api/compress`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, veto_override: vetoOverride }),
        },
        15000
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${detail}`.trim());
      }
      return (await res.json()) as CompressionMetrics;
    } catch (err) {
      // No backend — safe raw-text return, but NOT FAKE:
      // marked with `degraded: true` so the UI does not mislead the user.
      const message =
        err instanceof Error ? err.message : t('eng.connectError');
      const approxTokens = Math.max(1, Math.round(prompt.length / 4));
      return {
        original_prompt: prompt,
        processed_prompt: prompt,
        is_compressed: false,
        original_tokens: approxTokens,
        compressed_tokens: approxTokens,
        saved_tokens: 0,
        savings_percentage: 0,
        execution_time_ms: 0,
        degraded: true,
        error: message,
      };
    }
  }

  async checkHealth(): Promise<boolean> {
    const status = await this.checkEngineStatus();
    return status.is_ready;
  }
}

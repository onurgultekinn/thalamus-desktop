// Ajan Ağı istemcisi — yerel Rust backend'in `/api/agent/*` uçlarına konuşur.
//
// Tasarım: koşu SUNUCU-OTORİTELİdir. İstemci yalnızca başlatır ve durumu
// yoklar; ajanların ürettiği zarflar, tel biçimleri ve token bilançosu
// backend'den geldiği gibi gösterilir (arayüzde yeniden hesaplanmaz).
import { API_BASE, localFetch } from './ThalamusClient';

/** Mock sağlayıcı: deterministik, ağsız; boru hattını anahtarsız sınar. */
export const AGENT_MOCK_PROVIDER = 'mock';

export interface AgentInfo {
  id: string;
  label: string;
  status: string; // idle | thinking | done | error
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface WireMessage {
  seq: number;
  ts_ms: number;
  from: string;
  to: string[];
  kind: string;
  task: string | null;
  status: string;
  /** Çözülmüş zarf (arayüzün "Doğal" görünümü). */
  raw: unknown;
  /** Tel biçimi — @T sıkıştırılmış ya da ham JSON. */
  wire: string;
  raw_tokens: number;
  wire_tokens: number;
  compressed: boolean;
  lossless: boolean;
}

export interface RunMetrics {
  raw_tokens: number;
  wire_tokens: number;
  saved_tokens: number;
  savings_pct: number;
  llm_calls: number;
  repairs: number;
  messages: number;
  findings: number;
}

export interface RunState {
  run_id: string;
  task: string;
  provider: string;
  model: string;
  status: string; // queued | running | done | failed | cancelled
  phase: string;
  error: string | null;
  agents: AgentInfo[];
  messages: WireMessage[];
  metrics: RunMetrics;
  decoder: string;
  started_ms: number;
  finished_ms: number | null;
}

export interface StartRunRequest {
  provider: string;
  base_url?: string;
  api_key?: string;
  model: string;
  task: string;
  max_tasks?: number;
}

/** Koşuyu başlatır; sunucu `run_id` döner. */
export async function startAgentRun(req: StartRunRequest): Promise<string> {
  const res = await localFetch(`${API_BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const data = (await res.json()) as { run_id: string };
  return data.run_id;
}

/** Koşunun güncel durumunu okur. */
export async function fetchAgentState(runId: string): Promise<RunState> {
  const res = await localFetch(
    `${API_BASE}/api/agent/state?run_id=${encodeURIComponent(runId)}`,
    { method: 'GET' }
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return (await res.json()) as RunState;
}

/** Koşuyu iptal eder (bir sonraki adım sınırında durur). */
export async function cancelAgentRun(runId: string): Promise<boolean> {
  const res = await localFetch(`${API_BASE}/api/agent/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { cancelled: boolean };
  return data.cancelled;
}

/** Bitiş durumları (yoklama bu durumlarda durur). */
export const AGENT_TERMINAL = ['done', 'failed', 'cancelled'];

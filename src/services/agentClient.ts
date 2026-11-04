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
  status: string; // idle | queued | thinking | done | error
  /** Bu düğümün işlevi: plan | result | review | report. */
  kind: string;
  /** Hiyerarşideki üst düğüm (kök için null). */
  parent: string | null;
  /** Düğümün kısa görevi. */
  mission: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  /** Son turun süresi (ms). */
  last_ms: number;
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
  /** Uygulanabilir dosya düzenlemesi sayısı. */
  edits: number;
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
  progress: { done: number; total: number };
  started_ms: number;
  finished_ms: number | null;
}

export interface StartRunRequest {
  provider: string;
  base_url?: string;
  /** Anahtar gönderilmez; backend kasasından çözülür. */
  use_stored_key?: boolean;
  model: string;
  task: string;
  max_tasks?: number;
  /** Boş/verilmezse backend yerleşik hattı çalıştırır. */
  org?: OrgPlanPayload;
}

/** Kullanıcının ajan şirketi — koşu bu düğümlerle çalışır. */
export interface OrgPlanPayload {
  name: string;
  agents: {
    id: string;
    parentId: string | null;
    name: string;
    role: string;
    mission: string;
    resp: string;
  }[];
  links: { from: string; to: string; label: string }[];
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

// Son koşu kimliği. Panel kapatılıp yeniden açıldığında koşu YETİM KALMASIN:
// koşu sunucuda yaşamaya devam eder; arayüz son kimlikle yeniden bağlanır.
const LAST_RUN_KEY = 'tlm_agent_last_run';

export function saveLastRunId(runId: string): void {
  try { sessionStorage.setItem(LAST_RUN_KEY, runId); } catch { /* noop */ }
}

export function loadLastRunId(): string | null {
  try {
    const v = sessionStorage.getItem(LAST_RUN_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}

export function clearLastRunId(): void {
  try { sessionStorage.removeItem(LAST_RUN_KEY); } catch { /* noop */ }
}

/** Son koşunun durumu; okunamıyorsa kimliği temizler ve null döner. */
export async function fetchLastRunState(): Promise<RunState | null> {
  const id = loadLastRunId();
  if (!id) return null;
  try {
    return await fetchAgentState(id);
  } catch {
    clearLastRunId();
    return null;
  }
}

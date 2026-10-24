/**
 * User-defined AI connections (saved endpoints).
 *
 * The old hard-coded provider list is gone: the user adds connections, each
 * with a name, a base URL and an API key. Local vs remote is derived from the
 * URL itself (loopback/private hosts = local; everything else = cloud and
 * therefore key-required). Keys still live in the OS credential vault via
 * `lib/secrets` keyed by the connection id.
 *
 * One-time migration: on first launch after the upgrade, every legacy preset
 * with a stored key/base/model (`tlm_key_*`, `tlm_base_*`, `tlm_model_*`) is
 * converted into a connection with the SAME id, so vault entries and model
 * selections keep working untouched.
 */
import { getStoredKey } from './secrets';
import { baseStorageKey, activeProviderStorageKey } from './providers';

export interface Connection {
  id: string;
  name: string;
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Model ids fetched via the connection test (or manually added). */
  models?: string[];
  /** 'none' = models think by default; we send `reasoning_effort: none` off. */
  reasoning?: 'default' | 'none';
  /** Models that reject `reasoning_effort` entirely (EVREN/gemma → HTTP 400). */
  reasoningOffModels?: string[];
}

export const CONNECTIONS_KEY = 'tlm_connections_v1';
/** Fired after any registry write so the UI can refresh. */
export const CONNECTIONS_CHANGED_EVENT = 'tlm_connections_changed';

/**
 * Legacy preset names/endpoints — kept ONLY for one-time migration and for
 * naming scanned local endpoints (Ollama/LM Studio…). Not a picker list.
 */
const LEGACY: Record<
  string,
  { name: string; endpoint?: string; reasoning?: 'none'; reasoningOffModels?: string[] }
> = {
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1' },
  google: { name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  xai: { name: 'xAI Grok', endpoint: 'https://api.x.ai/v1' },
  mistral: { name: 'Mistral', endpoint: 'https://api.mistral.ai/v1' },
  groq: { name: 'Groq', endpoint: 'https://api.groq.com/openai/v1' },
  evren: {
    name: 'EVREN (Savunma Sanayii)',
    endpoint: 'https://evren-llmapi.ssyz.org.tr/v1',
    reasoning: 'none',
    reasoningOffModels: ['gemma-4-31b'],
  },
  openrouter: { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1' },
  together: { name: 'Together AI', endpoint: 'https://api.together.xyz/v1' },
  fireworks: { name: 'Fireworks AI', endpoint: 'https://api.fireworks.ai/inference/v1' },
  perplexity: { name: 'Perplexity', endpoint: 'https://api.perplexity.ai' },
  zhipu: { name: 'Zhipu GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4' },
  moonshot: { name: 'Moonshot Kimi', endpoint: 'https://api.moonshot.cn/v1' },
  qwen: { name: 'Qwen (DashScope)', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  siliconflow: { name: 'SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1' },
  deepbricks: { name: 'DeepBricks', endpoint: 'https://api.deepbricks.ai/v1' },
  ollama: { name: 'Ollama', endpoint: 'http://localhost:11434/v1' },
  lmstudio: { name: 'LM Studio', endpoint: 'http://localhost:1234/v1' },
  custom: { name: 'Custom', endpoint: 'http://localhost:8000/v1' },
  // Uygulamanın kendi başlattığı motor: kullanıcı bağlantısı değildir, göçmez.
  managed: { name: 'Local (managed)' },
};

const MIGRATABLE_IDS = Object.keys(LEGACY).filter((id) => LEGACY[id].endpoint);

/**
 * Loopback / private-network host → local (key optional, local model scan…).
 * Empty or unparseable URLs count as remote so the key field stays required
 * until a real endpoint is typed.
 */
export function isLocalBaseUrl(url: string): boolean {
  const raw = (url || '').trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (!host) return false;
    return (
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.startsWith('127.') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function normalizeConnection(c: Connection): Connection {
  const out: Connection = {
    id: String(c.id || '').trim(),
    name: String(c.name || '').trim(),
    baseUrl: String(c.baseUrl || '').trim().replace(/\/+$/, ''),
  };
  if (Array.isArray(c.models)) {
    const models = c.models.filter((m): m is string => typeof m === 'string' && !!m.trim());
    if (models.length) out.models = models;
  }
  if (c.reasoning === 'none') out.reasoning = 'none';
  if (Array.isArray(c.reasoningOffModels) && c.reasoningOffModels.length) {
    out.reasoningOffModels = c.reasoningOffModels;
  }
  return out;
}

function readRegistry(): Connection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Connection => !!x && typeof x === 'object' && !!(x as Connection).id)
      .map(normalizeConnection)
      .filter((c) => c.id);
  } catch {
    return [];
  }
}

function writeRegistry(list: Connection[]): Connection[] {
  try {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(list));
  } catch { /* noop */ }
  try {
    window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
  } catch { /* noop */ }
  return list;
}

export function listConnections(): Connection[] {
  return readRegistry();
}

export function getConnection(id: string): Connection | undefined {
  if (!id) return undefined;
  return readRegistry().find((c) => c.id === id);
}

/** Insert-or-update by id; returns the persisted list. */
export function saveConnection(conn: Connection): Connection[] {
  const c = normalizeConnection(conn);
  if (!c.id) return readRegistry();
  const list = readRegistry();
  const idx = list.findIndex((x) => x.id === c.id);
  if (idx >= 0) list[idx] = c;
  else list.push(c);
  return writeRegistry(list);
}

/** Alanları birleştirerek günceller (ör. taranan yerel uç nokta seçilince). */
export function upsertConnection(patch: Partial<Connection> & { id: string }): Connection[] {
  const id = String(patch.id || '').trim();
  if (!id) return readRegistry();
  const existing = readRegistry().find((c) => c.id === id);
  return saveConnection({
    id,
    name: String(patch.name ?? existing?.name ?? connectionName(id) ?? id).trim(),
    baseUrl: String(patch.baseUrl ?? existing?.baseUrl ?? '').trim(),
    models: patch.models ?? existing?.models,
    reasoning: patch.reasoning ?? existing?.reasoning,
    reasoningOffModels: patch.reasoningOffModels ?? existing?.reasoningOffModels,
  });
}

export function deleteConnection(id: string): Connection[] {
  return writeRegistry(readRegistry().filter((c) => c.id !== id));
}

/**
 * Taramada bulunan sunucular (Ollama, LM Studio…) otomatik olarak bağlantı
 * listesine eklenir. Kullanıcı birini silerse tekrar eklenmesin diye taban
 * URL "yok sayılanlar" listesine yazılır.
 */
const DISMISSED_ENDPOINTS_KEY = 'tlm_dismissed_endpoints_v1';

function normalizeEndpointUrl(url: string): string {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

export function readDismissedEndpoints(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_ENDPOINTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export function dismissEndpoint(baseUrl: string): void {
  const key = normalizeEndpointUrl(baseUrl);
  if (!key) return;
  const list = new Set(readDismissedEndpoints());
  list.add(key);
  try {
    localStorage.setItem(DISMISSED_ENDPOINTS_KEY, JSON.stringify([...list]));
  } catch { /* noop */ }
}

export function undismissEndpoint(baseUrl: string): void {
  const key = normalizeEndpointUrl(baseUrl);
  if (!key) return;
  const list = readDismissedEndpoints().filter((x) => normalizeEndpointUrl(x) !== key);
  try {
    localStorage.setItem(DISMISSED_ENDPOINTS_KEY, JSON.stringify(list));
  } catch { /* noop */ }
}

export function newConnectionId(): string {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Human label for any provider/connection id (legacy name → raw id). */
export function connectionName(id: string): string {
  return getConnection(id)?.name || LEGACY[id]?.name || id || '';
}

export function readActiveConnectionId(): string {
  try {
    return localStorage.getItem(activeProviderStorageKey) || '';
  } catch {
    return '';
  }
}

export function setActiveConnectionId(id: string): void {
  try {
    if (id) localStorage.setItem(activeProviderStorageKey, id);
    else localStorage.removeItem(activeProviderStorageKey);
  } catch { /* noop */ }
}

let migration: Promise<void> | null = null;

/** Converts legacy preset settings into connections (once, awaited on demand). */
export function ensureConnectionsMigrated(): Promise<void> {
  if (!migration) migration = migrateOnce();
  return migration;
}

async function migrateOnce(): Promise<void> {
  try {
    if (localStorage.getItem(CONNECTIONS_KEY) !== null) return;
  } catch { return; }
  const out: Connection[] = [];
  for (const id of MIGRATABLE_IDS) {
    let base = '';
    let model = '';
    try {
      base = localStorage.getItem(baseStorageKey(id)) || '';
      model = localStorage.getItem(`tlm_model_${id}`) || '';
    } catch { /* noop */ }
    let key = '';
    try {
      key = (await getStoredKey(id)).trim();
    } catch { /* vault yoksa localStorage fallback'ini denemiş olur */ }
    if (!base && !model && !key) continue;
    const preset = LEGACY[id];
    if (!preset?.endpoint) continue;
    out.push(
      normalizeConnection({
        id,
        name: preset.name,
        baseUrl: base || preset.endpoint,
        models: model ? [model] : undefined,
        reasoning: preset.reasoning,
        reasoningOffModels: preset.reasoningOffModels,
      })
    );
  }
  writeRegistry(out);
}

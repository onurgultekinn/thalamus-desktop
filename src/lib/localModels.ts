/**
 * Yerel model keşfi ve tek tıkla çalıştırma (istemci tarafı).
 *
 * Tarama backend'de yapılır (`POST /api/ai/models`): webview yerel sunuculara
 * CORS/karma içerik nedeniyle doğrudan istek atamaz, dosya sistemi de yalnızca
 * yerel tarafta okunabilir. Sonuç 5 dakika önbelleğe alınır; model seçici ve
 * Ayarlar'daki yönetici bu önbellekten beslenir.
 */
import { API_BASE } from '../services/ThalamusClient';
import { getConnection, isLocalBaseUrl } from './connections';

export interface LocalEndpoint {
  /** Sağlayıcı kimliği: ollama | lmstudio | custom (providers.ts ile aynı). */
  provider: string;
  /** Okunabilir ad (ör. "Ollama", "vLLM / TGI / SGLang"). */
  label: string;
  /** OpenAI uyumlu taban URL (…/v1). */
  baseUrl: string;
  /** Sunucunun sunduğu model kimlikleri. */
  models: string[];
}

/** Kurulu çıkarım motoru (Ollama, llama.cpp, Python/transformers…). */
export interface LocalEngine {
  id: string;
  label: string;
  path: string | null;
  ready: boolean;
  detail: string;
  /** llama.cpp Ollama'nın içinden geliyorsa true (ayrı kurulum yok). */
  bundled: boolean;
}

/** Disk üzerinde bulunan model artefaktı. */
export interface ModelFile {
  id: string;
  /** ollama | gguf | safetensors */
  kind: string;
  label: string;
  path: string;
  sizeBytes: number;
  /** Hangi motor çalıştırır: ollama | llamaserver | python. */
  engine: string | null;
  servable: boolean;
  model: string;
  note: string | null;
  /** Bu modeli şu an sunan uç noktalar (`base_url`). */
  servedBy: string[];
}

export interface LocalScan {
  endpoints: LocalEndpoint[];
  engines: LocalEngine[];
  files: ModelFile[];
  system: { gpu: string | null; cpuThreads: number } | null;
}

export interface ServeResult {
  baseUrl: string;
  model: string;
  server: { id: string; kind: string; label: string; port: number; pid: number };
}

const CACHE_KEY = 'tlm_local_scan_v2';
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Keşif listesi değiştiğinde yayılır (arayüz yeniden çizilir). */
export const LOCAL_MODELS_EVENT = 'tlm_local_models_changed';

/** İlk mesajda yerel model yüklenirken yayılır; detail model etiketi (boş = bitti). */
export const LOCAL_LOADING_EVENT = 'tlm_local_loading';

/** Bilinen yerel motor kimlikleri (bağlantı yoksa yedek eşik). */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'custom', 'managed']);

/**
 * Sağlayıcı bu bilgisayarda çalışan bir sunucu mu? Bağlantı kaydı varsa
 * URL'in kendisi karar verir (loopback/private → yerel); kayıt yoksa bilinen
 * yerel motor kimliklerine bakılır.
 */
export function isLocalProvider(providerId: string): boolean {
  const conn = getConnection(providerId);
  if (conn) return isLocalBaseUrl(conn.baseUrl);
  return LOCAL_PROVIDERS.has(providerId);
}

/** `…:8080` → `…:8080/v1`; sondaki eğik çizgiler atılır. */
export function normalizeBaseUrl(url: string): string {
  const t = (url || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.endsWith('/v1') ? t : `${t}/v1`;
}

function normalizeEndpoint(raw: unknown): LocalEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  // Önbellek istemci biçimini (baseUrl), backend yanıtı snake_case (base_url) kullanır.
  const rawBase = typeof e.base_url === 'string' ? e.base_url : e.baseUrl;
  const baseUrl = typeof rawBase === 'string' ? normalizeBaseUrl(rawBase) : '';
  if (!baseUrl) return null;
  const models = Array.isArray(e.models)
    ? e.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : [];
  return {
    provider: typeof e.provider === 'string' ? e.provider : 'custom',
    label: typeof e.label === 'string' ? e.label : baseUrl,
    baseUrl,
    models,
  };
}

function normalizeFile(raw: unknown): ModelFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const id = typeof f.id === 'string' ? f.id : '';
  if (!id) return null;
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
  const served = Array.isArray(f.served_by)
    ? f.served_by.filter((u): u is string => typeof u === 'string')
    : [];
  return {
    id,
    kind: str(f.kind, 'gguf'),
    label: str(f.label, id),
    path: str(f.path),
    sizeBytes: typeof f.size_bytes === 'number' ? f.size_bytes : 0,
    engine: typeof f.engine === 'string' ? f.engine : null,
    servable: f.servable === true,
    model: str(f.model, str(f.label, id)),
    note: typeof f.note === 'string' ? f.note : null,
    servedBy: served.map(normalizeBaseUrl).filter(Boolean),
  };
}

function normalizeEngine(raw: unknown): LocalEngine | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === 'string' ? e.id : '';
  if (!id) return null;
  return {
    id,
    label: typeof e.label === 'string' ? e.label : id,
    path: typeof e.path === 'string' ? e.path : null,
    ready: e.ready === true,
    detail: typeof e.detail === 'string' ? e.detail : '',
    bundled: e.bundled === true,
  };
}

function normalizeScan(raw: unknown): LocalScan | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const arr = <T,>(v: unknown, fn: (x: unknown) => T | null): T[] =>
    Array.isArray(v) ? v.map(fn).filter((x): x is T => x !== null) : [];
  const sys = (s.system ?? null) as Record<string, unknown> | null;
  return {
    endpoints: arr(s.endpoints, normalizeEndpoint),
    engines: arr(s.engines, normalizeEngine),
    files: arr(s.files, normalizeFile),
    system: sys
      ? {
          gpu: typeof sys.gpu === 'string' ? sys.gpu : null,
          cpuThreads: typeof sys.cpu_threads === 'number' ? sys.cpu_threads : 0,
        }
      : null,
  };
}

/** Önbellekteki son tarama (yoksa null). */
export function getCachedLocalScan(): LocalScan | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as
      | { scan?: unknown }
      | null;
    return raw ? normalizeScan(raw.scan) : null;
  } catch {
    return null;
  }
}

/** Önbellekteki çalışan uç noktalar (yoksa boş liste). */
export function getCachedLocalEndpoints(): LocalEndpoint[] {
  return getCachedLocalScan()?.endpoints ?? [];
}

/** Önbellek taze mi (tarama tekrarlanmasın). */
export function localEndpointsFresh(): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as { ts?: number } | null;
    return !!raw?.ts && Date.now() - raw.ts < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/** Aynı anda birden çok tarama isteği olursa (StrictMode/çift tık) tekilleştirir. */
let inflight: Promise<LocalScan> | null = null;

/** Bilgisayardaki tüm yerel modelleri tarar (backend üzerinden). */
export function scanLocalModels(
  extraBaseUrls: string[] = [],
  modelDirs: string[] = [],
): Promise<LocalScan> {
  if (!inflight) {
    inflight = scanOnce(extraBaseUrls, modelDirs).finally(() => { inflight = null; });
  }
  return inflight;
}

async function scanOnce(extraBaseUrls: string[], modelDirs: string[]): Promise<LocalScan> {
  const res = await fetch(`${API_BASE}/api/ai/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_urls: extraBaseUrls.filter((u) => u.trim().length > 0),
      model_dirs: modelDirs.filter((d) => d.trim().length > 0),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail}`.trim());
  }
  const scan = normalizeScan(await res.json());
  if (!scan) throw new Error('Tarama yanıtı anlaşılamadı.');
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), scan }));
  } catch { /* storage full — liste yine döner */ }
  try {
    window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
  } catch { /* noop */ }
  return scan;
}

/**
 * Bir sağlayıcı için keşfedilmiş model kimlikleri.
 * `custom` ve `managed` sağlayıcılarında yalnızca taban URL eşleşmesi
 * geçerlidir (birden çok farklı sunucu aynı sağlayıcı kimliğini kullanır).
 */
export function localModelsFor(providerId: string, baseUrl: string): string[] {
  if (!isLocalProvider(providerId)) return [];
  const target = normalizeBaseUrl(baseUrl);
  const baseOnly = providerId === 'custom' || providerId === 'managed';
  const out = new Set<string>();
  for (const ep of getCachedLocalEndpoints()) {
    const sameBase = !!target && normalizeBaseUrl(ep.baseUrl) === target;
    const sameProvider = ep.provider === providerId;
    if (baseOnly ? sameBase : sameBase || sameProvider) {
      for (const m of ep.models) out.add(m);
    }
  }
  return [...out];
}

/** Bir model dosyasını çalıştırır (motoru indirmez; mevcut motoru kullanır). */
export async function serveLocalModel(id: string, path?: string): Promise<ServeResult> {
  const res = await fetch(`${API_BASE}/api/ai/serve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...(path ? { path } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    base_url: string;
    model: string;
    server: { id: string; kind: string; label: string; port: number; pid: number };
  };
  try {
    window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
  } catch { /* noop */ }
  setLastLocalModel({
    id,
    path,
    model: data.model,
    label: data.server?.label || data.model,
  });
  return { baseUrl: data.base_url, model: data.model, server: data.server };
}

/** Yönetilen bir sunucuyu durdurur. */
export interface StopServeResult {
  /** Süreç gerçekten kapatıldı. */
  stopped: boolean;
  /** Süren istek vardı; son istek bitince kapatılacak. */
  queued: boolean;
}

export async function stopLocalModel(id: string, whenIdle = false): Promise<StopServeResult> {
  const res = await fetch(`${API_BASE}/api/ai/serve/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, when_idle: whenIdle }),
  });
  if (!res.ok) return { stopped: false, queued: false };
  const data = (await res.json().catch(() => ({}))) as {
    stopped?: boolean;
    queued?: boolean;
  };
  try {
    window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
  } catch { /* noop */ }
  return { stopped: data.stopped === true, queued: data.queued === true };
}

/** Ollama modelini servisi kapatmadan VRAM'den boşaltır. */
export async function unloadLocalModel(baseUrl: string, model: string): Promise<boolean> {
  if (!baseUrl || !model) return false;
  try {
    const res = await fetch(`${API_BASE}/api/ai/serve/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: baseUrl, model }),
    });
    if (!res.ok) return false;
    try {
      window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
    } catch { /* noop */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kullanıcının seçtiği ama HENÜZ başlatılmamış yerel model.
 *
 * Seçim anında motoru başlatmak RAM/CPU'yu meşgul ediyor ve model listesinde
 * gezinmeyi zorlaştırıyordu; bu yüzden seçim yalnızca burada tutulur ve model
 * ilk istek gönderilirken (`aiClient`) yüklenir.
 */
export interface PendingLocalModel {
  id: string;
  path?: string;
  model: string;
  label: string;
}

const PENDING_LOCAL_KEY = 'tlm_pending_local_v1';

export function getPendingLocalModel(): PendingLocalModel | null {
  try {
    const raw = localStorage.getItem(PENDING_LOCAL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingLocalModel>;
    if (!v?.id || !v?.model) return null;
    return {
      id: String(v.id),
      path: v.path ? String(v.path) : undefined,
      model: String(v.model),
      label: String(v.label || v.model),
    };
  } catch {
    return null;
  }
}

export function setPendingLocalModel(value: PendingLocalModel): void {
  try {
    localStorage.setItem(PENDING_LOCAL_KEY, JSON.stringify(value));
  } catch { /* noop */ }
  try {
    window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
  } catch { /* noop */ }
}

export function clearPendingLocalModel(): void {
  try {
    localStorage.removeItem(PENDING_LOCAL_KEY);
  } catch { /* noop */ }
  try {
    window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
  } catch { /* noop */ }
}

/** Son yüklenen yerel model; sunucu uykuya/kapalıya geçince geri getirmek için. */
const LAST_LOCAL_KEY = 'tlm_last_local_v1';

export function getLastLocalModel(): PendingLocalModel | null {
  try {
    const raw = localStorage.getItem(LAST_LOCAL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingLocalModel>;
    if (!v?.id || !v?.model) return null;
    return {
      id: String(v.id),
      path: v.path ? String(v.path) : undefined,
      model: String(v.model),
      label: String(v.label || v.model),
    };
  } catch {
    return null;
  }
}

export function setLastLocalModel(value: PendingLocalModel): void {
  try {
    localStorage.setItem(LAST_LOCAL_KEY, JSON.stringify(value));
  } catch { /* noop */ }
}

/** Şu an çalışan (bu uygulamanın başlattığı) sunucular. */
export async function listServing(): Promise<
  { id: string; kind: string; label: string; model: string; base_url: string; port: number; pid: number }[]
> {
  try {
    const res = await fetch(`${API_BASE}/api/ai/serve`);
    if (!res.ok) return [];
    const data = (await res.json()) as { servers?: unknown[] };
    return Array.isArray(data.servers)
      ? (data.servers as { id: string; kind: string; label: string; model: string; base_url: string; port: number; pid: number }[])
      : [];
  } catch {
    return [];
  }
}

/** 0 → "—", 1.4 GB → "1.4 GB". */
export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** `served_by` listesinden hangi sağlayıcıya yazılacağını çıkarır. */
export function providerForBase(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (/:11434\/v1$/.test(base)) return 'ollama';
  if (/:1234\/v1$/.test(base)) return 'lmstudio';
  return 'custom';
}

/** Seçicide/Ayarlar'da gösterilen tek satırlık yerel model. */
export interface LocalModelEntry {
  /** Kararlı anahtar (busy durumu ve React key'i için). */
  key: string;
  label: string;
  model: string;
  provider: string;
  baseUrl: string;
  /** Şu an bir sunucu tarafından servis ediliyor mu? */
  running: boolean;
  /** Başlatılabilir bir disk dosyası mı? */
  servable: boolean;
  /** Şu an seçili model mi? */
  inUse: boolean;
  /** Uygulamanın başlattığı sunucu ise durdurma kimliği. */
  serverId?: string;
  /** Kullanılamıyorsa nedeni (tooltip'te gösterilir). */
  note?: string;
}

/**
 * Ham model etiketini okunaklı bir ada indirger: klasör yolu, dosya uzantısı
 * ve kuantizasyon kuyruğu (`-q4_k_m`, `-f16`…) atılır. Orijinal ad tooltip'te
 * (`model`) kalır.
 */
export function localModelDisplayName(label: string): string {
  const raw = label.trim();
  let s = raw.split(/[\\/]/).pop() || raw;
  s = s.replace(/\.(gguf|safetensors|bin)$/i, '');
  s = s.replace(/(?:[._-](?:q\d+(?:_[a-z0-9]+)*|f16|fp16|bf16|int4|int8|gguf))+$/i, '');
  s = s.replace(/[._\-\s]+$/, '').trim();
  return s || raw;
}

/**
 * Sunucular + endpoint'ler + disk dosyalarını TEK listeye indirger.
 *
 * Aynı model birden çok kaynakta görünebilir (Ollama endpoint'i + disk bloğu);
 * model adına göre tekrarlar atılır. Sıra: kullanımdaki → çalışan → başlatılabilir → diğer.
 */
export function buildLocalModelEntries(args: {
  endpoints: LocalEndpoint[];
  files: ModelFile[];
  servers: { id: string; model: string; base_url: string }[];
  activeProvider: string;
  currentModel: string;
}): LocalModelEntry[] {
  const seen = new Set<string>();
  const norm = (s: string) => s.trim().toLowerCase();
  const entries: LocalModelEntry[] = [];

  for (const ep of args.endpoints) {
    for (const model of ep.models) {
      if (seen.has(norm(model))) continue;
      seen.add(norm(model));
      const server = args.servers.find(
        (s) => s.model === model && normalizeBaseUrl(s.base_url) === ep.baseUrl
      );
      entries.push({
        key: `ep:${ep.baseUrl}:${model}`,
        label: localModelDisplayName(model),
        model,
        provider: ep.provider,
        baseUrl: ep.baseUrl,
        running: true,
        servable: true,
        inUse: args.activeProvider === ep.provider && args.currentModel === model,
        serverId: server?.id,
      });
    }
  }

  for (const file of args.files) {
    if (seen.has(norm(file.model))) continue;
    seen.add(norm(file.model));
    const server = args.servers.find((s) => s.model === file.model);
    const baseUrl = server?.base_url ? normalizeBaseUrl(server.base_url) : (file.servedBy[0] ?? '');
    const running = !!baseUrl;
    const provider = running ? (server ? 'managed' : providerForBase(baseUrl)) : '';
    entries.push({
      key: `file:${file.id}`,
      label: localModelDisplayName(file.label),
      model: file.model,
      provider,
      baseUrl,
      running,
      servable: file.servable,
      inUse: running && args.activeProvider === provider && args.currentModel === file.model,
      serverId: server?.id,
      note: file.note ?? undefined,
    });
  }

  return entries.sort((a, b) => {
    if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.servable !== b.servable) return a.servable ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

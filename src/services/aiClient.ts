/**
 * The single fetch point for AI chat. Provider resolution + the `/api/ai/chat`
 * call are gathered here; the two separate manual fetches in Copilot were removed.
 *
 * Keys are read from the OS keychain via `lib/secrets`; the active provider is
 * one of the user's saved connections (`lib/connections`). If that connection
 * has no key the fallback happens among the other key-carrying connections.
 * Local endpoints (loopback URLs) are never auto-selected as fallback.
 */
import { API_BASE, localFetch } from './ThalamusClient';
import {
  activeProviderStorageKey,
  baseStorageKey,
} from '../lib/providers';
import {
  connectionName,
  ensureConnectionsMigrated,
  isLocalBaseUrl,
  listConnections,
} from '../lib/connections';
import { getProviderModel, setProviderModel, supportsReasoningEffort } from '../lib/models';
import { readShowReasoning } from '../lib/reasoning';
import {
  clearPendingLocalModel,
  getLastLocalModel,
  getPendingLocalModel,
  listServing,
  LOCAL_LOADING_EVENT,
  normalizeBaseUrl,
  serveLocalModel,
  stopLocalModel,
  unloadLocalModel,
  type ServeResult,
} from '../lib/localModels';
import { hasStoredKey } from '../lib/secrets';

export interface AiEditResult {
  file: string;
  applied: boolean;
  message: string;
  new_body: string | null;
}

export interface AiChatResponse {
  content: string;
  /** Destekleyen sağlayıcılarda modelin düşünme metni. */
  reasoning?: string;
  rounds?: number;
  finishReason?: string;
  edits?: AiEditResult[];
  /** todo_write aracının son adım listesi (content + status). */
  todos?: { content: string; status: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Sağlayıcı prompt cache'inden karşılanan girdi token'ı (maliyet ~10x ucuz). */
    cachedTokens?: number;
    /** EVREN kredi bakiyesi snapshot'ı (kullanıcının kota görünürlüğü için). */
    creditsRemaining?: string;
  };
}

export interface CodeBlock {
  id: string;
  name: string;
  body: string;
}

export interface ActiveProvider {
  id: string;
  name: string;
  /** Anahtar DEĞERİ burada YOK; yalnız kasada kayıtlı mı bilgisi. */
  hasKey: boolean;
  baseUrl: string;
  model: string;
  /** Düşünme kapatılırken gönderilecek değer (ör. EVREN/vLLM için "none"). */
  reasoningEffort?: string;
  /** Sağlayıcı düşünme üretiyor mu (arayüzde rozet/ipucu için). */
  supportsReasoning?: boolean;
}

/**
 * Düşünme tercihi: kullanıcı "göster" seçtiyse `reasoning_effort` GÖNDERİLMEZ
 * (model düşünür ve metni arayüzde görünür). "Kapat" seçtiyse sağlayıcının
 * beklediği değer (ör. "none") gönderilir — düşünme token'ları faturalanmaz.
 */
function reasoningPreference(
  disableValue: string | undefined,
  providerId?: string,
  modelId?: string
): string | undefined {
  if (!disableValue) return undefined;
  // Bazı modeller `reasoning_effort` parametresini reddeder (EVREN/gemma-4-31b
  // → HTTP 400). Sağlayıcı düzeyinde "none" göndermek yerine modeli de sor.
  if (providerId && modelId && !supportsReasoningEffort(providerId, modelId)) return undefined;
  return readShowReasoning() ? undefined : disableValue;
}

/**
 * Resolves the active provider: the user's chosen connection first, then the
 * other saved connections that can actually serve (key present). Returns null
 * when nothing is configured. Local connections are only used when explicitly
 * selected — never as an automatic fallback.
 */
export async function getActiveProvider(): Promise<ActiveProvider | null> {
  await ensureConnectionsMigrated();
  const preferred = (() => {
    try {
      return localStorage.getItem(activeProviderStorageKey);
    } catch {
      return null;
    }
  })();

  // `managed`: uygulamanın kendi başlattığı yerel motor; bağlantı listesinde
  // değil, seçim + taban URL + model localStorage'da tutulur.
  if (preferred === 'managed') {
    const model = getProviderModel('managed');
    if (model) {
      let base = '';
      try {
        base = localStorage.getItem(baseStorageKey('managed')) || '';
      } catch { /* noop */ }
      return {
        id: 'managed',
        name: connectionName('managed'),
        hasKey: false,
        baseUrl: base || 'http://127.0.0.1:11500/v1',
        model,
      };
    }
  }

  const connections = listConnections();
  const ordered = [
    ...connections.filter((c) => c.id === preferred),
    ...connections.filter((c) => c.id !== preferred),
  ];

  for (const c of ordered) {
    const local = isLocalBaseUrl(c.baseUrl);
    const hasKey = await hasStoredKey(c.id).catch(() => false);
    // Yerel uç noktalar anahtarsız çalışır; uzak bağlantılar anahtarsız ELLENİR.
    if (!local && !hasKey) continue;
    // Yerel bağlantılar yalnızca açıkça seçiliyken kullanılır (fallback değil).
    if (local && c.id !== preferred) continue;
    const model = getProviderModel(c.id);
    return {
      id: c.id,
      name: c.name || connectionName(c.id),
      hasKey,
      baseUrl: c.baseUrl,
      model,
      reasoningEffort: reasoningPreference(
        c.reasoning === 'none' ? 'none' : undefined,
        c.id,
        model
      ),
      supportsReasoning: c.reasoning === 'none',
    };
  }
  return null;
}

function announceLocalLoading(label: string) {
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_LOADING_EVENT, { detail: label }));
  } catch { /* noop */ }
}

/** Hızlı llama-server yolundan önce Ollama'nın VRAM'deki kopyasını bırak. */
async function freeOllamaBeforeServe(id: string, model: string): Promise<void> {
  if (!id.startsWith('ollama:')) return;
  await unloadLocalModel('http://127.0.0.1:11434/v1', model).catch(() => false);
}

/**
 * Kullanıcı bir yerel model SEÇTİĞİNDE motoru başlatmayız; seçim "bekleyen"
 * olarak saklanır. İlk istek burada gelince model yüklenir, `managed` uç
 * noktası yazılır ve seçim temizlenir. Böylece model seçimi anında RAM/CPU
 * kilitlenmez; yükleme süresi zaten ilk cevabın içinde kalır.
 */
async function beginPendingLocal(): Promise<void> {
  const pending = getPendingLocalModel();
  if (!pending) return;
  announceLocalLoading(pending.label);
  let served: ServeResult;
  try {
    await freeOllamaBeforeServe(pending.id, pending.model);
    served = await serveLocalModel(pending.id, pending.path);
  } finally {
    // Yükleme bitti ya da başarısız: durum yazısını kaldır.
    announceLocalLoading('');
  }
  try {
    localStorage.setItem(activeProviderStorageKey, 'managed');
    localStorage.setItem(baseStorageKey('managed'), served.baseUrl);
  } catch { /* noop */ }
  setProviderModel('managed', served.model);
  clearPendingLocalModel();
}

/**
 * Uykuya alınmış sunucu listede kalır (istek gelince uyanır). Boşta kapatma
 * sonrası ise listeden düşer; burada son seçilen modeli yeniden başlatırız.
 * Böylece boşta kapatılan model sonrası gelen ilk mesaj "sunucu yok" hatası almaz.
 */
async function reviveManaged(): Promise<void> {
  const active = await getActiveProvider();
  if (!active || active.id !== 'managed' || !active.baseUrl) return;
  const last = getLastLocalModel();
  if (!last) return;
  const target = normalizeBaseUrl(active.baseUrl);
  const servers = await listServing();
  if (servers.some((s) => normalizeBaseUrl(s.base_url) === target)) return;
  announceLocalLoading(last.label);
  let served: ServeResult;
  try {
    await freeOllamaBeforeServe(last.id, last.model);
    served = await serveLocalModel(last.id, last.path);
  } finally {
    announceLocalLoading('');
  }
  try {
    localStorage.setItem(baseStorageKey('managed'), served.baseUrl);
  } catch { /* noop */ }
  setProviderModel('managed', served.model);
}

let closing: Promise<void> = Promise.resolve();

async function providerForRequest(): Promise<ActiveProvider | null> {
  // Önceki cevabın kapatma işlemi bitmeden yeni model başlatma: aynı portta
  // öldürme/yeniden yükleme yarışı olmasın.
  await closing.catch(() => {});
  await beginPendingLocal();
  await reviveManaged();
  return getActiveProvider();
}

async function waitUntilStopped(target: string, maxMs = 1500): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const servers = await listServing().catch(() => []);
    if (!servers.some((s) => normalizeBaseUrl(s.base_url) === target)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Yanıt bitti: yerel modeli hemen kapat (donanım yalnızca cevap sürerken
 * kullanılsın). Süren başka istek varsa backend "istek bitince" kuyruğuna alır;
 * bu durumda gerçekten kapanana kadar kısa süre bekleriz.
 */
function closeLocalAfterAnswer(p: ActiveProvider): Promise<void> {
  // Ollama servisi kalır; yalnızca model VRAM'den boşaltılır. "managed"
  // sağlayıcısı da Ollama uç noktasına işaret edebilir (bekleyen seçim).
  const base = p.baseUrl || '';
  if (p.id === 'ollama' || /:11434(?:\/|$)/.test(base)) {
    closing = closing.catch(() => {}).then(async () => {
      await unloadLocalModel(base, p.model);
    });
    return closing;
  }
  if (p.id !== 'managed') return closing;
  const target = normalizeBaseUrl(base);
  closing = closing.catch(() => {}).then(async () => {
    try {
      const servers = await listServing();
      const server = servers.find((s) => normalizeBaseUrl(s.base_url) === target);
      const last = getLastLocalModel();
      const id = server?.id ?? (last && !last.id.startsWith('ollama:') ? last.id : undefined);
      if (!id) return;
      const res = await stopLocalModel(id, true);
      if (res.queued) await waitUntilStopped(target);
    } catch { /* kapanmasa da idle politikası devreye girer */ }
  });
  return closing;
}

/** A single content part for multimodal messages. */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface AiMessage {
  role: 'user' | 'system' | 'assistant';
  content: string | AiContentPart[];
}

/** Minimal shape needed to send an image part. */
export interface AiImageInput {
  url: string;
  detail?: 'low' | 'high' | 'auto';
}

/**
 * Builds a user message. Attached images are sent as real image parts
 * (OpenAI-compatible `image_url` with a data URL); the Rust proxy forwards the
 * message untouched, so no backend change is needed. `detail` is what actually
 * controls the token cost on OpenAI-compatible APIs (`low` is a flat ~85).
 */
export function userMessage(text: string, images: AiImageInput[] = []): AiMessage {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: img.url, ...(img.detail ? { detail: img.detail } : {}) },
      })),
    ],
  };
}

/** AI chat through the local Rust proxy. */
export interface AiChatOptions {
  /** Kullanıcı birebir/orijinal metin istedi → motor sıkıştırmasını kapat. */
  preserve?: boolean;
  /** Model yönlendirici bu istek için farklı model seçtiyse. */
  model?: string;
  /** Yanıt bitince yerel modeli kapat (tek seferlik görsel/araç çağrıları). */
  closeAfter?: boolean;
  /** İzin modu (readonly|plan|ask|auto|safe|autonomous). auto/autonomous
   *  modlarında backend run_command (kabuk) aracını modele açar. */
  permission?: string;
  /** false → araç şemaları hiç gönderilmez (~950 token/istek tasarrufu).
   *  Yalnız araç gerektirmeyen dahili çağrılarda (özetleme, komut palası)
   *  kapatın; kullanıcıya açık sohbet yüzeylerinde AÇIK kalmalı. */
  toolsEnabled?: boolean;
}

function readSetting(key: string): string {
  try {
    return (localStorage.getItem(key) || '').trim();
  } catch {
    return '';
  }
}

/** Ayarlar > Sohbet'teki kullanıcı talimatı; yoksa boş dize. */
export function readCustomInstructions(): string {
  return readSetting('tlm_custom_instructions');
}

/**
 * Üretim parametreleri (Ayarlar > Sohbet). Boş/geçersiz değer GÖNDERİLMEZ:
 * sağlayıcı varsayılanı korunur — uydurma bir sıcaklık dayatılmaz.
 */
export function readGenerationOptions(): { temperature?: number; maxTokens?: number } {
  const tempRaw = readSetting('tlm_temperature');
  const temp = tempRaw === '' ? NaN : Number(tempRaw.replace(',', '.'));
  const maxRaw = readSetting('tlm_max_tokens');
  const max = maxRaw === '' ? NaN : Number(maxRaw);
  return {
    temperature: Number.isFinite(temp) && temp >= 0 && temp <= 2 ? temp : undefined,
    maxTokens: Number.isFinite(max) && max >= 1 && max <= 32768 ? Math.round(max) : undefined,
  };
}

/**
 * Kullanıcı talimatını sistem mesajına ekler. Sistem mesajı yoksa (ör. görsel
 * isteği) başa yeni bir sistem mesajı konur; içerik mesajları değişmez.
 */
function withInstructions(messages: AiMessage[]): AiMessage[] {
  const instructions = readCustomInstructions();
  if (!instructions) return messages;
  const block = `USER INSTRUCTIONS (from the user's settings):\n${instructions}`;
  const first = messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${block}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: block }, ...messages];
}

export interface AiChatStreamHandlers {
  /** Her metin parçası geldiğinde çağrılır (sırayla eklenir). */
  onDelta: (text: string) => void;
  /** Düşünme (reasoning) parçası (destekleyen sağlayıcılarda). */
  onReasoning?: (text: string) => void;
  /** İlk olay: motorun sıkıştırma bilançosu (görünmez katman). */
  onMeta?: (meta: {
    engine?: { compressed_messages?: number; original_tokens?: number; compressed_tokens?: number };
  }) => void;
  /** Backend bir araç çağrısını yürütmeden hemen önce (ajan döngüsü görünürlüğü). */
  onToolCall?: (name: string) => void;
}

/**
 * Akışlı sohbet: `/api/ai/chat/stream` (SSE). Sağlayıcı akışı desteklemiyorsa
 * backend tek JSON döndürür; bu durumda içerik tek parça olarak `onDelta`'ya
 * verilir — çağıran taraf için davranış aynıdır.
 */
export async function aiChatStream(
  messages: AiMessage[],
  codeBlocks: CodeBlock[] = [],
  provider: ActiveProvider | null | undefined,
  signal: AbortSignal | undefined,
  opts: AiChatOptions,
  handlers: AiChatStreamHandlers
): Promise<AiChatResponse> {
  const p = provider ?? (await providerForRequest());
  if (!p) throw new Error('API_KEY_MISSING');
  // Yalnızca seçili sağlayıcı üzerinden gelen sohbet: cevap bitince kapat.
  const closeAfter = !provider && (p.id === 'managed' || p.id === 'ollama');
  // Ollama modeli yanıt sonrası boşaltıldığı için sıradaki istekte yeniden
  // yüklenir; ilk token'a kadar "model yükleniyor" göster.
  const ollama = p.id === 'ollama' || /:11434(?:\/|$)/.test(p.baseUrl || '');
  if (closeAfter && ollama) announceLocalLoading(p.model || p.name);
  // Uzun cevaplar 180 sn'yi aşabilir; akışta üst sınır 10 dk.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('TIMEOUT_600S'));
  }, 600_000);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  try {
    const gen = readGenerationOptions();
    const res = await localFetch(`${API_BASE}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: p.id,
        // Anahtar istek gövdesine GİRMEZ: backend kasa (Credential Manager,
        // DPAPI) üzerinden provider kimliğiyle çözer. JS sürecinde key yok.
        use_stored_key: true,
        model: opts.model || p.model,
        base_url: p.baseUrl || undefined,
        messages: withInstructions(messages),
        code_blocks: codeBlocks,
        reasoning_effort: p.reasoningEffort || undefined,
        preserve: opts.preserve || undefined,
        permission: opts.permission || undefined,
        tools_enabled: opts.toolsEnabled === false ? false : undefined,
        temperature: gen.temperature,
        max_tokens: gen.maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail}`.trim());
    }

    const contentType = res.headers.get('content-type') || '';
    // Akış yok (eski backend ya da akışsız sağlayıcı): tek parçalık yanıt.
    if (!res.body || !contentType.includes('text/event-stream')) {
      const data = (await res.json()) as AiChatResponse;
      if (data.content) handlers.onDelta(data.content);
      if (data.reasoning) handlers.onReasoning?.(data.reasoning);
      return data;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let edits: AiEditResult[] | undefined;
    let todos: AiChatResponse['todos'];
    let usage:
      | (AiChatResponse['usage'] & {
          prompt_tokens_details?: { cached_tokens?: number };
          prompt_cache_hit_tokens?: number;
        })
      | undefined;
    let rounds: number | undefined;
    let finishReason: string | undefined;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event: {
          type?: string;
          content?: string;
          name?: string;
          edits?: AiEditResult[];
          todos?: { content: string; status: string }[];
          message?: string;
          usage?: (AiChatResponse['usage']) & {
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
            evren?: { credits_remaining_cr?: string; routed_model?: string };
          };
          rounds?: number;
          finish_reason?: string;
          engine?: { compressed_messages?: number; original_tokens?: number; compressed_tokens?: number };
        };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === 'delta' && event.content) {
          content += event.content;
          handlers.onDelta(event.content);
        } else if (event.type === 'reasoning' && event.content) {
          reasoning += event.content;
          handlers.onReasoning?.(event.content);
        } else if (event.type === 'meta') {
          handlers.onMeta?.({ engine: event.engine });
        } else if (event.type === 'tool_call' && event.name) {
          handlers.onToolCall?.(event.name);
        } else if (event.type === 'done') {
          usage = event.usage;
          rounds = event.rounds;
          finishReason = event.finish_reason;
          // Ajan edit'leri (edit_file/write_file) ve todo listesi akışta da
          // gelir — yakalanmazsa sessizce düşer (uygulama/uygulamama kararı
          // çağıranındır ama veri kaybolamaz).
          if (event.edits?.length) edits = event.edits;
          if (event.todos?.length) todos = event.todos;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'stream error');
        }
      }
    }
    type UsageWithProvider = (AiChatResponse['usage']) & {
      prompt_tokens_details?: { cached_tokens?: number };
      prompt_cache_hit_tokens?: number;
      evren?: { credits_remaining_cr?: string; routed_model?: string };
    };
    const withExtras = (u?: UsageWithProvider) => {
      if (!u) return u;
      const cached =
        (u.prompt_tokens_details?.cached_tokens ?? 0) + (u.prompt_cache_hit_tokens ?? 0);
      const credits = (u as { evren?: { credits_remaining_cr?: string } }).evren
        ?.credits_remaining_cr;
      return {
        ...u,
        ...(cached ? { cachedTokens: cached } : {}),
        ...(credits ? { creditsRemaining: credits } : {}),
      };
    };
    return {
      content,
      reasoning: reasoning || undefined,
      edits,
      todos,
      usage: withExtras(usage),
      rounds,
      finishReason,
    };
  } catch (err) {
    // Kendi süre aşımımız: çağıran taraf "durduruldu" değil "süre doldu" desin.
    if (timedOut) throw new Error('TIMEOUT_600S');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    if (closeAfter && ollama) announceLocalLoading('');
    if (closeAfter) void closeLocalAfterAnswer(p);
  }
}

export async function aiChat(
  messages: AiMessage[],
  codeBlocks: CodeBlock[] = [],
  provider?: ActiveProvider | null,
  signal?: AbortSignal,
  opts: AiChatOptions = {}
): Promise<AiChatResponse> {
  const p = provider ?? (await providerForRequest());
  if (!p) throw new Error('API_KEY_MISSING');

  // Backend'de 120s transport timeout var; buradaki 180s üst sınır, asılı
  // isteklerin arayüzü sonsuz kilitlememesi için istemci tarafı güvencesi.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT_180S')), 180_000);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  try {
    const gen = readGenerationOptions();
    const res = await localFetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: p.id,
        // Anahtar istek gövdesine GİRMEZ: backend kasa (Credential Manager,
        // DPAPI) üzerinden provider kimliğiyle çözer. JS sürecinde key yok.
        use_stored_key: true,
        model: opts.model || p.model,
        base_url: p.baseUrl || undefined,
        messages: withInstructions(messages),
        code_blocks: codeBlocks,
        // Sağlayıcı düşünme modunu kapatmayı gerektiriyorsa (ör. EVREN/vLLM)
        // bu alan gönderilir; yoksa yanıtlar kesilir (ölçüldü).
        reasoning_effort: p.reasoningEffort || undefined,
        preserve: opts.preserve || undefined,
        permission: opts.permission || undefined,
        tools_enabled: opts.toolsEnabled === false ? false : undefined,
        temperature: gen.temperature,
        max_tokens: gen.maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail}`.trim());
    }
    const data = (await res.json()) as AiChatResponse & {
      usage?: {
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      };
    };
    const rawUsage = data.usage as
      | (AiChatResponse['usage'] & {
          prompt_tokens_details?: { cached_tokens?: number };
          prompt_cache_hit_tokens?: number;
          evren?: { credits_remaining_cr?: string };
        })
      | undefined;
    if (rawUsage) {
      const cached =
        (rawUsage.prompt_tokens_details?.cached_tokens ?? 0) +
        (rawUsage.prompt_cache_hit_tokens ?? 0);
      if (cached) data.usage = { ...data.usage, cachedTokens: cached };
      const credits = rawUsage.evren?.credits_remaining_cr;
      if (credits) data.usage = { ...data.usage, creditsRemaining: credits };
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    if (opts.closeAfter) void closeLocalAfterAnswer(p);
  }
}

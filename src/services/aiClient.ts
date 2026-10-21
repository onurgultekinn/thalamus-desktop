/**
 * The single fetch point for AI chat. Provider resolution + the `/api/ai/chat`
 * call are gathered here; the two separate manual fetches in Copilot were removed.
 *
 * Keys are read from the OS keychain via `lib/secrets`; the active provider is
 * selected from the `tlm_active_provider` setting, and if that provider has no
 * key the fallback happens among local-only-picked + cloud providers. Local
 * endpoints (Ollama, LM Studio) are never auto-selected as fallback.
 */
import { API_BASE } from './ThalamusClient';
import {
  API_PROVIDERS,
  providerEndpoint,
  activeProviderStorageKey,
  baseStorageKey,
  type ApiProvider,
} from '../lib/providers';
import { getProviderModel, supportsReasoningEffort } from '../lib/models';
import { readShowReasoning } from '../lib/reasoning';
import { getStoredKey } from '../lib/secrets';

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
  edits?: AiEditResult[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface CodeBlock {
  id: string;
  name: string;
  body: string;
}

export interface ActiveProvider {
  id: string;
  name: string;
  key: string;
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
 * Resolves the active provider: first the user's choice, then the registry
 * order. Returns null if no provider has a key.
 */
export async function getActiveProvider(): Promise<ActiveProvider | null> {
  const preferred = (() => {
    try {
      return localStorage.getItem(activeProviderStorageKey);
    } catch {
      return null;
    }
  })();

  // A local provider is valid only when the user explicitly picked it.
  if (preferred) {
    const picked = API_PROVIDERS.find((p) => p.id === preferred);
    if (picked && picked.family === 'local') {
      const customBase = localStorage.getItem(baseStorageKey(picked.id)) || undefined;
      const model = getProviderModel(picked.id);
      return {
        id: picked.id,
        name: picked.name,
        key: (await getStoredKey(picked.id)).trim(),
        baseUrl: providerEndpoint(picked, customBase || picked.defaultBaseUrl),
        model,
        reasoningEffort: reasoningPreference(picked.reasoningEffort, picked.id, model),
        supportsReasoning: !!picked.reasoningEffort,
      };
    }
  }

  const ordered: ApiProvider[] = [
    ...API_PROVIDERS.filter((p) => p.id === preferred),
    // Fallback cloud providers only: local endpoints (Ollama/LM Studio) must
    // never be auto-selected — they are only used when explicitly chosen.
    ...API_PROVIDERS.filter(
      (p) =>
        p.id !== preferred &&
        p.family !== 'anthropic' &&
        p.family !== 'local'
    ),
  ];

  for (const p of ordered) {
    if (p.family === 'anthropic') continue; // the backend proxy does not speak this format yet
    const key = (await getStoredKey(p.id)).trim();
    // Local endpoints are valid without a key; cloud providers are not.
    if (p.family !== 'local' && !key) continue;
    const customBase = localStorage.getItem(baseStorageKey(p.id)) || undefined;
    const model = getProviderModel(p.id);
    return {
      id: p.id,
      name: p.name,
      key,
      baseUrl: providerEndpoint(p, customBase || p.defaultBaseUrl),
      model,
      reasoningEffort: reasoningPreference(p.reasoningEffort, p.id, model),
      supportsReasoning: !!p.reasoningEffort,
    };
  }
  return null;
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
  const p = provider ?? (await getActiveProvider());
  if (!p) throw new Error('API_KEY_MISSING');

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
    const res = await fetch(`${API_BASE}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: p.id,
        api_key: p.key,
        model: opts.model || p.model,
        base_url: p.baseUrl || undefined,
        messages,
        code_blocks: codeBlocks,
        reasoning_effort: p.reasoningEffort || undefined,
        preserve: opts.preserve || undefined,
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
    let usage: AiChatResponse['usage'];
    let rounds: number | undefined;

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
          message?: string;
          usage?: AiChatResponse['usage'];
          rounds?: number;
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
        } else if (event.type === 'done') {
          usage = event.usage;
          rounds = event.rounds;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'stream error');
        }
      }
    }
    return { content, reasoning: reasoning || undefined, usage, rounds };
  } catch (err) {
    // Kendi süre aşımımız: çağıran taraf "durduruldu" değil "süre doldu" desin.
    if (timedOut) throw new Error('TIMEOUT_600S');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export async function aiChat(
  messages: AiMessage[],
  codeBlocks: CodeBlock[] = [],
  provider?: ActiveProvider | null,
  signal?: AbortSignal,
  opts: AiChatOptions = {}
): Promise<AiChatResponse> {
  const p = provider ?? (await getActiveProvider());
  if (!p) throw new Error('API_KEY_MISSING');

  // Backend'de 120s transport timeout var; buradaki 180s üst sınır, asılı
  // isteklerin arayüzü sonsuz kilitlememesi için istemci tarafı güvencesi.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT_180S')), 180_000);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  try {
    const res = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: p.id,
        api_key: p.key,
        model: opts.model || p.model,
        base_url: p.baseUrl || undefined,
        messages,
        code_blocks: codeBlocks,
        // Sağlayıcı düşünme modunu kapatmayı gerektiriyorsa (ör. EVREN/vLLM)
        // bu alan gönderilir; yoksa yanıtlar kesilir (ölçüldü).
        reasoning_effort: p.reasoningEffort || undefined,
        preserve: opts.preserve || undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as AiChatResponse;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

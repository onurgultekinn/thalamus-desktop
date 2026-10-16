/**
 * The single fetch point for AI chat. Provider resolution + the `/api/ai/chat`
 * call are gathered here; the two separate manual fetches in Copilot were removed.
 *
 * Keys are read from the OS keychain via `lib/secrets`; the active provider is
 * selected from the `tlm_active_provider` setting, and if that provider has no
 * key it falls back to the other registered providers.
 */
import { API_BASE } from './ThalamusClient';
import {
  API_PROVIDERS,
  providerEndpoint,
  activeProviderStorageKey,
  baseStorageKey,
  type ApiProvider,
} from '../lib/providers';
import { getStoredKey } from '../lib/secrets';

export interface AiEditResult {
  file: string;
  applied: boolean;
  message: string;
  new_body: string | null;
}

export interface AiChatResponse {
  content: string;
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

  const ordered: ApiProvider[] = [
    ...API_PROVIDERS.filter((p) => p.id === preferred),
    ...API_PROVIDERS.filter((p) => p.id !== preferred && p.family !== 'anthropic'),
  ];

  for (const p of ordered) {
    if (p.family === 'anthropic') continue; // the backend proxy does not speak this format yet
    const key = (await getStoredKey(p.id)).trim();
    // Local endpoints are valid without a key; cloud providers are not.
    if (p.family !== 'local' && !key) continue;
    const customBase = localStorage.getItem(baseStorageKey(p.id)) || undefined;
    return {
      id: p.id,
      name: p.name,
      key,
      baseUrl: providerEndpoint(p, customBase || p.defaultBaseUrl),
      model: p.defaultModel || '',
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
export async function aiChat(
  messages: AiMessage[],
  codeBlocks: CodeBlock[] = [],
  provider?: ActiveProvider | null
): Promise<AiChatResponse> {
  const p = provider ?? (await getActiveProvider());
  if (!p) throw new Error('API_KEY_MISSING');

  const res = await fetch(`${API_BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: p.id,
      api_key: p.key,
      model: p.model,
      base_url: p.baseUrl || undefined,
      messages,
      code_blocks: codeBlocks,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as AiChatResponse;
}

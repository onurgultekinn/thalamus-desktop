/**
 * Single source of truth for supported AI providers.
 *
 * - `openai`    → anything that speaks the OpenAI `chat/completions` format
 *                 (OpenAI, DeepSeek, Gemini, Groq, OpenRouter, self-hosted…).
 * - `anthropic` → Anthropic's `/v1/messages` format (Claude). NOT yet proxied
 *                 by the local backend (OpenAI-compatible only).
 * - `local`     → OpenAI-compatible endpoints that may need no key (Ollama,
 *                 LM Studio, vLLM, llama.cpp, custom servers).
 *
 * Keys live in the OS credential vault (Windows Credential Manager) via the
 * `secret_get/secret_set/secret_delete` Tauri commands; in the browser dev
 * preview they fall back to localStorage as `tlm_key_<id>`. Custom base URLs
 * are remembered as `tlm_base_<id>`.
 */
export type ProviderFamily = 'openai' | 'anthropic' | 'local';

export interface ApiProvider {
  id: string;
  name: string;
  family: ProviderFamily;
  /** Placeholder shown in the key input (also hints the expected prefix). */
  keyPlaceholder: string;
  /** Where to create an API key, if the provider issues one. */
  docsUrl?: string;
  /** Pre-filled/remembered endpoint for providers that allow a custom one. */
  defaultBaseUrl?: string;
  /** Whether the provider's endpoint is user-settable. */
  needsBaseUrl?: boolean;
  /** Fixed OpenAI-compatible endpoint used by the local Rust proxy. */
  apiEndpoint?: string;
  /** Sensible default model for this provider. */
  defaultModel?: string;
  /** Brand identity color, used as the provider's visual mark. */
  color: string;
}

export const API_PROVIDERS: ApiProvider[] = [
  // ── OpenAI-compatible cloud providers ───────────────────────────────
  { id: 'openai',     name: 'OpenAI',        family: 'openai', keyPlaceholder: 'sk-...',            apiEndpoint: 'https://api.openai.com/v1',                defaultModel: 'gpt-4o-mini',            docsUrl: 'https://platform.openai.com/api-keys',     color: '#10a37f' },
  { id: 'deepseek',   name: 'DeepSeek',      family: 'openai', keyPlaceholder: 'sk-...',            apiEndpoint: 'https://api.deepseek.com/v1',              defaultModel: 'deepseek-chat',          docsUrl: 'https://platform.deepseek.com/api_keys',   color: '#4d6bfe' },
  { id: 'google',     name: 'Google Gemini', family: 'openai', keyPlaceholder: 'AIza...',           apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash', docsUrl: 'https://aistudio.google.com/app/apikey', color: '#4285f4' },
  { id: 'xai',        name: 'xAI Grok',      family: 'openai', keyPlaceholder: 'xai-...',           apiEndpoint: 'https://api.x.ai/v1',                      defaultModel: 'grok-2-latest',          docsUrl: 'https://console.x.ai/',                    color: '#A8A49E' },
  { id: 'mistral',    name: 'Mistral',       family: 'openai', keyPlaceholder: '...',               apiEndpoint: 'https://api.mistral.ai/v1',                defaultModel: 'mistral-small-latest',   docsUrl: 'https://console.mistral.ai/api-keys',      color: '#f7a93b' },
  { id: 'groq',       name: 'Groq',          family: 'openai', keyPlaceholder: 'gsk_...',           apiEndpoint: 'https://api.groq.com/openai/v1',           defaultModel: 'llama-3.3-70b-versatile',docsUrl: 'https://console.groq.com/keys',            color: '#f55036' },
  { id: 'openrouter', name: 'OpenRouter',    family: 'openai', keyPlaceholder: 'sk-or-...',         apiEndpoint: 'https://openrouter.ai/api/v1',             defaultModel: 'openai/gpt-4o-mini',     docsUrl: 'https://openrouter.ai/settings/keys',      color: '#8b5cf6' },
  { id: 'together',   name: 'Together AI',   family: 'openai', keyPlaceholder: '...',               apiEndpoint: 'https://api.together.xyz/v1',              defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', docsUrl: 'https://api.together.ai/settings/api-keys', color: '#ea580c' },
  { id: 'fireworks',  name: 'Fireworks AI',  family: 'openai', keyPlaceholder: '...',               apiEndpoint: 'https://api.fireworks.ai/inference/v1',    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', docsUrl: 'https://fireworks.ai/account/api-keys', color: '#f97316' },
  { id: 'perplexity', name: 'Perplexity',    family: 'openai', keyPlaceholder: 'pplx-...',          apiEndpoint: 'https://api.perplexity.ai',                defaultModel: 'sonar',                  docsUrl: 'https://www.perplexity.ai/settings/api',   color: '#20b8cd' },
  { id: 'zhipu',      name: 'Zhipu GLM',     family: 'openai', keyPlaceholder: '...',               apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4',     defaultModel: 'glm-4-flash',            docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys', color: '#4385BE' },
  { id: 'moonshot',   name: 'Moonshot Kimi', family: 'openai', keyPlaceholder: 'sk-...',            apiEndpoint: 'https://api.moonshot.cn/v1',               defaultModel: 'moonshot-v1-8k',         docsUrl: 'https://platform.moonshot.cn/console/api-keys', color: '#6d4cff' },
  { id: 'qwen',       name: 'Qwen (DashScope)', family: 'openai', keyPlaceholder: 'sk-...',         apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus',      docsUrl: 'https://bailian.console.aliyun.com/',       color: '#7c3aed' },
  { id: 'siliconflow', name: 'SiliconFlow',  family: 'openai', keyPlaceholder: 'sk-...',            apiEndpoint: 'https://api.siliconflow.cn/v1',            defaultModel: 'Qwen/Qwen2.5-72B-Instruct', docsUrl: 'https://cloud.siliconflow.cn/account/ak',   color: '#2563eb' },
  { id: 'deepbricks', name: 'DeepBricks',    family: 'openai', keyPlaceholder: 'sk-...',            apiEndpoint: 'https://api.deepbricks.ai/v1',             defaultModel: 'gpt-4o-mini',            docsUrl: 'https://deepbricks.ai/',                    color: '#0891b2' },

  // ── Anthropic format (backend proxy does not speak /v1/messages yet) ──
  { id: 'anthropic',  name: 'Claude (Anthropic)', family: 'anthropic', keyPlaceholder: 'sk-ant-...', docsUrl: 'https://console.anthropic.com/settings/keys', color: '#d97757' },

  // ── Local / self-hosted (no key, user-settable endpoint) ───────────
  { id: 'ollama',    name: 'Ollama',       family: 'local', keyPlaceholder: 'optional', defaultBaseUrl: 'http://localhost:11434/v1', needsBaseUrl: true, defaultModel: 'llama3.1', color: '#D0A215' },
  { id: 'lmstudio',  name: 'LM Studio',    family: 'local', keyPlaceholder: 'optional', defaultBaseUrl: 'http://localhost:1234/v1', needsBaseUrl: true, defaultModel: 'local-model', color: '#a78bfa' },
  { id: 'custom',    name: 'Custom (OpenAI-compatible)', family: 'local', keyPlaceholder: 'optional', defaultBaseUrl: 'http://localhost:8000/v1', needsBaseUrl: true, color: '#A8A49E' },
];

export const keyStorageKey = (id: string) => `tlm_key_${id}`;
export const baseStorageKey = (id: string) => `tlm_base_${id}`;
/** Remembers the "active" provider selected in Settings. */
export const activeProviderStorageKey = 'tlm_active_provider';

/** A provider needs a key typed in unless it's a local endpoint (optional). */
export const providerRequiresKey = (p: ApiProvider) => p.family !== 'local';

/** The provider's endpoint to hand to the proxy (fixed or user-defined). */
export function providerEndpoint(p: ApiProvider, customBase?: string): string {
  if (p.needsBaseUrl && customBase?.trim()) return customBase.trim();
  return p.apiEndpoint || p.defaultBaseUrl || '';
}

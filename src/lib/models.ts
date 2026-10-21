/**
 * Provider-aware model registry.
 *
 * The model actually used for a request lives in `tlm_model_<providerId>` so
 * every provider keeps its own choice (EVREN ids are not valid on OpenAI and
 * vice versa). When nothing is stored we fall back to the provider's own
 * `defaultModel` — never to a global marketing name.
 */
import { API_PROVIDERS, providerEndpoint, baseStorageKey, type ApiProvider } from './providers';
import { localModelsFor } from './localModels';

export interface ModelChoice {
  /** Model id exactly as the provider's API expects it. */
  id: string;
  /** Human label; falls back to the id when omitted. */
  label?: string;
  /**
   * false = bu model `reasoning_effort` parametresini reddeder (ör. EVREN'de
   * gemma-4-31b → HTTP 400). Belirtilmemişse sağlayıcı varsayılanı geçerlidir.
   */
  reasoningEffort?: boolean;
}

/**
 * Suggested ids per provider. This is only the picker's shortlist — the
 * Settings field stays a free-text input so any id the endpoint accepts works.
 */
export const PROVIDER_MODELS: Record<string, ModelChoice[]> = {
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'o4-mini', label: 'o4-mini' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek V3 (chat)' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1 (reasoner)' },
  ],
  google: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  xai: [
    { id: 'grok-2-latest', label: 'Grok 2' },
    { id: 'grok-3-mini', label: 'Grok 3 mini' },
    { id: 'grok-3', label: 'Grok 3' },
  ],
  mistral: [
    { id: 'mistral-small-latest', label: 'Mistral Small' },
    { id: 'mistral-large-latest', label: 'Mistral Large' },
    { id: 'codestral-latest', label: 'Codestral' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
  ],
  evren: [
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (1M)' },
    { id: 'glm-5.3', label: 'GLM 5.3' },
    { id: 'qwen3.8-flash-next', label: 'Qwen 3.8 Flash Next' },
    // Gemma'da `reasoning_effort` yok: gönderilirse istek 400 döner.
    { id: 'gemma-4-31b', label: 'Gemma 4 31B', reasoningEffort: false },
  ],
  openrouter: [
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
  ],
  together: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
    { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B' },
  ],
  perplexity: [
    { id: 'sonar', label: 'Sonar' },
    { id: 'sonar-pro', label: 'Sonar Pro' },
    { id: 'sonar-reasoning', label: 'Sonar Reasoning' },
  ],
  zhipu: [
    { id: 'glm-4-flash', label: 'GLM-4 Flash' },
    { id: 'glm-4-plus', label: 'GLM-4 Plus' },
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', label: 'Kimi 8K' },
    { id: 'moonshot-v1-32k', label: 'Kimi 32K' },
    { id: 'moonshot-v1-128k', label: 'Kimi 128K' },
  ],
  qwen: [
    { id: 'qwen-plus', label: 'Qwen Plus' },
    { id: 'qwen-max', label: 'Qwen Max' },
    { id: 'qwen-turbo', label: 'Qwen Turbo' },
  ],
  siliconflow: [
    { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B' },
    { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
  ],
  deepbricks: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  ],
  ollama: [
    { id: 'llama3.1', label: 'Llama 3.1' },
    { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B' },
    { id: 'deepseek-r1:8b', label: 'DeepSeek R1 8B' },
  ],
  lmstudio: [{ id: 'local-model', label: 'Loaded local model' }],
  custom: [],
};

export const modelStorageKey = (providerId: string) => `tlm_model_${providerId}`;

/** Sağlayıcının gerçekte kullanılacağı taban URL (kullanıcı ayarı → varsayılan). */
export function providerBaseUrl(provider: ApiProvider): string {
  let custom = '';
  try {
    custom = localStorage.getItem(baseStorageKey(provider.id)) || '';
  } catch { /* noop */ }
  return providerEndpoint(provider, custom || provider.defaultBaseUrl);
}

/** The model a provider will be called with (stored override → default). */
export function getProviderModel(providerId: string): string {
  let stored = '';
  try {
    stored = (localStorage.getItem(modelStorageKey(providerId)) || '').trim();
  } catch { /* noop */ }
  if (stored) return stored;
  const provider = API_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return '';
  // Yerel sağlayıcıda, bilgisayarda BULUNAN ilk model statik varsayılandan
  // daha doğrudur (ör. Ollama'da "llama3.1" yerine gerçekten indirilmiş model).
  if (provider.family === 'local') {
    const discovered = localModelsFor(providerId, providerBaseUrl(provider));
    if (discovered.length > 0) return discovered[0];
  }
  return provider.defaultModel || '';
}

/** Persists the choice and lets every listener re-resolve the provider. */
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

/** Picker list for a provider: its default first, then the shortlist. */
export function modelChoices(providerId: string): { id: string; label: string }[] {
  const provider = API_PROVIDERS.find((p) => p.id === providerId);
  const current = getProviderModel(providerId);
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const push = (choice: ModelChoice) => {
    if (!choice.id || seen.has(choice.id)) return;
    seen.add(choice.id);
    out.push({ id: choice.id, label: choice.label || choice.id });
  };
  if (current) push({ id: current, label: modelLabel(providerId, current) });
  // Yerel sağlayıcıda önce BİLGİSAYARDA BULUNAN modeller gelir.
  if (provider?.family === 'local') {
    for (const id of localModelsFor(providerId, providerBaseUrl(provider))) push({ id, label: id });
  }
  if (provider?.defaultModel) push({ id: provider.defaultModel, label: modelLabel(providerId, provider.defaultModel) });
  for (const choice of PROVIDER_MODELS[providerId] || []) push(choice);
  return out;
}

/** Human label for a model id (falls back to the raw id). */
export function modelLabel(providerId: string, modelId: string): string {
  const found = (PROVIDER_MODELS[providerId] || []).find((m) => m.id === modelId);
  return found?.label || modelId;
}

/**
 * Model `reasoning_effort` kabul ediyor mu? Listede açıkça false yoksa
 * sağlayıcı varsayılanı geçerli sayılır (serbest metin model kimlikleri için
 * gereksiz yere parametre düşürmemek adına).
 */
export function supportsReasoningEffort(providerId: string, modelId: string): boolean {
  const found = (PROVIDER_MODELS[providerId] || []).find((m) => m.id === modelId);
  return found?.reasoningEffort !== false;
}

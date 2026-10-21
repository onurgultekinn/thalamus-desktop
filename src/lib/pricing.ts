/**
 * Price list for cost estimates.
 *
 * Prices are keyed by the REAL provider model id (the same string sent to the
 * API), not by marketing names. The built-in table is a small offline
 * reference; when live pricing is enabled the LiteLLM catalogue is fetched
 * once, cached for a day and merged over it. Unknown ids simply have no
 * estimate — the UI shows that instead of inventing a number.
 */
import { useEffect, useState } from 'react';

const LIVE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_KEY = 'tlm_pricing_cache_v2';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Offline reference: input cost in USD / token. Estimates only. */
export const BUILTIN_PRICES: Record<string, number> = {
  'gpt-4o': 2.5e-6,
  'gpt-4o-mini': 0.15e-6,
  'gpt-4.1': 2.0e-6,
  'gpt-4.1-mini': 0.4e-6,
  'o4-mini': 1.1e-6,
  'deepseek-chat': 0.27e-6,
  'deepseek-reasoner': 0.55e-6,
  'gemini-2.0-flash': 0.1e-6,
  'gemini-2.5-flash': 0.3e-6,
  'gemini-2.5-pro': 1.25e-6,
  'grok-2-latest': 2.0e-6,
  'grok-3-mini': 0.3e-6,
  'grok-3': 3.0e-6,
  'mistral-small-latest': 0.2e-6,
  'mistral-large-latest': 2.0e-6,
  'codestral-latest': 0.3e-6,
  'llama-3.3-70b-versatile': 0.59e-6,
  'llama-3.1-8b-instant': 0.05e-6,
  'sonar': 1.0e-6,
  'sonar-pro': 3.0e-6,
  'qwen-plus': 0.4e-6,
  'qwen-max': 1.6e-6,
  'qwen-turbo': 0.05e-6,
  'claude-sonnet-4': 3.0e-6,
  'claude-opus-4': 15.0e-6,
  'moonshot-v1-8k': 1.68e-6,
};

const PREFIXES = [
  'accounts/fireworks/models/',
  'openrouter/',
  'anthropic/',
  'openai/',
  'google/',
  'deepseek/',
  'meta-llama/',
  'mistralai/',
  'moonshotai/',
  'qwen/',
  'together/',
];

/** Canonical key for matching catalogue ids against the provider's id. */
export function normalizeModelId(id: string): string {
  let out = id.trim().toLowerCase().split(':')[0];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PREFIXES) {
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length);
        changed = true;
      }
    }
  }
  return out;
}

/** Input price for a model id, or undefined when no price is known. */
export function priceForModel(
  prices: Record<string, number>,
  modelId?: string
): number | undefined {
  if (!modelId) return undefined;
  const exact = prices[modelId];
  if (typeof exact === 'number') return exact;
  const normalized = normalizeModelId(modelId);
  if (typeof prices[normalized] === 'number') return prices[normalized];
  for (const [id, price] of Object.entries(prices)) {
    if (normalizeModelId(id) === normalized) return price;
  }
  return undefined;
}

interface Cache {
  ts: number;
  prices: Record<string, number>;
}

function readCache(): Cache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Cache | null;
    if (!raw || typeof raw.ts !== 'number' || !raw.prices) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Built-in table, optionally merged with a fresh-enough cache. */
export function loadPriceMap(live: boolean): Record<string, number> {
  if (!live) return BUILTIN_PRICES;
  const cache = readCache();
  if (!cache) return BUILTIN_PRICES;
  return { ...BUILTIN_PRICES, ...cache.prices };
}

/** Fetches the LiteLLM catalogue and caches it (one network call per day). */
export async function fetchLivePrices(): Promise<Record<string, number>> {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { input_cost_per_token?: unknown }>;
  const prices: Record<string, number> = {};
  for (const [id, info] of Object.entries(data)) {
    const cost = info?.input_cost_per_token;
    if (typeof cost === 'number' && Number.isFinite(cost)) prices[id] = cost;
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), prices } satisfies Cache));
  } catch { /* storage full — the in-memory map still works */ }
  return { ...BUILTIN_PRICES, ...prices };
}

/** React binding: built-in table instantly, live catalogue when enabled. */
export function usePriceMap(live: boolean): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>(() => loadPriceMap(live));

  useEffect(() => {
    let cancelled = false;
    setPrices(loadPriceMap(live));
    if (!live) return;
    const cache = readCache();
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return;
    void fetchLivePrices()
      .then((next) => {
        if (!cancelled) setPrices(next);
      })
      .catch(() => { /* offline: built-in table stays in use */ });
    return () => { cancelled = true; };
  }, [live]);

  return prices;
}

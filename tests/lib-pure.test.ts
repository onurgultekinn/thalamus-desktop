import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/lib/format';
import { normalizeModelId, priceForModel } from '../src/lib/pricing';
import { PLANS, resolvePlan, visiblePlanLabel } from '../src/lib/plan';
import { policyDirective, policyFromSettings } from '../src/lib/intentPolicy';
import { editorExcerpt } from '../src/lib/nucleusPolicy';
import { contentHash } from '../src/lib/contextPlan';

describe('estimateTokens', () => {
  it('rounds up and never returns 0', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(1);
  });

  it('counts Turkish characters as characters, not bytes', () => {
    expect(estimateTokens('ğüşiöçİ')).toBe(2);
  });
});

describe('normalizeModelId', () => {
  it('strips known provider prefixes', () => {
    expect(normalizeModelId('openrouter/openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelId('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('drops a tag suffix and lowercases', () => {
    expect(normalizeModelId('Llama-3.1-8B:free')).toBe('llama-3.1-8b');
  });

  it('leaves an already-canonical id alone', () => {
    expect(normalizeModelId('gpt-4o-mini')).toBe('gpt-4o-mini');
  });
});

describe('priceForModel', () => {
  const prices = { 'gpt-4o': 2.5e-6, 'claude-sonnet-4': 3e-6 };

  it('finds an exact match', () => {
    expect(priceForModel(prices, 'gpt-4o')).toBe(2.5e-6);
  });

  it('finds a match through a provider prefix', () => {
    expect(priceForModel(prices, 'openrouter/openai/gpt-4o')).toBe(2.5e-6);
  });

  it('returns undefined rather than inventing a price', () => {
    expect(priceForModel(prices, 'unknown-model')).toBeUndefined();
    expect(priceForModel(prices, undefined)).toBeUndefined();
  });
});

describe('resolvePlan / visiblePlanLabel', () => {
  it('falls back to the free plan for unknown values', () => {
    expect(resolvePlan('gold')).toBe(PLANS.free);
    expect(resolvePlan(null)).toBe(PLANS.free);
    expect(resolvePlan(undefined)).toBe(PLANS.free);
  });

  it('resolves a registered plan', () => {
    expect(resolvePlan('pro')).toBe(PLANS.pro);
  });

  it('hides the plan row while the feature is off', () => {
    expect(visiblePlanLabel({ plan: 'pro' } as never)).toBeNull();
  });
});

describe('intentPolicy', () => {
  it('is cost-friendly by default', () => {
    const p = policyFromSettings('auto', false);
    expect(p).toEqual({ detailed: false, fullFile: false, preserve: false, terse: false });
    expect(policyDirective(p)).toBeNull();
  });

  it('maps the detailed style to a directive', () => {
    const p = policyFromSettings('detailed', false);
    expect(p.detailed).toBe(true);
    expect(policyDirective(p)).toContain('DETAILED');
  });

  it('maps the terse style to a directive', () => {
    expect(policyDirective(policyFromSettings('terse', false))).toContain('CONCISE');
  });

  it('only disables compression via the raw-context setting', () => {
    expect(policyFromSettings('auto', true).preserve).toBe(true);
    expect(policyDirective(policyFromSettings('auto', true))).toContain('RAW context');
  });
});

describe('editorExcerpt', () => {
  const code = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');

  it('includes the selected line and reports its 1-based number', () => {
    const at = code.indexOf('line 100');
    const { text, line } = editorExcerpt(code, at, at + 8);
    expect(line).toBe(100);
    expect(text).toContain('100: line 100');
  });

  it('clamps out-of-range offsets without throwing', () => {
    const { line } = editorExcerpt(code, -50, 10_000_000);
    expect(line).toBeGreaterThanOrEqual(1);
  });

  it('truncates to the excerpt character limit', () => {
    const { text } = editorExcerpt(code, 0, code.length);
    expect(text.length).toBeLessThanOrEqual(12000);
  });
});

describe('contentHash', () => {
  it('is deterministic and 8 hex chars', () => {
    const h = contentHash('merhaba dünya');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash('merhaba dünya')).toBe(h);
  });

  it('differs for different content', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  it('handles the empty string', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

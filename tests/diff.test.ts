import { describe, expect, it } from 'vitest';
import { computeLineDiff, diffStats } from '../src/lib/diff';

describe('computeLineDiff', () => {
  it('returns only "same" lines for identical input', () => {
    const out = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(out.every((l) => l.type === 'same')).toBe(true);
    expect(out.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('marks a modified line as removed + added', () => {
    const out = computeLineDiff('const x = 1;', 'const x = 2;');
    expect(out).toEqual([
      { type: 'removed', text: 'const x = 1;' },
      { type: 'added', text: 'const x = 2;' },
    ]);
  });

  it('detects an appended line without touching the rest', () => {
    const out = computeLineDiff('a\nb', 'a\nb\nc');
    expect(out.slice(0, 2)).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
    expect(out[2]).toEqual({ type: 'added', text: 'c' });
  });

  it('handles an empty original (whole file added)', () => {
    const out = computeLineDiff('', 'x\ny');
    // '' tek boş satır sayılır: 1 removed, 2 added.
    expect(diffStats(out)).toEqual({ added: 2, removed: 1, changed: 3 });
  });

  it('keeps line order and preserves whitespace', () => {
    const out = computeLineDiff('  indented\nplain', '  indented\nplain');
    expect(out.map((l) => l.text)).toEqual(['  indented', 'plain']);
  });

  it('does not corrupt Turkish characters', () => {
    const out = computeLineDiff('değer = "ığüşöç"', 'değer = "ığüşöçİ"');
    expect(out[0]).toEqual({ type: 'removed', text: 'değer = "ığüşöç"' });
    expect(out[1]).toEqual({ type: 'added', text: 'değer = "ığüşöçİ"' });
  });

  it('reports zero stats when nothing changed', () => {
    expect(diffStats(computeLineDiff('a\nb', 'a\nb'))).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
    });
  });
});

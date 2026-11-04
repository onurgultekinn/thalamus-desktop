import { describe, expect, it } from 'vitest';
import {
  applyFileEdits,
  applySearchReplace,
  extractEdits,
  extractFindings,
  extractPlanSteps,
  extractReport,
  groupEditsByFile,
} from '../src/lib/agentEdits';

describe('applySearchReplace', () => {
  it('replaces an exact block and keeps the rest intact', () => {
    const code = 'const a = 1;\nconst b = 2;\n';
    const r = applySearchReplace(code, 'const b = 2;', 'const b = 3;');
    expect(r.ok).toBe(true);
    expect(r.code).toBe('const a = 1;\nconst b = 3;\n');
  });

  it('tolerates CRLF files and writes back the original EOL', () => {
    const code = 'one\r\ntwo\r\n';
    const r = applySearchReplace(code, 'two', 'TWO');
    expect(r.ok).toBe(true);
    expect(r.code).toBe('one\r\nTWO\r\n');
  });

  it('falls back to trimmed line matching', () => {
    const code = '  if (x) {\n    return 1;\n  }\n';
    const r = applySearchReplace(code, 'if (x) {\nreturn 1;\n}', 'if (x) {\nreturn 2;\n}');
    expect(r.ok).toBe(true);
    expect(r.code).toContain('return 2;');
    expect(r.code).not.toContain('return 1;');
  });

  it('reports a miss instead of silently skipping', () => {
    const r = applySearchReplace('a\nb\n', 'nope', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('search-not-found');
    expect(r.code).toBe('a\nb\n');
  });

  it('rejects an empty search block', () => {
    expect(applySearchReplace('a', '   \n', 'x').error).toBe('empty-search');
  });
});

describe('applyFileEdits', () => {
  it('applies edits sequentially and counts them', () => {
    const edits = [
      { task: 't1', file: 'a.ts', op: 'replace' as const, search: 'one', body: 'ONE', from: '' },
      { task: 't1', file: 'a.ts', op: 'replace' as const, search: 'two', body: 'TWO', from: '' },
    ];
    const r = applyFileEdits('one two', edits);
    expect(r.applied).toBe(2);
    expect(r.code).toBe('ONE TWO');
    expect(r.errors).toEqual([]);
  });

  it('does not overwrite an existing file on create', () => {
    const r = applyFileEdits('existing', [
      { task: 't1', file: 'a.ts', op: 'create', search: '', body: 'new', from: '' },
    ]);
    expect(r.applied).toBe(0);
    expect(r.code).toBe('existing');
    expect(r.errors.length).toBe(1);
  });

  it('keeps going after a failed edit and reports it', () => {
    const r = applyFileEdits('one two', [
      { task: 't1', file: 'a.ts', op: 'replace', search: 'missing', body: 'x', from: '' },
      { task: 't1', file: 'a.ts', op: 'replace', search: 'two', body: 'TWO', from: '' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.code).toBe('one TWO');
    expect(r.errors[0]).toContain('search-not-found');
  });
});

describe('message extraction', () => {
  const messages = [
    {
      kind: 'plan',
      from: 'lead',
      raw: { payload: [{ id: 't1', title: 'Add timeout', files: 'src/a.ts|src/b.ts', deps: '', est: 120, risk: 'low' }] },
    },
    {
      kind: 'result',
      from: 'api',
      raw: {
        payload: [
          { task: 't1', file: 'src/a.ts', op: 'replace', search: 'x', body: 'y' },
          { task: 't1', file: 'src/new.ts', body: 'created' },
        ],
      },
    },
    {
      kind: 'review',
      from: 'qa',
      raw: { payload: [{ severity: 'error', code: 'E1', message: 'bad', file: 'src/a.ts' }] },
    },
    {
      kind: 'report',
      raw: { payload: [{ metric: 'verdict', value: 'pass' }] },
    },
  ];

  it('extracts only applyable edits from result envelopes', () => {
    const edits = extractEdits(messages);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ file: 'src/a.ts', op: 'replace' });
    expect(edits[1]).toMatchObject({ file: 'src/new.ts', op: 'create' });
  });

  it('groups edits per file', () => {
    const grouped = groupEditsByFile(extractEdits(messages));
    expect(grouped.get('src/a.ts')).toHaveLength(1);
    expect(grouped.size).toBe(2);
  });

  it('extracts findings and report metrics', () => {
    expect(extractFindings(messages)[0]).toMatchObject({ severity: 'error', code: 'E1' });
    expect(extractReport(messages)[0]).toEqual({ metric: 'verdict', value: 'pass' });
  });

  it('carries the producing agent on edits and findings', () => {
    const edits = extractEdits(messages);
    expect(edits.every((e) => e.from === 'api')).toBe(true);
    expect(extractFindings(messages)[0].from).toBe('qa');
  });

  it('extracts readable plan steps with their author', () => {
    const steps = extractPlanSteps(messages);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: 't1',
      title: 'Add timeout',
      files: 'src/a.ts|src/b.ts',
      risk: 'low',
      est: 120,
      from: 'lead',
    });
  });

  it('ignores malformed plan payloads', () => {
    const bad = [
      { kind: 'plan', from: 'x', raw: null },
      { kind: 'plan', from: 'x', raw: { payload: 'no' } },
      { kind: 'plan', from: 'x', raw: { payload: [{ files: 'a.ts' }] } },
    ];
    expect(extractPlanSteps(bad)).toEqual([]);
  });

  it('ignores malformed envelopes', () => {
    const bad = [{ kind: 'result', raw: null }, { kind: 'result', raw: { payload: 'x' } }];
    expect(extractEdits(bad)).toEqual([]);
    expect(extractFindings(bad)).toEqual([]);
    expect(extractReport(bad)).toEqual([]);
  });
});

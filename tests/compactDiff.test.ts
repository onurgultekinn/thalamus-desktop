import { describe, expect, it } from 'vitest';
import { expandCompactDiff } from '../src/lib/compactDiff';

describe('expandCompactDiff', () => {
  it('expands a compact hunk header and file line', () => {
    const input = '```diff\nF src/foo.ts\n@42 42\n-old\n+new\n```';
    const out = expandCompactDiff(input);
    expect(out).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(out).toContain('--- a/src/foo.ts');
    expect(out).toContain('+++ b/src/foo.ts');
    expect(out).toContain('@@ -42 +42 @@');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
  });

  it('supports count ranges in the hunk header', () => {
    const input = '```diff\nF a.txt\n@10,3 10,4\n+x\n```';
    expect(expandCompactDiff(input)).toContain('@@ -10,3 +10,4 @@');
  });

  it('leaves a standard git diff untouched', () => {
    const input = '```diff\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n```';
    expect(expandCompactDiff(input)).toBe(input);
  });

  it('leaves prose and non-diff fences untouched', () => {
    const input = 'text\n```json\n{"a":1}\n```\nmore';
    expect(expandCompactDiff(input)).toBe(input);
  });

  it('handles CRLF line endings inside the fence', () => {
    const input = '```diff\r\nF x.ts\r\n@1 1\r\n-a\r\n+b\r\n```';
    const out = expandCompactDiff(input);
    expect(out).toContain('diff --git a/x.ts b/x.ts');
    expect(out).toContain('@@ -1 +1 @@');
  });

  it('preserves code containing @ or F outside line starts', () => {
    const input = '```diff\nF f.ts\n@1 1\n+const email = "a@b.c";\n```';
    const out = expandCompactDiff(input);
    expect(out).toContain('+const email = "a@b.c";');
  });

  it('keeps surrounding text when there are multiple fences', () => {
    const input =
      'before\n```diff\nF a.ts\n@1 1\n-x\n```\nmiddle\n```diff\nF b.ts\n@2 2\n-y\n```\nafter';
    const out = expandCompactDiff(input);
    expect(out).toContain('before');
    expect(out).toContain('middle');
    expect(out).toContain('after');
    expect(out).toContain('a/a.ts');
    expect(out).toContain('b/b.ts');
  });
});

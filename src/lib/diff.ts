/**
 * Satır tabanlı LCS diff — zorunlu sıralı eşleme (endeks artan eleme).
 * Yardımcı: ThalamusCopilot Diff Modal'ının uydurma olmayan gerçek
 * satır eklenmiş/çıkarılmış hesabından sorumludur.
 */

export type DiffLineType = 'same' | 'removed' | 'added';
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Uzunluk matrisi yerine iki işaretçili saf LCS — endeks elemana göre. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export function computeLineDiff(original: string, proposed: string): DiffLine[] {
  const a = original.split('\n');
  const b = proposed.split('\n');
  const dp = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) { out.push({ type: 'removed', text: a[i] }); i++; }
  while (j < b.length) { out.push({ type: 'added', text: b[j] }); j++; }
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.type === 'added') added++;
    else if (l.type === 'removed') removed++;
  }
  return { added, removed, changed: added + removed };
}

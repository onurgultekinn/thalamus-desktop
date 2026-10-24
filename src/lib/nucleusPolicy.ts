export const NUCLEUS_LIMITS = {
  excerptRadiusLines: 46,
  excerptChars: 12000,
  selectionChars: 12000,
  transcriptMessages: 24,
  transcriptChars: 14000,
  historyTurns: 8,
  pageSelectionChars: 2000,
  localActionCloseDelayMs: 220,
  actionCloseDelayMs: 900,
} as const;

export function editorExcerpt(code: string, start: number, end: number): { text: string; line: number } {
  const safeStart = Math.max(0, Math.min(start, code.length));
  const safeEnd = Math.max(safeStart, Math.min(end, code.length));
  const lines = code.split('\n');
  const startLine = code.slice(0, safeStart).split('\n').length;
  const endLine = code.slice(0, safeEnd).split('\n').length;
  const from = Math.max(0, startLine - NUCLEUS_LIMITS.excerptRadiusLines - 1);
  const to = Math.min(lines.length, endLine + NUCLEUS_LIMITS.excerptRadiusLines);
  const text = lines
    .slice(from, to)
    .map((line, index) => `${from + index + 1}: ${line}`)
    .join('\n')
    .slice(0, NUCLEUS_LIMITS.excerptChars);
  return { text, line: startLine };
}

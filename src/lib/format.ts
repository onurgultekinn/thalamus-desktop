// Shared formatting helpers

/** Timestamp in "HH:MM" format (common format for messages). */
export const ts = (): string =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Rough estimate: ~4 characters ≈ 1 token (fast path when tiktoken is unavailable). */
export const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

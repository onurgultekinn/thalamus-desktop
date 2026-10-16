/**
 * Single error translator: every user-visible failure goes through this so the
 * UI speaks in one voice — a stable error CODE, a short title, a plain-language
 * explanation, and the raw technical payload kept out of the way (dim detail
 * line / tooltip).
 *
 * ## Error code registry (stable — wiki-ready)
 * Codes are stable identifiers never reassigned. New failures get the next
 * free number; the table below doubles as the seed for the support wiki.
 *
 * | Code  | Meaning (wiki page title)                                  |
 * |-------|------------------------------------------------------------|
 * | TL-000| Unknown / unmapped error                                    |
 * | TL-001| Request stopped by the user                                 |
 * | TL-002| Client timeout (180 s, no provider response)                |
 * | TL-003| No API key configured (Settings → Providers)                |
 * | TL-010| HTTP 401 — provider rejected the API key                    |
 * | TL-011| HTTP 402/403 — billing / access denied by provider          |
 * | TL-012| HTTP 404 — model or endpoint not found                      |
 * | TL-013| HTTP 429 — rate / usage limit                               |
 * | TL-014| HTTP 5xx — provider server error                            |
 * | TL-015| HTTP other 4xx — unexpected provider response               |
 * | TL-020| Local engine / backend unreachable (network layer)          |
 * | TL-021| LocalStorage quota exceeded (chat history could not save)   |
 * | TL-030| Workspace root rejected by backend (invalid folder)         |
 */

export interface ExplainedError {
  /** Stable code, e.g. `TL-010`. Never reassigned; documented in this header. */
  code: string;
  /** Short heading shown in the toast title (3-5 words). */
  title: string;
  /** Human explanation: what happened + what the user can do about it. */
  explanation: string;
  /** Raw technical string (status, provider message). Dim detail line/tip. */
  detail?: string;
}

const trimDetail = (s: string, max = 220): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

export function explainError(err: unknown, context?: string): ExplainedError {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');

  // User pressed Stop — no alarm tone.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      code: 'TL-001',
      title: context ? `Stopped — ${context}` : 'Request stopped',
      explanation: 'You stopped the request. Partial state only applies if the UI says so.',
      detail: undefined,
    };
  }
  if (typeof raw === 'string' && raw.includes('TIMEOUT')) {
    return {
      code: 'TL-002',
      title: 'Request timed out',
      explanation: 'No answer arrived within 180 s. The provider may be slow or overloaded — try again, or switch providers in Settings → Providers.',
      detail: trimDetail(raw),
    };
  }
  if (raw === 'API_KEY_MISSING') {
    return {
      code: 'TL-003',
      title: 'No API key configured',
      explanation: 'Add a provider key in Settings → Providers; chat answers, vision and summarization need it.',
    };
  }

  // HTTP status codes cover most provider failures.
  const http = raw.match(/^HTTP (\d{3})\b([\s\S]*)$/);
  if (http) {
    const status = Number(http[1]);
    const body = trimDetail(http[2]);
    if (status === 401) {
      return {
        code: 'TL-010',
        title: 'API key rejected',
        explanation: 'The provider rejected the API key. Check or re-enter it in Settings → Providers.',
        detail: body,
      };
    }
    if (status === 402 || status === 403) {
      return {
        code: 'TL-011',
        title: 'Access / billing problem',
        explanation: 'The provider denied the call — usually an empty balance, an expired plan or key restrictions on the provider dashboard.',
        detail: body,
      };
    }
    if (status === 404) {
      return {
        code: 'TL-012',
        title: 'Model or endpoint not found',
        explanation: 'The provider could not find the model or endpoint used. If a custom Base URL is set in Settings → Providers, verify it (e.g. wrong path / wrong model name).',
        detail: body,
      };
    }
    if (status === 429) {
      return {
        code: 'TL-013',
        title: 'Too many requests',
        explanation: 'The provider hit a rate or usage limit. Wait a moment and try again.',
        detail: body,
      };
    }
    if (status >= 500) {
      return {
        code: 'TL-014',
        title: 'Provider error',
        explanation: `The provider is temporarily unavailable (HTTP ${status}). It is usually a temporary server-side issue — try again in a moment.`,
        detail: body,
      };
    }
    return {
      code: 'TL-015',
      title: `Request failed (HTTP ${status})`,
      explanation: 'The provider answered with an unexpected error.',
      detail: body,
    };
  }

  // Local engine / network layer.
  const networkLike = /fetch failed|NetworkError|Failed to fetch|ECONNREFUSED|ERR_CONNECTION/i;
  if (networkLike.test(raw) || raw.includes('down empty')) {
    return {
      code: 'TL-020',
      title: 'The local engine is unreachable',
      explanation: 'The chat could not reach the local backend (127.0.0.1:8277). Restart the application via thalamus_baslat.bat, or check that the backend runs.',
      detail: trimDetail(raw),
    };
  }

  return {
    code: 'TL-000',
    title: context ? `${context} failed` : 'Operation failed',
    explanation: 'This operation failed unexpectedly. If it keeps happening, check Settings → Providers (key / Base URL) and try a different provider.',
    detail: trimDetail(raw),
  };
}

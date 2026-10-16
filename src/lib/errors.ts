/**
 * Single error translator: every user-visible failure goes through this so the
 * UI speaks in one voice â€” a stable error CODE, a short title, a plain-language
 * explanation, and the raw technical payload kept out of the way (dim detail
 * line / tooltip).
 *
 * ## Error code registry (stable â€” wiki-ready)
 * Codes follow standard HTTP status semantics so every developer/user already
 * knows them. Local (non-network) conditions reuse the closest HTTP meaning;
 * the table below doubles as the seed for the support wiki. A code is never
 * reassigned to a different condition.
 *
 * | Code  | Name                        | Condition                                   |
 * |-------|-----------------------------|---------------------------------------------|
 * | 499   | Client Closed Request       | user pressed Stop (nginx convention)        |
 * | 408   | Request Timeout             | client-side 180 s timeout, no response      |
 * | 401   | Unauthorized                | no API key set, OR provider rejected the key|
 * | 402   | Payment Required            | provider billing / balance failure          |
 * | 403   | Forbidden                   | provider access denied (plan/key scope)     |
 * | 404   | Not Found                   | model or endpoint unknown to provider       |
 * | 429   | Too Many Requests           | provider rate / usage limit                 |
 * | 5xx   | Provider Server Error       | passthrough of provider's own 500/502/...   |
 * | 503   | Service Unavailable         | local engine unreachable (network layer)    |
 * | 507   | Insufficient Storage        | localStorage quota exceeded                 |
 * | 500   | Internal Error              | unexpected / unmapped failure               |
 */

export interface ExplainedError {
  /** Stable HTTP-style code, e.g. `429`. Never reassigned; documented above. */
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

  // User pressed Stop â€” no alarm tone.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      code: '499',
      title: context ? `Stopped â€” ${context}` : 'Request stopped',
      explanation: 'You stopped the request. Partial state only applies if the UI says so.',
      detail: undefined,
    };
  }
  if (typeof raw === 'string' && raw.includes('TIMEOUT')) {
    return {
      code: '408',
      title: 'Request timed out',
      explanation: 'No answer arrived within 180 s. The provider may be slow or overloaded â€” try again, or switch providers in Settings â†’ Providers.',
      detail: trimDetail(raw),
    };
  }
  if (raw === 'API_KEY_MISSING') {
    return {
      code: '401',
      title: 'No API key configured',
      explanation: 'Add a provider key in Settings â†’ Providers; chat answers, vision and summarization need it.',
    };
  }

  // HTTP status codes cover most provider failures.
  const http = raw.match(/^HTTP (\d{3})\b([\s\S]*)$/);
  if (http) {
    const status = Number(http[1]);
    const body = trimDetail(http[2]);
    if (status === 401) {
      return {
        code: '401',
        title: 'API key rejected',
        explanation: 'The provider rejected the API key. Check or re-enter it in Settings â†’ Providers.',
        detail: body,
      };
    }
    if (status === 402 || status === 403) {
      return {
        code: (String(status)),
        title: 'Access / billing problem',
        explanation: 'The provider denied the call â€” usually an empty balance, an expired plan or key restrictions on the provider dashboard.',
        detail: body,
      };
    }
    if (status === 404) {
      return {
        code: '404',
        title: 'Model or endpoint not found',
        explanation: 'The provider could not find the model or endpoint used. If a custom Base URL is set in Settings â†’ Providers, verify it (e.g. wrong path / wrong model name).',
        detail: body,
      };
    }
    if (status === 429) {
      return {
        code: '429',
        title: 'Too many requests',
        explanation: 'The provider hit a rate or usage limit. Wait a moment and try again.',
        detail: body,
      };
    }
    if (status >= 500) {
      return {
        code: (String(status)),
        title: 'Provider error',
        explanation: `The provider is temporarily unavailable (HTTP ${status}). It is usually a temporary server-side issue â€” try again in a moment.`,
        detail: body,
      };
    }
    return {
      code: (String(status)),
      title: `Request failed (HTTP ${status})`,
      explanation: 'The provider answered with an unexpected error.',
      detail: body,
    };
  }

  // Local engine / network layer.
  const networkLike = /fetch failed|NetworkError|Failed to fetch|ECONNREFUSED|ERR_CONNECTION/i;
  if (networkLike.test(raw) || raw.includes('down empty')) {
    return {
      code: '503',
      title: 'The local engine is unreachable',
      explanation: 'The chat could not reach the local backend (127.0.0.1:8277). Restart the application via thalamus_baslat.bat, or check that the backend runs.',
      detail: trimDetail(raw),
    };
  }

  return {
    code: '500',
    title: context ? `${context} failed` : 'Operation failed',
    explanation: 'This operation failed unexpectedly. If it keeps happening, check Settings â†’ Providers (key / Base URL) and try a different provider.',
    detail: trimDetail(raw),
  };
}

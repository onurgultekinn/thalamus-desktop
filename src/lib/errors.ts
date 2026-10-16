/**
 * Single error translator: every user-visible failure goes through this so the
 * UI speaks in one voice - a stable error CODE, a short title, a plain-language
 * explanation, and the raw technical payload kept out of the way (dim detail
 * line / tooltip).
 *
 * ## Error code registry (stable - wiki-ready)
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
 * | 415   | Unsupported Media Type      | file is not valid UTF-8 text (binary/other) |
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
  /** Clean technical line (status + provider short message). No JSON dump. */
  detail?: string;
}

const trimDetail = (s: string, max = 200): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Pulls the provider's short error message out of the HTTP payload. Bodies
 * arrive as `401 Unauthorized: { "message": "Incorrect API key ..." , ... }`
 * or SSE/proxy fragments. We prefer the clean `"message"` value and hide the
 * JSON envelope from the user.
 */
function providerShortMessage(body: string): string | undefined {
  const m = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m && m[1]) {
    // Unescape the JSON string bounds we captured.
    let msg = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    msg = trimDetail(msg);
    if (msg) return msg;
  }
  return undefined;
}

export function explainError(err: unknown, context?: string): ExplainedError {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');

  // User pressed Stop - no alarm tone.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      code: '499',
      title: context ? `Stopped - ${context}` : 'Request stopped',
      explanation: 'You stopped the request. Partial output is kept only where the UI says so.',
    };
  }
  if (typeof raw === 'string' && raw.includes('TIMEOUT')) {
    return {
      code: '408',
      title: 'Request timed out',
      explanation: 'No answer arrived within 180 s. The provider may be slow or overloaded. Try again, or switch providers in Settings > Providers.',
      detail: trimDetail(raw),
    };
  }
  if (raw === 'API_KEY_MISSING') {
    return {
      code: '401',
      title: 'No API key configured',
      explanation: 'Add a provider key in Settings > Providers; chat answers, vision and summarization need it.',
    };
  }

  // HTTP status codes cover most provider failures.
  const http = raw.match(/^HTTP (\d{3})\b([\s\S]*)$/);
  if (http) {
    const status = Number(http[1]);
    const bodyText = http[2];
    const short = providerShortMessage(bodyText);

    // Providers often wrap a 401 inside a 502/500 proxy response. If the body
    // clearly identifies an auth problem, label the TRUE cause, not the shell.
    const bodySaysAuth = /incorrect\s+api\s+key|invalid\s+api\s+key|invalid_request_error|invalid_api_key|authentication/i.test(bodyText);
    const effectiveStatus = status >= 500 && bodySaysAuth ? 401 : status;

    if (effectiveStatus === 401) {
      return {
        code: '401',
        title: 'API key rejected',
        explanation: 'The provider rejected your API key. Open Settings > Providers and re-enter a valid key for this model.',
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 402 || effectiveStatus === 403) {
      return {
        code: String(effectiveStatus),
        title: 'Access / billing problem',
        explanation: 'The provider denied the call - usually an empty balance, an expired plan or key restrictions on the provider dashboard.',
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 404) {
      return {
        code: '404',
        title: 'Model or endpoint not found',
        explanation: 'The provider could not find the model or endpoint used. If a custom Base URL is set in Settings > Providers, verify it (wrong path or wrong model name).',
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 429) {
      return {
        code: '429',
        title: 'Too many requests',
        explanation: 'The provider hit a rate or usage limit. Wait a moment and try again.',
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus >= 500) {
      return {
        code: String(status),
        title: 'Provider error',
        explanation: 'The provider itself failed mid-answer. It is usually a temporary server-side issue - try again in a moment.',
        detail: short ?? trimDetail(bodyText),
      };
    }
    return {
      code: String(status),
      title: `Request failed (HTTP ${status})`,
      explanation: 'The provider answered with an unexpected error.',
      detail: short ?? trimDetail(bodyText),
    };
  }

  // Local engine / network layer.
  const networkLike = /fetch failed|NetworkError|Failed to fetch|ECONNREFUSED|ERR_CONNECTION/i;
  if (networkLike.test(raw) || raw.includes('down empty')) {
    return {
      code: '503',
      title: 'The local engine is unreachable',
      explanation: 'The chat could not reach the local backend (127.0.0.1:8277). Restart the application via thalamus_baslat.bat.',
      detail: trimDetail(raw),
    };
  }

  // Text file that is not UTF-8 (binary, image, legacy encoding).
  if (/valid utf-?8|utf-?8|did not contain valid/i.test(raw)) {
    return {
      code: '415',
      title: 'Not a text file',
      explanation: 'This file is not valid UTF-8 text — it may be binary, an image or a legacy encoding. Open it with an external editor.',
      detail: trimDetail(raw),
    };
  }

  // Filesystem contexts get filesystem advice, not provider advice.
  const fsContext = context ? /file|create|move|rename|delete|save|workspace|read/i.test(context) : false;
  return {
    code: '500',
    title: context ? `${context} failed` : 'Operation failed',
    explanation: fsContext
      ? 'This operation failed unexpectedly. Check that the file is not open in another program and that you have permission, then try again.'
      : 'This operation failed unexpectedly. If it keeps happening, check Settings > Providers (key / Base URL) and try a different provider.',
    detail: trimDetail(raw),
  };
}

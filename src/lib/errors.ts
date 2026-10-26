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
 * | 413   | Payload Too Large           | agent read too much in one round            |
 * | 508   | Loop Detected               | agent hit the tool-round limit              |
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

/**
 * Reference doc for the error-code registry (ERRORS.md at the repo root).
 * Every `wiki > <code>` link in the UI opens this page; the table lists all
 * codes in one place, and codes never change meaning between releases.
 */
export const WIKI_BASE_URL =
  'https://github.com/onurgultekinn/thalamus-desktop/blob/master/ERRORS.md';

/** Link target for an error code, or null while the reference doc is absent. */
export function wikiUrlFor(_code: string): string | null {
  return WIKI_BASE_URL || null;
}

/**
 * Explanations are written as "what happened. What to do.". The first sentence
 * usually restates the toast/chat TITLE, so the UI drops it and keeps only the
 * actionable part. If there is no second sentence, the whole text is returned
 * as `rest` so no information is lost.
 */
export function splitExplanation(message?: string): { cause?: string; rest?: string } {
  if (!message) return {};
  const parts = message.split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return { cause: message };
  return { cause: parts[0], rest: parts.slice(1).join(' ') };
}

import { t, type TranslationKey } from './i18n';

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

/** Known context names → translated label key (titles embed the context). */
const CTX_KEY: Record<string, TranslationKey> = {
  'Save': 'err.ctx.save',
  'Workspace': 'err.ctx.workspace',
  'Assistant request': 'err.ctx.assistant',
  'Create': 'err.ctx.create',
  'Delete': 'err.ctx.delete',
  'File read': 'err.ctx.fileRead',
  'Move': 'err.ctx.move',
  'Rename': 'err.ctx.rename',
  'Vision request': 'err.ctx.vision',
  'Project open': 'err.ctx.projectOpen',
};
const ctxLabel = (c: string) => (CTX_KEY[c] ? t(CTX_KEY[c]) : c);

export function explainError(err: unknown, context?: string): ExplainedError {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');

  // User pressed Stop - no alarm tone.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      code: '499',
      title: context ? t('err.stoppedTitleCtx', { ctx: ctxLabel(context) }) : t('err.stoppedTitle'),
      explanation: t('err.stoppedMsg'),
    };
  }
  if (typeof raw === 'string' && raw.includes('TIMEOUT')) {
    return {
      code: '408',
      title: t('err.timeoutTitle'),
      explanation: t('err.timeoutMsg'),
      detail: trimDetail(raw),
    };
  }
  if (raw === 'API_KEY_MISSING') {
    return {
      code: '401',
      title: t('err.noKeyTitle'),
      explanation: t('err.noKeyMsg'),
    };
  }

  // Provider preset unknown and no custom base URL: a configuration problem,
  // not a server fault.
  if (/^unknown provider /i.test(raw) || /provide a base url|no base_url/i.test(raw)) {
    return {
      code: '400',
      title: t('err.providerConfigTitle'),
      explanation: t('err.providerConfigMsg'),
      detail: trimDetail(raw),
    };
  }

  // A tool rejected a path outside the workspace sandbox. Security-relevant,
  // so it gets its own message rather than the generic failure text.
  if (/access outside the workspace root/i.test(raw)) {
    return {
      code: '403',
      title: t('err.sandboxTitle'),
      explanation: t('err.sandboxMsg'),
      detail: trimDetail(raw),
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
        title: t('err.keyRejectedTitle'),
        explanation: t('err.keyRejectedMsg'),
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 402 || effectiveStatus === 403) {
      return {
        code: String(effectiveStatus),
        title: t('err.accessTitle'),
        explanation: t('err.accessMsg'),
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 404) {
      return {
        code: '404',
        title: t('err.notFoundTitle'),
        explanation: t('err.notFoundMsg'),
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus === 429) {
      return {
        code: '429',
        title: t('err.rateTitle'),
        explanation: t('err.rateMsg'),
        detail: short ?? trimDetail(bodyText),
      };
    }
    if (effectiveStatus >= 500) {
      return {
        code: String(status),
        title: t('err.providerTitle'),
        explanation: t('err.providerMsg'),
        detail: short ?? trimDetail(bodyText),
      };
    }
    return {
      code: String(status),
      title: t('err.reqFailedTitle', { status }),
      explanation: t('err.unexpectedMsg'),
      detail: short ?? trimDetail(bodyText),
    };
  }

  // Local engine / network layer.
  const networkLike = /fetch failed|NetworkError|Failed to fetch|ECONNREFUSED|ERR_CONNECTION/i;
  if (networkLike.test(raw) || raw.includes('down empty')) {
    return {
      code: '503',
      title: t('err.engineTitle'),
      explanation: t('err.engineMsg'),
      detail: trimDetail(raw),
    };
  }

  // Text file that is not UTF-8 (binary, image, legacy encoding).
  if (/valid utf-?8|utf-?8|did not contain valid/i.test(raw)) {
    return {
      code: '415',
      title: t('err.binaryTitle'),
      explanation: t('err.binaryMsg'),
      detail: trimDetail(raw),
    };
  }

  // Agent stopped making progress: it ran out of tool rounds or read too much
  // in a single round. Both are recoverable by re-running the request.
  if (/tool loop limit exceeded/i.test(raw)) {
    return {
      code: '508',
      title: t('err.loopTitle'),
      explanation: t('err.loopMsg'),
      detail: trimDetail(raw),
    };
  }
  if (/tool result budget exceeded/i.test(raw)) {
    return {
      code: '413',
      title: t('err.budgetTitle'),
      explanation: t('err.budgetMsg'),
      detail: trimDetail(raw),
    };
  }

  // Filesystem contexts get filesystem advice, not provider advice.
  const fsContext = context ? /file|create|move|rename|delete|save|workspace|read/i.test(context) : false;
  return {
    code: '500',
    title: context ? t('err.titleFailed', { ctx: ctxLabel(context) }) : t('err.opFailed'),
    explanation: fsContext ? t('err.opFailedMsgFile') : t('err.opFailedMsg'),
    detail: trimDetail(raw),
  };
}

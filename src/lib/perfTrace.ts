/**
 * Dev-only performance tracing for the chat-switch path.
 *
 * Why: switching to a chat that has only a little history still takes ~5 s, and
 * guessing at the source (Prism, markdown, JSON persistence) did not hold up.
 * This module answers "where did the ~5 s go" with three cheap probes, all
 * inert in production builds:
 *
 *   1. longtask   - any main-thread block > 120 ms, stamped with how long after
 *                   the click it started (a 5 s block shows up immediately).
 *   2. ipc        - every Tauri `invoke` slower than 200 ms, with its command.
 *   3. net        - every `fetch` slower than 200 ms, with its URL.
 *
 * The switch itself is timed by `markSwitchStart()` (on click) and
 * `reportSwitchPaint()` (two frames later, i.e. after the paint).
 */

let switchMark: number | null = null;
let switchMarkTimer: number | undefined;

export const markSwitchStart = () => {
  if (!import.meta.env.DEV) return;
  switchMark = performance.now();
  // Isaret 8 sn sonra kendini temizler: gecisle ilgisiz longtask'lar
  // "+Nms after click" damgasiyla yanlis etiketlenmesin.
  if (switchMarkTimer !== undefined) window.clearTimeout(switchMarkTimer);
  switchMarkTimer = window.setTimeout(() => { switchMark = null; }, 8000);
};

/** Click-to-paint for the switch path (two frames: after the paint). */
export const reportSwitchPaint = (label: string) => {
  if (!import.meta.env.DEV || switchMark === null) return;
  const t0 = switchMark;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      console.log(`[perf] ${label}: click → paint ${Math.round(performance.now() - t0)}ms`);
    });
  });
};

const sinceSwitch = () => (switchMark === null ? null : Math.round(performance.now() - switchMark));

export const initPerfTrace = () => {
  if (!import.meta.env.DEV) return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 120) continue;
        const after = sinceSwitch();
        const where = after === null ? '' : ` (+${after}ms after click)`;
        console.warn(`[longtask] ${Math.round(entry.duration)}ms${where}`, entry.name);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask is Chromium-only; WebView2 supports it, other engines just skip.
  }

  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  const rawInvoke = internals?.invoke as
    | ((cmd: string, args?: unknown, options?: unknown) => Promise<unknown>)
    | undefined;
  if (internals && typeof rawInvoke === 'function' && !(internals as { __perfTraced?: boolean }).__perfTraced) {
    (internals as { __perfTraced?: boolean }).__perfTraced = true;
    internals.invoke = async (cmd: string, args?: unknown, options?: unknown) => {
      const t0 = performance.now();
      try {
        return await rawInvoke(cmd, args, options);
      } finally {
        const ms = performance.now() - t0;
        if (ms > 200) console.warn(`[ipc] ${cmd} took ${Math.round(ms)}ms`, args);
      }
    };
  }

  const rawFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const t0 = performance.now();
    try {
      return await rawFetch(...args);
    } finally {
      const ms = performance.now() - t0;
      if (ms > 200) console.warn(`[net] ${Math.round(ms)}ms ${String(args[0])}`);
    }
  };
};

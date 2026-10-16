/**
 * Dev-only performance tracing for the chat-switch path.
 *
 * Why: switching to a chat that has only a little history takes ~4-5 s, and
 * guessing at the source (Prism, markdown, JSON persistence) did not hold up.
 * These probes are inert in production builds:
 *
 *   switch    - click → paint for the switch path, and how long the click sat
 *               in the event queue (input delay) before React even ran.
 *   longtask  - any main-thread block > 120 ms, with wall-clock stamps.
 *   blocked   - a 500 ms heartbeat whose drift reveals *when* the main thread
 *               is stuck, even with no click involved.
 *   ipc / net - Tauri `invoke` and `fetch` calls slower than 200 ms.
 *
 * All probes are wrapped defensively: a probe must never break the app (an
 * earlier version crashed on the read-only `__TAURI_INTERNALS__.invoke`).
 */

let switchMark: number | null = null;
let switchMarkTimer: number | undefined;
let switchSeq = 0;

const stamp = () => `t=${Math.round(performance.now())}ms`;

export const markSwitchStart = () => {
  if (!import.meta.env.DEV) return;
  switchMark = performance.now();
  switchSeq += 1;
  // Isaret 8 sn sonra kendini temizler: gecisle ilgisiz longtask'lar
  // "+Nms after click" damgasiyla yanlis etiketlenmesin.
  if (switchMarkTimer !== undefined) window.clearTimeout(switchMarkTimer);
  switchMarkTimer = window.setTimeout(() => { switchMark = null; }, 8000);
};

/**
 * Tıklamanın kuyrukta ne kadar beklediğini ölçer: event.timeStamp olayın
 * oluştuğu anı verir; aradaki fark = ana iş parçacığı meşgul olduğu için
 * işleyicinin geç çalıştığı süre.
 */
export const reportClickDelay = (label: string, eventTimeStamp: number) => {
  if (!import.meta.env.DEV) return;
  const delay = Math.round(performance.now() - eventTimeStamp);
  if (delay > 30) console.warn(`[perf] ${label}: handler ran ${delay}ms after the click`);
};

/** Click-to-paint for the switch path (two frames: after the paint). */
export const reportSwitchPaint = (label: string) => {
  if (!import.meta.env.DEV || switchMark === null) return;
  const t0 = switchMark;
  const seq = switchSeq;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      console.log(`[perf] ${label} (switch #${seq}): click → paint ${Math.round(performance.now() - t0)}ms`);
    });
  });
};

const sinceSwitch = () => (switchMark === null ? null : Math.round(performance.now() - switchMark));

const observe = (fn: () => void) => {
  try {
    fn();
  } catch {
    // Probe failures must never affect the app.
  }
};

export const initPerfTrace = () => {
  if (!import.meta.env.DEV) return;

  observe(() => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 120) continue;
        const after = sinceSwitch();
        const where = after === null ? '' : ` (+${after}ms after click)`;
        console.warn(`[longtask] ${Math.round(entry.duration)}ms @${stamp()}${where} [${entry.name}]`);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  });

  // Input delay: ayri bir olay kaydi, asil blogun tiklamadan ONCE de
  // basladigini gosterir (o zaman switch olcumu suçu yanlis yere atar).
  observe(() => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { processingStart?: number };
        const wait = e.processingStart !== undefined ? Math.round(e.processingStart - e.startTime) : 0;
        if (wait < 50 && entry.duration < 150) continue;
        console.warn(`[event] ${entry.name} waited ${wait}ms, took ${Math.round(entry.duration)}ms @${stamp()}`);
      }
    });
    observer.observe({ type: 'event', durationThreshold: 100, buffered: true } as PerformanceObserverInit);
  });

  // Heartbeat: 500 ms'lik zamanlayicinin gecikmesi = ana is parcaciginin o an
  // mesgul oldugu sure. Tiklamadan bagimsiz olarak nerede takildigini gosterir.
  observe(() => {
    let last = performance.now();
    const beat = () => {
      const now = performance.now();
      const drift = now - last - 500;
      if (drift > 250) console.warn(`[blocked] main thread busy ~${Math.round(drift)}ms @${stamp()}`);
      last = now;
      window.setTimeout(beat, 500);
    };
    window.setTimeout(beat, 500);
  });

  observe(() => {
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      reportClickDelay(`click on ${target?.tagName?.toLowerCase() ?? '?'}`, e.timeStamp);
    }, true);
  });

  observe(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__;
    const rawInvoke = internals?.invoke;
    if (!internals || typeof rawInvoke !== 'function') return;
    const wrapped = async (cmd: string, args?: unknown, options?: unknown) => {
      const t0 = performance.now();
      try {
        return await (rawInvoke as (c: string, a?: unknown, o?: unknown) => Promise<unknown>)(cmd, args, options);
      } finally {
        const ms = performance.now() - t0;
        if (ms > 200) console.warn(`[ipc] ${cmd} took ${Math.round(ms)}ms`, args);
      }
    };
    // Bazi Tauri surumlerinde invoke salt-okunur; o durumda sonda sessizce atlanir.
    Object.defineProperty(internals, 'invoke', { value: wrapped, writable: true, configurable: true });
  });

  observe(() => {
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
  });
};

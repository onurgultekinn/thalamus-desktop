import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

interface InitContext {
  current_dir: string;
  file_count: number;
  /** Backend'in bu mount için ürettiği oturum kimliği. */
  session_id: number;
}

/**
 * Real PTY bridge: keystrokes go raw to the backend (to ConPTY),
 * and PowerShell itself handles echo/prompt/line editing. This way ANSI
 * colors and interactive programs like vim work correctly.
 */
export function RealTerminal() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef<boolean>(false);

  useEffect(() => {
    if (!terminalRef.current || isInitialized.current) return;
    isInitialized.current = true;

    let disposed = false;
    let sessionId: number | null = null;
    let pendingStart: Promise<InitContext> | null = null;
    let unlisten: (() => void) | undefined;

    const term = new Terminal({
      theme: {
        background: '#1C1B1A',
        foreground: '#CECDC3',
        cursor: '#4385BE',
        selectionBackground: '#264f78'
      },
      fontFamily: "'Cascadia Code', 'Ubuntu Sans Mono', Consolas, 'Courier New', monospace",
      fontSize: 12,
      cursorBlink: true,
      convertEol: false
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    const syncSize = () => {
      try {
        fitAddon.fit();
        invoke('resize_terminal', { rows: term.rows, cols: term.cols }).catch(() => {});
      } catch {}
    };

    setTimeout(syncSize, 100);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(syncSize);
    });
    resizeObserver.observe(terminalRef.current);

    // Tarayıcı önizlemesinde Tauri IPC yoktur; `invoke` çağırmak
    // "Cannot read properties of undefined" fırlatıp arayüzde korkutucu bir
    // hata basıyordu. Dürüst davran: özelliğin masaüstünde olduğunu söyle.
    const isTauri =
      typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (!isTauri) {
      term.writeln(
        '[90m[terminal] Masaüstü uygulamasında kullanılabilir — ' +
          'tarayıcı önizlemesinde gerçek PTY yoktur.[0m'
      );
      return () => {
        term.dispose();
        isInitialized.current = false;
      };
    }

    // 1. Attach the listener (writes PTY output verbatim — including ANSI).
    //    StrictMode dev'de effect iki kez çalışır; geç gelen temizliği hemen uygula.
    listen<string>('terminal-data', (event: Event<string>) => {
      if (!disposed) term.write(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    // 2. Open the PTY bridge. StrictMode'un geliştirme modundaki ilk (geçici)
    //    mount'u ile ikinci mount'un start/close çağrıları sırasız düşebilir;
    //    her mount kendi kimliğini tutar, kapanışta yalnızca onu kapatır.
    pendingStart = invoke<InitContext>('start_terminal');
    pendingStart
      .then((ctx) => {
        sessionId = ctx.session_id;
        if (disposed) return;
        term.writeln(`\x1b[90m[SYS] workspace: '${ctx.current_dir}' (${ctx.file_count} files)\x1b[0m`);
        syncSize();
      })
      .catch((err) => {
        if (!disposed) term.writeln(`\x1b[31m[Bridge Error]: ${String(err)}\x1b[0m`);
      });

    // 3. Keyboard interaction: raw input is streamed to the PTY (no local echo)
    term.onData((data: string) => {
      invoke('write_terminal', { data }).catch(console.error);
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (unlisten) unlisten();
      term.dispose();
      isInitialized.current = false;

      // Oturum kimliği ancak start çözülünce bilinir; kapanışı o promise'e
      // zincirle. Backend, kimlik eşleşmezse yeni oturumu kapatmaz.
      const started = pendingStart ?? Promise.resolve(null);
      started
        .catch(() => null)
        .then(() => invoke('close_terminal', { sessionId }).catch(() => {}));
    };
  }, []);

  return (
    <div className="w-full h-full min-h-[150px] bg-[#1C1B1A] p-2 overflow-hidden flex flex-col">
      <div ref={terminalRef} className="w-full h-full flex-1" />
    </div>
  );
}

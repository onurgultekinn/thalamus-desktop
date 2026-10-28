import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import { ClipboardPaste, Copy, Eraser, RotateCcw } from 'lucide-react';
import { useT, t as i18nT } from '../lib/i18n';
import { ErrorState } from './StateViews';
import '@xterm/xterm/css/xterm.css';

interface InitContext {
  current_dir: string;
  file_count: number;
  /** Backend'in bu mount için ürettiği oturum kimliği. */
  session_id: number;
}

interface TerminalActions {
  copy: () => void;
  paste: () => void;
  clear: () => void;
}

/**
 * Real PTY bridge: keystrokes go raw to the backend (to ConPTY),
 * and PowerShell itself handles echo/prompt/line editing. This way ANSI
 * colors and interactive programs like vim work correctly.
 */
export function RealTerminal() {
  const t = useT();
  const terminalRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef<boolean>(false);
  const actionsRef = useRef<TerminalActions | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminalRef.current || isInitialized.current) return;
    isInitialized.current = true;
    setBridgeError(null);

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
        invoke('resize_terminal', { rows: term.rows, cols: term.cols }).catch((err) => {
          console.warn('resize_terminal failed:', err);
        });
      } catch (err) {
        console.warn('terminal fit failed:', err);
      }
    };

    setTimeout(syncSize, 100);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(syncSize);
    });
    resizeObserver.observe(terminalRef.current);

    const copy = () => {
      const selection = term.getSelection();
      if (!selection) return;
      navigator.clipboard.writeText(selection).catch(() => {});
    };

    const paste = () => {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (!text) return;
          if (/[\r\n]/.test(text) && !window.confirm(i18nT('terminal.pasteConfirm'))) return;
          term.paste(text);
        })
        .catch(() => {});
    };

    const clear = () => {
      term.clear();
      invoke('write_terminal', { data: '\x0c' }).catch(() => {});
    };

    actionsRef.current = { copy, paste, clear };

    // Tarayıcı önizlemesinde Tauri IPC yoktur; `invoke` çağırmak
    // "Cannot read properties of undefined" fırlatıp arayüzde korkutucu bir
    // hata basıyordu. Dürüst davran: özelliğin masaüstünde olduğunu söyle.
    const isTauri =
      typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (!isTauri) {
      term.writeln(
        '\x1b[90m[terminal] Masaüstü uygulamasında kullanılabilir — ' +
          'tarayıcı önizlemesinde gerçek PTY yoktur.\x1b[0m'
      );
      return () => {
        resizeObserver.disconnect();
        term.dispose();
        actionsRef.current = null;
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
        setBridgeError(null);
        term.writeln(`\x1b[90m[SYS] workspace: '${ctx.current_dir}' (${ctx.file_count} files)\x1b[0m`);
        syncSize();
      })
      .catch((err) => {
        if (!disposed) {
          setBridgeError(String(err));
          term.writeln(`\x1b[31m[Bridge Error]: ${String(err)}\x1b[0m`);
        }
      });

    // 3. Keyboard interaction: raw input is streamed to the PTY (no local echo)
    term.onData((data: string) => {
      invoke('write_terminal', { data }).catch(console.error);
    });

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && key === 'c') {
        copy();
        return false;
      }
      if (mod && (event.shiftKey || event.metaKey) && key === 'v') {
        paste();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === 'l') {
        clear();
        return false;
      }
      return true;
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (unlisten) unlisten();
      term.dispose();
      actionsRef.current = null;
      isInitialized.current = false;

      // Oturum kimliği ancak start çözülünce bilinir; kapanışı o promise'e
      // zincirle. Backend, kimlik eşleşmezse yeni oturumu kapatmaz.
      const started = pendingStart ?? Promise.resolve(null);
      started
        .catch(() => null)
        .then(() => invoke('close_terminal', { sessionId }).catch(() => {}));
    };
  }, [restartKey]);

  const toolbarButton =
    'inline-flex items-center gap-1.5 rounded border border-obsidian-raise bg-[#232221] px-2 py-1 text-[10.5px] text-obsidian-soft transition-colors hover:bg-[#2D2C2A] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4385BE]';

  return (
    <div className="w-full h-full min-h-[150px] bg-obsidian-panel p-2 overflow-hidden flex flex-col">
      <div className="mb-1.5 flex items-center justify-end gap-1.5" role="toolbar" aria-label={t('terminal.toolbar')}>
        <button type="button" className={toolbarButton} onClick={() => actionsRef.current?.copy()}>
          <Copy size={11} />
          {t('terminal.copy')}
        </button>
        <button type="button" className={toolbarButton} onClick={() => actionsRef.current?.paste()}>
          <ClipboardPaste size={11} />
          {t('terminal.paste')}
        </button>
        <button type="button" className={toolbarButton} onClick={() => actionsRef.current?.clear()}>
          <Eraser size={11} />
          {t('terminal.clear')}
        </button>
        <button type="button" className={toolbarButton} onClick={() => setRestartKey((key) => key + 1)}>
          <RotateCcw size={11} />
          {t('terminal.restart')}
        </button>
      </div>
      {bridgeError && (
        <ErrorState
          message={t('terminal.bridgeError')}
          details={bridgeError}
          detailsLabel={t('terminal.details')}
          onRetry={() => setRestartKey((key) => key + 1)}
          retryLabel={t('common.retry')}
          className="mb-1.5"
        />
      )}
      <div ref={terminalRef} className="w-full h-full flex-1" />
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

interface InitContext {
  current_dir: string;
  file_count: number;
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

    let unlisten: (() => void) | undefined;

    // 1. Attach the listener (writes PTY output verbatim — including ANSI)
    listen<string>('terminal-data', (event: Event<string>) => {
      term.write(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    // 2. Open the PTY bridge
    invoke<InitContext>('start_terminal')
      .then((ctx) => {
        term.writeln(`\x1b[90m[SYS] workspace: '${ctx.current_dir}' (${ctx.file_count} files)\x1b[0m`);
        syncSize();
      })
      .catch((err) => {
        term.writeln(`\x1b[31m[Bridge Error]: ${String(err)}\x1b[0m`);
      });

    // 3. Keyboard interaction: raw input is streamed to the PTY (no local echo)
    term.onData((data: string) => {
      invoke('write_terminal', { data }).catch(console.error);
    });

    return () => {
      resizeObserver.disconnect();
      if (unlisten) unlisten();
      invoke('close_terminal').catch(() => {});
      term.dispose();
      isInitialized.current = false;
    };
  }, []);

  return (
    <div className="w-full h-full min-h-[150px] bg-[#1C1B1A] p-2 overflow-hidden flex flex-col">
      <div ref={terminalRef} className="w-full h-full flex-1" />
    </div>
  );
}

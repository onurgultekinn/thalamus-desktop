# Thalamus Desktop

A local prompt-compression engine with a chat, project (file explorer + editor + native terminal) and an AI copilot panel. Built with **React + TypeScript + Vite** and **Tauri 2 (Rust)**.

## Running

> Note: compression, the file explorer, and the terminal are **only enabled in the desktop app** (they run through Tauri IPC with the Rust backend). If you open it in the browser with `npm run dev`, you will only see the interface; backend-dependent features remain empty/ready.

**Development mode (window + backend):**
```
npm run tauri:dev
```

**Running in the browser with the real backend** (compression + health check over HTTP):
```
npm run backend        # Rust HTTP backend starts (127.0.0.1:8277)
npm run dev            # in a separate terminal: interface (http://localhost:1420)
```

**Interface only (browser, no backend):**
```
npm run dev
```

**Packaging:**
```
npm run tauri:build
```

## MVP features
- **Compression Chat** — compresses the prompt losslessly; shows token savings, cost, and a "before/after" diff. The engine is pure Rust (tiktoken + TSV/dictionary encoder, with lossless verification).
- **Project view** — real file system tree, editor, "Run" / "Save" (Ctrl+S), PowerShell terminal.
- **Copilot panel** — Chat / Agent mode; real AI response with a configured OpenAI / Anthropic / DeepSeek key. If no key is present, it shows an honest warning (it does not produce fake responses).
- **Settings** — provider keys, theme (Obsidian / Nord Red), default model, workspace root.

## Known limitations (MVP)
- Authentication is local/demonstrative (no real account/hash).
- Copilot AI calls go through a local proxy on the Rust side (`/api/ai/chat`, 127.0.0.1:8277); the webview does not connect to the provider directly.
- File explorer: deletion (to trash) and cross-drive moves are supported; file/folder sizes are not listed.

## Product principle (agreed)
- **Compression is fully lossless**: only JSON segments are converted to the `@T` table (round-trip verified); code blocks and text are carried over word for word; the order does not change.
- **Translation (TR→EN) was rejected** (2026-10): although it would pay off, it breaks the lossless principle — no lossy transformation (summarization, paraphrase, translation) will be performed.

## Third-party notices
See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the full list of runtime
dependencies, licenses and design credits.

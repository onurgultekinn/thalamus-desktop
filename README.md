# Thalamus Desktop

Thalamus Desktop is a local-first AI workbench built around a lossless
prompt-compression engine. The engine is pure Rust: it converts JSON segments
of a prompt into a compact `@T` table, verifies the round trip, and reports
token and cost savings. Around the engine sit a chat interface, a project
view (file explorer, editor, terminal), an agent-mode copilot with local file
tools, and support for any OpenAI-compatible provider, including local model
runtimes such as Ollama and LM Studio. The frontend is React + TypeScript +
Vite; the desktop shell and backend are Tauri 2 (Rust). The backend listens
on 127.0.0.1 only, with a CORS allowlist and a DNS-rebinding guard; provider
requests are made by the Rust process, not by the webview.

## Features

**Chat and compression**
- Every prompt runs through the compression engine; the UI shows token counts, savings, cost, and a before/after diff.
- Streaming responses, with stop, regenerate, and edit-and-resend.
- Chat history with search, rename, pin, and export to Markdown or JSON.
- Per-message token usage and cost, with optional live model pricing.
- File and image attachments; an on-device MediaPipe object detector classifies images locally (no upload) to choose the processing tier.
- Ask-question cards: the model can request structured clarification instead of guessing.
- Model router with automatic, fast, and deep modes.

**Projects (IDE)**
- File explorer over the real workspace: create, rename, delete (to trash), and move files and folders.
- Code editor with save (Ctrl+S), run, autosave, and configurable font size, line numbers, and tab size.
- PowerShell terminal (portable-pty on the Rust side, xterm.js in the UI).
- File preview for PDF, Office documents, spreadsheets, archives, media, EPUB, and Mermaid/PlantUML drawings.
- Repository map: a compact summary of the workspace, generated for AI context.

**Agent tools**
- Copilot agent mode with local tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `find_files`, `grep_search`, `get_code_body`, `todo_write`, `dispatch_agent`, `run_command`.
- Permission modes: read-only, plan, safe, auto, autonomous. `run_command` is active only in the last two.
- File edits are recorded during the run and applied from a reviewable diff in the editor, so the editor state and undo chain stay intact.
- Sub-agents via `dispatch_agent`; their token usage is added to the parent run.
- All tool paths are pinned to the workspace root, outputs are size-capped, and no tool has network access.

**Multi-agent runs**
- Agent Mesh: a multi-agent pipeline in which agents exchange typed JSON envelopes; the envelope wire format passes through the same lossless `@T` encoder. A mock mode runs without a provider key.
- Agent Company: plan, chart (node editor), and animate multi-agent setups; plans can be generated from templates through the configured provider.

**Providers and models**
- Any OpenAI-compatible endpoint. Presets: OpenAI, DeepSeek, Google Gemini, xAI Grok, Mistral, Groq, OpenRouter, Together AI, Fireworks, Perplexity, Zhipu GLM, Moonshot Kimi, Qwen, SiliconFlow, DeepBricks, EVREN, Ollama, LM Studio, plus custom base URLs.
- API keys are stored in the OS credential vault, not in plain files.
- Local model discovery: running OpenAI-compatible servers (Ollama, LM Studio, llama.cpp, vLLM, and others), installed inference engines, and model files on disk.
- Local models can be started and stopped from Settings, with automatic idle shutdown.

**Interface**
- English and Turkish UI.
- Themes: Obsidian (dark) and Nord Red.
- Command palette and a secondary command bar for navigation and actions.
- Settings for providers, default model, router mode, workspace root, editor behavior, and chat instructions.

## Product principle

- Compression is fully lossless. Only JSON segments are converted to the `@T` table, and every conversion is round-trip verified. Code blocks and text are carried over word for word, and the segment order never changes.
- No lossy transformation — summarization, paraphrase, or translation — is performed. Translation (TR to EN) was evaluated and rejected (2026-10): it would pay off in tokens, but it breaks the lossless principle.

## Install

Beta builds will be published under GitHub Releases.

> (first public beta — builds coming)

## Development

Requires Node.js and a Rust toolchain.

> Note: the file explorer and the terminal are enabled only in the desktop
> app (they run through Tauri IPC with the Rust backend). In the browser,
> backend-dependent features remain unavailable.

Desktop app (window + backend):
```
npm install
npm run tauri:dev
```

Browser with the real backend (compression + health check over HTTP):
```
npm run backend        # Rust HTTP backend starts (127.0.0.1:8277)
npm run dev            # in a separate terminal: interface (http://localhost:1420)
```

Interface only (browser, no backend features):
```
npm run dev
```

Packaging:
```
npm run tauri:build
```

## Error codes

Every user-visible error shows a stable code. The full registry — what each
code means and what to do — is in [ERRORS.md](ERRORS.md).

## Third-party notices

See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the full list of runtime
dependencies, licenses, and design credits.

## License

Copyright 2026 Onur Gültekin. Licensed under the
[Apache License, Version 2.0](LICENSE). In short: you may use, modify, and
distribute this software, including commercially, as long as the license
and attribution notices are preserved. The "Thalamus" name and branding
are not covered by the license.


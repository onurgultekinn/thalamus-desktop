<div align="center">

<img src="src-tauri/icons/128x128.png" alt="Thalamus Desktop" width="112" height="112" />

# Thalamus Desktop

**A local-first AI workbench built around a lossless prompt-compression engine.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)](#status)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4.svg)](#install)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-engine-000000.svg?logo=rust)](src-tauri/src/engine)
[![TypeScript](https://img.shields.io/badge/TypeScript-React%20%2B%20Vite-3178C6.svg?logo=typescript&logoColor=white)](src)

</div>

---

Thalamus Desktop combines an AI chat, a project workspace (file explorer,
editor, terminal), and an agent-mode copilot in a single desktop application.
The centerpiece is a prompt-compression engine written in pure Rust: it
converts JSON segments into a compact `@T` table, verifies every round trip,
and reports exactly how many tokens and dollars each prompt saves.

Everything runs on your machine. The backend listens on `127.0.0.1` only,
provider requests are made by the Rust process rather than the webview, API
keys live in the OS credential vault, and no telemetry is collected.

## Why

Sending a prompt to a large model is expensive and most of the cost comes
from structure the model does not need — repeated keys, boilerplate, and
duplicated segments. Thalamus rewrites that structure losslessly before the
request leaves your machine:

- **Lossless by construction.** Only JSON segments are translated; every
  conversion is round-trip verified, so the decompressed prompt is identical
  to the original.
- **No lossy shortcuts.** No summarization, paraphrase, or translation is
  performed — code and prose are carried over word for word, in order.
- **Visible savings.** Every message shows the token count before and after,
  the savings percentage, and the cost delta.

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

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Webview (React + TypeScript + Vite)                         │
│  chat · project IDE · agent UI · settings · i18n             │
└───────────────────────────┬──────────────────────────────────┘
                            │ Tauri IPC / HTTP (127.0.0.1)
┌───────────────────────────┴──────────────────────────────────┐
│  Rust backend (Tauri 2)                                      │
│                                                              │
│  engine/          lossless @T compression, round-trip check   │
│  backend/ai.rs    streaming, tool loop, retries, budgets      │
│  backend/tools.rs workspace-pinned file tools                 │
│  backend/repo*    workspace map for AI context                │
│  agent/           multi-agent envelopes                       │
│  secrets.rs       OS credential vault                         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS
                ┌───────────┴────────────┐
                │ OpenAI-compatible APIs │  (or local runtimes)
                └────────────────────────┘
```

The webview never contacts a provider directly. The Rust process owns
provider credentials, request construction, and compression.

## Status

Early beta. The core engine, chat, project workspace, and agent tools are
functional; builds are published under [Releases](../../releases). Expect
breaking changes before `1.0`.

## Install

Beta builds will be published under GitHub Releases. Package-manager
channels (`winget`) are planned for the first public beta.

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

## Contributing

Bug reports, feature ideas, and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. For security issues,
see [SECURITY.md](SECURITY.md).

## Product principle

- Compression is fully lossless. Only JSON segments are converted to the `@T` table, and every conversion is round-trip verified. Code blocks and text are carried over word for word, and the segment order never changes.
- No lossy transformation — summarization, paraphrase, or translation — is performed. Translation (TR to EN) was evaluated and rejected (2026-10): it would pay off in tokens, but it breaks the lossless principle.

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
are not covered by the license — see [TRADEMARK.md](TRADEMARK.md).


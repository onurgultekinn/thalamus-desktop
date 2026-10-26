<div align="center">

<img src="src-tauri/icons/128x128.png" alt="Thalamus Desktop" width="112" height="112" />

# Thalamus Desktop

**A local-first AI workbench built around a lossless prompt-compression engine.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/onurgultekinn/thalamus-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/onurgultekinn/thalamus-desktop/actions/workflows/ci.yml)
[![CodeQL](https://github.com/onurgultekinn/thalamus-desktop/actions/workflows/codeql.yml/badge.svg)](https://github.com/onurgultekinn/thalamus-desktop/actions/workflows/codeql.yml)
[![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)](#status)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4.svg)](#requirements)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-engine-000000.svg?logo=rust)](src-tauri/src/engine)
[![TypeScript](https://img.shields.io/badge/TypeScript-React%20%2B%20Vite-3178C6.svg?logo=typescript&logoColor=white)](src)

</div>

---

Thalamus Desktop combines an AI chat, a project workspace (file explorer,
editor, terminal), and an agent-mode copilot in one desktop application. The
centre of the project is a prompt-compression engine written in pure Rust: it
rewrites structured parts of a prompt into a compact `@T` table, verifies the
round trip, and reports how many tokens and dollars each prompt saved.

Everything runs on your machine. The backend listens on `127.0.0.1` only,
provider requests are made by the Rust process rather than the webview, API
keys live in the OS credential vault, and no telemetry is collected.

## Why

Most of the cost of a large-model request comes from structure the model does
not need — repeated keys, boilerplate, duplicated rows. Thalamus rewrites that
structure losslessly before the request leaves your machine:

- **Lossless by construction.** Each candidate representation is expanded back
  and compared with the original before it can be used. Anything that does not
  reproduce byte-for-byte is dropped and the raw text is sent untouched.
- **Nothing unexpected is touched.** Prose and fenced code blocks are never
  compressed. The segment order never changes.
- **Visible savings.** Every message shows tokens before and after, the savings
  percentage, and the cost difference. If a candidate does not clear the
  minimum savings threshold, it is not used.

## Features

**Chat and compression**
- Every prompt is segmented and compressed; the UI reports token counts,
  savings, cost, and a before/after diff.
- Structured formats handled by the engine: JSON, plus XML/SQL/INI/TOML/YAML
  "plain table" rows for certified shapes.
- Streaming responses with stop, regenerate, and edit-and-resend.
- Chat history with search, rename, pin, and export to Markdown or JSON.
- Per-message token usage and cost. A small offline price table ships with the
  app; optional live pricing is fetched once from the public LiteLLM catalogue
  and cached for 12 hours.
- File and image attachments. Screenshots are classified on-device with
  MediaPipe (no upload) to pick a processing tier.
- Ask-question cards: the model can request structured clarification instead of
  guessing.
- Model router with `auto`, `fast`, and `deep` modes; fast/deep model ids are
  chosen by you in Settings, not hard-coded.

**Projects (IDE)**
- File explorer over the real workspace: create, rename, delete (to trash), and
  move files and folders.
- Code editor with save (Ctrl+S), run, autosave, and configurable font size,
  line numbers, and tab size.
- Terminal powered by `portable-pty` and xterm.js. It launches Windows
  PowerShell, which is why the app targets Windows.
- Preview for PDF, Office documents, spreadsheets, archives, media, EPUB, and
  Mermaid/PlantUML drawings (offline assets ship with the app).
- Repository map: a compact structural summary of the workspace used as AI
  context.

**Agent tools**
- Copilot agent mode with thirteen tools: `read_file`, `write_file`, `edit_file`,
  `list_dir`, `find_files`, `grep_search`, `get_code_body`, `repo_map`,
  `todo_write`, `dispatch_agent`, `web_search`, `read_page`, and `run_command`.
- Permission modes: read-only, plan, ask, safe, auto, autonomous. `run_command`
  is exposed only in `auto` and `autonomous`.
- File edits are recorded during a run and applied through a reviewable diff, so
  the editor state and undo history stay intact.
- Sub-agents via `dispatch_agent`; their token usage is rolled into the parent
  run. Sub-agents are read-only and cannot spawn further sub-agents.
- **Network access is limited to two tools**: `web_search` (keyless search) and
  `read_page` (fetch a page as text). Every other tool is filesystem-only. File
  tool paths are resolved inside the workspace root, and tool output is size
  capped.

**Multi-agent runs**
- Agent Mesh: agents exchange typed JSON envelopes, and those envelopes pass
  through the same lossless `@T` encoder. A mock brain runs the pipeline without
  a provider key.
- Agent Company: a plan view, a node-based flow editor, and an animated office
  view for multi-agent setups. Plans can be generated from templates through the
  configured provider.

**Providers and models**
- Any OpenAI-compatible endpoint. Presets: OpenAI, DeepSeek, Google Gemini,
  xAI Grok, Mistral, Groq, OpenRouter, Together AI, Fireworks, Perplexity,
  Zhipu GLM, Moonshot Kimi, Qwen (DashScope), SiliconFlow, DeepBricks, EVREN,
  Ollama, LM Studio, a custom base URL, and a managed local server mode.
- API keys are stored in the OS credential vault, not in plain files.
- Local model discovery: running OpenAI-compatible servers (Ollama, LM Studio,
  llama.cpp, vLLM and others), installed inference engines, and model files on
  disk.
- Local models can be started and stopped from Settings, with automatic idle
  shutdown.

**Web tools (optional external dependency)**
- `web_search` and `read_page` do not talk to the internet directly. They call a
  local helper binary, [`arastir`](https://github.com/onurgultekinn/arastir),
  over `127.0.0.1:19900`; Thalamus starts it detached on first use.
- The helper is a separate install. If it is missing, both tools return an
  explicit error ("Arastir API'ye ulaşılamadı…") and the rest of the agent
  keeps working. Nothing else in the app needs it.
- When the helper is present, search and page text that exceed the compression
  threshold are passed through the same lossless encoder and arrive compressed.

**Interface**
- English and Turkish UI, switchable at runtime.
- Themes: Dark (Obsidian palette) and Nord Red.
- Nucleus: a global command surface for asking a question or navigating the app
  from anywhere.
- Command palette and a second command bar in the project view.
- Local profile screen on first launch. This is **not** an account system: the
  name you enter stays in `localStorage` and personalises the interface only.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Webview (React + TypeScript + Vite)                         │
│  chat · project IDE · agent views · Nucleus · settings · i18n │
└───────────────────────────┬──────────────────────────────────┘
                            │ Tauri IPC / HTTP (127.0.0.1)
┌───────────────────────────┴──────────────────────────────────┐
│  Rust backend (Tauri 2)                                      │
│                                                              │
│  engine/          segmentation, @T encoder, round-trip check  │
│  backend/ai.rs    streaming, tool loop, retries, budgets      │
│  backend/tools.rs workspace-pinned file tools                 │
│  backend/repo.rs  workspace map for AI context                │
│  agent/           multi-agent envelopes and orchestration     │
│  secrets.rs       OS credential vault                         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS
                ┌───────────┴────────────┐
                │ OpenAI-compatible APIs │  (or local runtimes)
                └────────────────────────┘
```

The webview never contacts a provider directly. The Rust process owns provider
credentials, request construction, and compression.

## Security and privacy

- The local backend binds to `127.0.0.1` and uses a session token, a CORS
  allowlist, and a DNS-rebinding guard.
- Provider keys are read from the OS credential vault. They are never written to
  config files or logs.
- Agent file tools cannot leave the workspace root. The only network-capable
  tools are `web_search` and `read_page`; they receive the model's query or URL
  and nothing else from your machine.
- Provider requests leave only after local compression, and only to the endpoint
  you configured.
- No telemetry, no analytics, no crash reporting. Logs stay on disk; nothing is
  sent unless you copy it into a report.

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure process.

## Status

Early beta. The engine, chat, project workspace, and agent tools are
functional. Expect breaking changes before `1.0`. Windows 10/11 only for now;
the terminal and the desktop shell are Windows-specific.

## Requirements

- Windows 10 or 11 (x64)
- WebView2 runtime (preinstalled on current Windows)
- Node.js 22+ and a Rust toolchain, for development and packaging

## Install

Beta builds will be published under GitHub Releases. Package-manager channels
(`winget`) are planned for the first public beta.

> first public beta — builds coming

## Development

```
npm install
npm run tauri:dev      # desktop window + Rust backend
```

Browser with the real backend (compression and health check over HTTP):

```
npm run backend        # Rust HTTP backend on 127.0.0.1:8277
npm run dev            # separate terminal, interface on localhost:1420
```

Interface only, no backend features:

```
npm run dev
```

Packaging:

```
npm run tauri:build
```

The file explorer and terminal are available only in the desktop app; they run
through Tauri IPC with the Rust backend. In a plain browser those features stay
unavailable.

Generated assets (`public/file-viewer/`, `public/mediapipe/wasm/`) are copied
from `node_modules` by the `predev`/`prebuild` scripts and are not tracked.

## Fonts and assets

Cascadia Code and Caveat ship under the SIL Open Font License; the licence text
is in `public/legal/OFL-1.1.txt`. The MediaPipe object-detection model and WASM
runtime ship under their upstream Apache-2.0 terms.

## Error codes

Every user-visible error shows a stable code. The registry — what each code
means and what to do — is in [ERRORS.md](ERRORS.md).

## Contributing

Bug reports, feature ideas, and pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. Security
issues go through [SECURITY.md](SECURITY.md) — please do not open a public
issue for them.

| Where | What goes there |
|---|---|
| [Issues](../../issues/new/choose) | Reproducible bugs and accepted feature work |
| [Discussions · Q&A](../../discussions/categories/q-a) | Setup help, provider and local-model questions |
| [Discussions · Ideas](../../discussions/categories/ideas) | Proposals and design discussion |
| [Security advisories](../../security/advisories/new) | Private vulnerability reports |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Third-party notices

See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for dependencies, licences, and design
credits. The generated bundle notice is written to
`public/legal/THIRD_PARTY_NOTICES.txt` during build.

## License

Copyright 2026 Onur Gültekin. Licensed under the
[Apache License, Version 2.0](LICENSE): you may use, modify, and distribute this
software, including commercially, provided the licence and attribution notices
are preserved. The Thalamus name and branding are not covered by the licence —
see [TRADEMARK.md](TRADEMARK.md).

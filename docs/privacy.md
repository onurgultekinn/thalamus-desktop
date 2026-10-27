# Privacy and network activity

Thalamus Desktop collects **no telemetry, no analytics, and no crash reports**.
This document lists every outbound network destination in the code, when it is
used, and where data lives on disk. It was produced by scanning the source with
`grep -rnE "https?://"` in `src-tauri/src` and `src`, then reading each hit.

## Outbound destinations

### 1. The provider you configured (always your choice)

All chat traffic goes here. The Rust process sends the prompt (after local
compression) and receives the streamed answer.

| Destination | Purpose | Trigger | Data sent |
|---|---|---|---|
| The OpenAI-compatible endpoint in your settings | Chat, tool calls, model test | Every message you send | Message history, system prompt, tool results, attached file contents you chose to attach, model id, generation settings |
| `https://api.openai.com/v1` | Preset for OpenAI | Only if you pick OpenAI | Same as above |
| `https://api.deepseek.com/v1` | Preset for DeepSeek | Only if you pick DeepSeek | Same as above |
| `https://generativelanguage.googleapis.com/v1beta/openai` | Preset for Google Gemini | Only if you pick Gemini | Same as above |
| `https://api.x.ai/v1` | Preset for xAI Grok | Only if you pick Grok | Same as above |
| `https://api.mistral.ai/v1` | Preset for Mistral | Only if you pick Mistral | Same as above |
| `https://api.groq.com/openai/v1` | Preset for Groq | Only if you pick Groq | Same as above |
| `https://openrouter.ai/api/v1` | Preset for OpenRouter | Only if you pick OpenRouter | Same as above |
| `https://api.together.xyz/v1` | Preset for Together AI | Only if you pick Together | Same as above |
| `https://api.fireworks.ai/inference/v1` | Preset for Fireworks | Only if you pick Fireworks | Same as above |
| `https://api.perplexity.ai` | Preset for Perplexity | Only if you pick Perplexity | Same as above |
| `https://open.bigmodel.cn/api/paas/v4` | Preset for Zhipu GLM | Only if you pick Zhipu | Same as above |
| `https://api.moonshot.cn/v1` | Preset for Moonshot Kimi | Only if you pick Moonshot | Same as above |
| `https://dashscope.aliyuncs.com/compatible-mode/v1` | Preset for Qwen | Only if you pick Qwen | Same as above |
| `https://api.siliconflow.cn/v1` | Preset for SiliconFlow | Only if you pick SiliconFlow | Same as above |
| `https://api.deepbricks.ai/v1` | Preset for DeepBricks | Only if you pick DeepBricks | Same as above |
| `https://evren-llmapi.ssyz.org.tr/v1` | Preset for EVREN | Only if you pick EVREN | Same as above |
| A custom base URL you type | Anything OpenAI-compatible | Only when you set it | Same as above |

Source: `src/lib/connections.ts` (presets), `src-tauri/src/backend/ai.rs`
(`default_chat_url` and `resolve_api_key`). The provider only ever sees
compressed text, but it does see the content of the messages you send — that is
inherent to using a remote model.

### 2. Local model runtimes (stay on this machine)

| Destination | Purpose | Trigger |
|---|---|---|
| `http://127.0.0.1:11434` (Ollama), `:1234` (LM Studio), `:8080`, `:8000`, `:5001`, `:11500`, other loopback ports | Local model chat | When you select a local provider or Thalamus probes for running servers |

Source: `src/lib/connections.ts`, `src-tauri/src/backend/local_models.rs`,
`src-tauri/src/backend/serve.rs`. These are loopback addresses; no data leaves
the machine.

### 3. Price catalogue (optional, off unless you enable live pricing)

| Destination | Purpose | Trigger | Data sent |
|---|---|---|---|
| `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | Fetch current model prices | Only when live pricing is enabled; cached 12 hours | An HTTP GET with no parameters; no chat content |

Source: `src/lib/pricing.ts` (`LIVE_URL`, `fetchLivePrices`). Disabled by
default; the app uses the built-in price table otherwise.

Note: this request is made by the webview, and `raw.githubusercontent.com` is
in the CSP `connect-src` allowlist in `src-tauri/tauri.conf.json` for exactly
this purpose.

### 4. Web tools (optional external helper)

`web_search` and `read_page` do **not** contact the internet directly. They send
the model's query or URL to a local helper on `127.0.0.1:19900`, which Thalamus
starts detached on first use. Whatever that helper does with the query is
outside this application.

> Web tools are a separate component and will be documented in its own
> repository.

Source: `src-tauri/src/backend/arastir.rs`.

### 5. Local addresses only

| Destination | Purpose |
|---|---|
| `http://127.0.0.1:8277` | Thalamus's own local HTTP backend |
| `http://localhost:1420` | Vite dev server (development only) |
| `http://ipc.localhost`, `ipc:` | Tauri IPC bridge |
| `http://tauri.localhost` | Tauri webview origin |

## What is *not* a network destination

- `https://github.com/onurgultekinn/thalamus-desktop/blob/master/ERRORS.md`
  appears in `src/lib/errors.ts` as a documentation link opened only when you
  click it (via `open_external`, which only permits http/https/mailto).
- MediaPipe WASM and the object-detection model are loaded from local files
  (`public/mediapipe/`, `public/file-viewer/`), not a CDN. The `fetch` in
  `src/lib/onDeviceVision.ts` reads a local asset path.

## Where data lives

### Webview (localStorage)

Chats, settings, and UI state are stored in the webview's `localStorage`:

| Key | Contents |
|---|---|
| `thalamus_chats`, `thalamus_chat_messages_<id>`, `thalamus_active_chat_id` | Chat list and messages |
| `thalamus_config` | App configuration (provider choice, model ids, workspace root, …) |
| `thalamus_user` | Local display name (not an account) |
| `tlm_*` | UI preferences (language, theme, temperature, max tokens, recent projects, …) |
| `thalamus_sent_files_<id>` | Content hashes of files already sent in a chat (for dedup) |
| `tlm_pricing_cache_v2` | Cached price catalogue (if live pricing was used) |

Sources: `src/lib/contextPlan.ts`, `src/lib/pricing.ts`, `src/App.tsx`,
`src/lib/i18n.ts`.

### Rust (disk)

| Path | Contents | Encrypted? |
|---|---|---|
| `%APPDATA%\com.thalamus.desktop\thalamus_config.json` | Configuration written by the Rust side (falls back to `THALAMUS_CONFIG_DIR` if set) | No |
| Windows Credential Manager, targets prefixed `thalamus:key:` | Provider API keys | Yes — DPAPI (`CredProtectW`), with a backup slot |
| Tauri log output (plugin log, Info level) | Operational logs | No |

Sources: `src-tauri/src/lib.rs` (`config_path`), `src-tauri/src/secrets.rs`,
`src-tauri/src/lib.rs` (`tauri_plugin_log`). The app does not write chat
contents to disk in the Rust process — chats live in the webview's
`localStorage`.

### How to delete everything

1. Close the app.
2. Delete `%APPDATA%\com.thalamus.desktop\`.
3. Remove the stored keys: open **Credential Manager → Windows Credentials** and
   delete every entry starting with `thalamus:key:` (primary, `backup:`, and
   `quarantine:` slots).
4. Clearing the app's webview data (uninstalling the app, or clearing site data
   for the Tauri origin) removes chats and settings, since they live in
   `localStorage`.

Uninstalling alone does not remove `%APPDATA%` or the credential entries.

## Third-party services

The only third-party services the app talks to are the model provider you
choose and, optionally, the LiteLLM price catalogue. There is no Thalamus
account server, no sync, and no update checker in the code this document
describes. **DOĞRULANAMADI:** auto-update behaviour was not present in the
reviewed code; if one is added later, this document must be updated.

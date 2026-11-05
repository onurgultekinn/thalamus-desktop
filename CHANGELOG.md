# Changelog

All notable changes to Thalamus Desktop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **One-line Windows install.** `irm https://raw.githubusercontent.com/onurgultekinn/thalamus-desktop/master/install.ps1 | iex` fetches the latest release, verifies it against the release's `SHA256SUMS.txt`, and installs silently. It sidesteps the SmartScreen prompt and the script-execution policy because PowerShell downloads the file itself; hash verification is not skipped.

## [0.2.0-beta.1] - 2026-11-05

A first-tester feedback sweep (`hatalar.txt`, 30 items) ahead of the beta. Items
already fixed in earlier commits (green scrollbars, inline-code color, chat-row
actions, provider presets, theme swatches, model chip shortening) were verified
against the current build; everything below is new work in this tag.

### Fixed

- **Chat follows the stream again.** Auto-scroll used a fixed 140 px
  near-bottom threshold; the reasoning block expands ~220 px in one paint, so
  the view stopped following for the rest of every stream. Replaced with a
  sticky-pin state (release beyond 160 px, re-catch below 60 px) plus a
  message-driven follow; sending a message always jumps to the bottom.
- **Streaming caret artifacts.** The standalone caret bar under code blocks and
  between paragraph freezes read as "bars all over the reply" — both are now a
  small breathing dot; the inline text caret is unchanged.
- **Tables inside fenced examples are left alone.** The single-line table
  expander rewrote pipe rows even inside ``` fences; it is now fence-aware
  (with regression tests for the exact reported case).
- **Editor caret lands where you click.** The visible highlight layer carried
  `-0.01em` letter-spacing from the global mono rule while the transparent
  textarea did not, so the caret drifted per character. Both layers now share
  identical metrics and ligatures-off.
- **File search is fast again.** The tree JSX rebuilt on every editor keystroke
  (a stale `fileContents` memo dependency) and every search keystroke; the
  dependency is gone and search debounces at 140 ms like chat search.
- **Collapsed sidebar icon told the truth.** The projects rail icon showed
  "open folder" based on the active view, not whether a workspace was actually
  connected.
- **Processing loader alignment.** The label and the rotating word now share
  exact 20 px box metrics instead of a padding nudge.

### Changed

- **One switchable right panel.** File preview and Nucleus share the projects
  right column via tabs; Nucleus docks/undocks without losing its conversation
  (single instance moved by portal). When the flow canvas grows past the
  visible area (e.g. Nucleus closed), the content is brought back into view
  without touching the user's zoom.
- **Command palette grouped**: Commands / This chat / Chats; chat exports, copy
  and stop moved under "This chat". `Alt N` / `Ctrl K` header hints use the
  same kbd chip as the palette; the chat breadcrumb is dimmed to the muted
  tone.
- **Search chats panel** scrolls within the sidebar (max-height) instead of
  stretching it, and the role badge is a tiny dot with the role in the tooltip.
- **Chat message card slimmed**: the token/finance analytics card is a single
  inline row instead of a framed box above every reply.
- **Explorer**: the "+" dropdown became two direct icons (new file / new
  folder); the create form is a single line with the target folder inline; the
  context-menu file name uses the tree's mono font and wraps instead of
  truncating to "…"; the workspace-root row is a sticky first row of the tree.
- **Flow & Run**: Run sits to the right of Add agent with the same neutral
  style; empty-state CTAs dropped the yellow fill; the run screen states in one
  line what it does and its agent cards carry the same pixel faces as
  flow/office; PixelOffice gained a role-color legend.
- **Editor settings**: added word wrap (wired through both editor layers);
  removed the dead workspace-folder plumbing from Settings → General (folder
  selection lives in the projects view).

## [0.1.0] - 2026-11-04

First tagged build. Every item below is grounded in a commit under this tag.

### Added

- **Bounded context for long sessions.** Agent messages are compacted to a token
  budget instead of dropped: an old tool result becomes a deterministic,
  readable one-line summary carrying a `recall(id=N)` handle, and the model can
  fetch the full original text losslessly at any time. Every tool result, user
  message, and reply is stored with lossless compression and content
  deduplication; a message is only compacted when the store can resolve it
  again, so compaction cannot make information unreachable.
- The readable summary now keeps *singleton* values (`Distinct: field=value`).
  Previously it reported only item counts, status distributions, and field
  names, which silently dropped the one unique value a user is usually looking
  for (an identifier, a key, a one-off file).
- `recall` tool, and a context-store balance (`items`, `stored`, `savings_pct`,
  `unverified`, `budget_tokens`) in the `done` event so the UI can show that the
  window is bounded and nothing was lost.
- `/api/ai/chat` and `/api/ai/chat/stream` responses now include a `context`
  block: `window_tokens`, `budget_tokens`, and `window_verified`.
- **One pipeline for attachments** across every upload surface, with per-file
  read state and a model-readability badge; PDF text extraction via pdf.js.
- **Chat onboarding**: a first-run welcome with actionable bridges; an animated
  session-name box that falls back to automatic numbering ("Sohbet N");
  per-chat timestamps in the sidebar; project view without forced folder
  selection.

### Fixed

- **Silent truncation on local runtimes.** The context budget was derived from
  the model's *declared* window. Ollama does not report `context_length` on
  `/v1/models`, loads a 32K model at **4096** by default, and silently truncates
  longer prompts rather than erroring — measured: 150,000 characters sent to a
  32K-loaded instance came back as `prompt_tokens=16386`, and the fact in the
  middle was gone. The budget now uses the window the server actually loaded
  (`/api/ps` → `context_length`, llama.cpp `/v1/models` → `meta.n_ctx`), takes
  the smaller of declared and loaded, and falls back to 4096 when a local server
  reports nothing (`backend/model_caps.rs`, `backend/ai.rs`).
- Context-window documentation corrected. The claim that compressed `@T` tables
  "fit the window but the model cannot read them" (0/20) was not supported: that
  test varied length and format at once (27,420 vs 6,640 tokens) and planted the
  needle in a *user* message, which compaction never touches. The claim is
  withdrawn and replaced by `examples/presentation_test.rs`, which puts the
  needle inside a tool output and adds a length-matched `@T` condition. See
  `docs/context-window.md` Result 4.
- The draft release for this tag initially shipped without installer files: the
  workflow joined artifact paths into a single glob line, which matched nothing.
  `files:` now uses direct glob patterns.

### Changed

- The run screen is a four-cell management board on one screen: agents (a card
  per node with its kind, state, calls, tokens, last-turn duration and message
  count — click to filter its trail), the live stream, the plan, and the changes
  with review notes. Each cell scrolls inside itself, so the page never scrolls
  and a lead can see the whole run at a glance; below ~900px panel width the
  same cells stack into one column.
- Telemetry left the main surface: the KPI strip, savings meter and per-agent
  token bars are gone. Tokens/cost/calls are one quiet line under the task box,
  and the envelope-level detail lives behind a collapsed "Details" section.
- Company runs, dependency waves and bounded parallelism are back in place
  after the tree was reset: `run_org` executes the user's own nodes, an edge
  A→B means B waits for A (a producer no longer waits on its own reviewer), a
  reviewer's `error` re-runs the producer with both the finding and its own
  previous output and the result is re-reviewed, and a failing node no longer
  discards its siblings' results.

## [0.1.0-beta] - 2026-10-27

First public beta. Every item below is grounded in a commit in this repository;
nothing is aspirational.

### Added

- Lossless prompt-compression engine in pure Rust: JSON `@T` table encoding plus
  certified plain-table handling for XML/SQL/INI/TOML/YAML, with round-trip
  verification on every candidate.
- Ingest layer for JSONL, CSV, logfmt, and markdown tables feeding the same
  lossless encoder (`src-tauri/src/engine/ingest.rs`).
- Chat with streaming, regenerate, edit-and-resend, history search, pinning, and
  Markdown/JSON export.
- Per-message token usage and cost, with an offline price table and optional live
  pricing from the public LiteLLM catalogue (12-hour cache).
- Project workspace: file explorer, editor with save/run/autosave, PowerShell
  terminal via `portable-pty` and xterm.js, and a repository map for AI context.
- Agent mode with thirteen tools (file, search, `repo_map`, `todo`, web
  `web_search`/`read_page`, sub-agents, `run_command`) and six permission modes;
  `run_command` is limited to `auto` and `autonomous`.
- Edits recorded during an agent run and applied through a reviewable diff.
- Agent Mesh multi-agent envelopes that reuse the lossless encoder, with a mock
  brain for key-less runs; Agent Company plan, flow, and office views.
- Any OpenAI-compatible provider: 19 provider presets (incl. a managed local
  server) plus custom base URLs; keys stored in the OS credential vault; local
  model discovery, start, and idle shutdown.
- English and Turkish UI, Dark (Obsidian) and Nord Red themes, and the global
  Nucleus command surface.
- On-device screenshot classification with MediaPipe (no upload).
- Rust round-trip test suite covering every handled format, with control tests
  proving prose and fenced code are untouched (`engine/roundtrip_tests.rs`).
- 50 frontend unit tests for pure functions (diff, compact diff, pricing,
  formatting, policy, history planning) under `tests/` (vitest).
- `npm run i18n:check`: TR/EN key parity and empty-translation gate, wired into
  CI.
- `docs/` set: architecture, privacy, security model, install, benchmarks, and
  footprint measurement method.
- Release workflow now verifies the tag against `package.json`, runs quick lint
  and Rust tests before building, publishes `SHA256SUMS.txt`, builds the release
  body from the matching CHANGELOG section, and appends a SmartScreen note.

### Changed

- Session token is now generated from the OS CSPRNG (`getrandom`, 32 bytes →
  64 hex) instead of two `RandomState` hashes; a generation failure leaves the
  token empty so authenticated routes fail closed with 401.
- `run_command` strips sensitive environment variables (`*_API_KEY`, `*_TOKEN`,
  `*_SECRET`, `*_PASSWORD`, …) from the child process while keeping `PATH`,
  `SystemRoot`, `TEMP`, `USERPROFILE`, and `HOME`. The chat UI shows each run's
  command, exit code, and duration.
- README feature list is split into Stable and Experimental, with a roadmap,
  known limitations, screenshot placeholders, and links to the new docs.
- CI adds the licence gate, `npm audit` (advisory), `cargo fmt --check`
  (advisory), `cargo clippy` (advisory), and `cargo audit` (advisory).
- Dependabot groups minor/patch updates for npm, cargo, and GitHub Actions;
  the TypeScript major bump is now ignored explicitly, like Tailwind's.
- Cargo package metadata (description, author, repository, keywords,
  categories) and the Tauri bundle metadata (publisher, descriptions, copyright,
  `DeveloperTool` category, NSIS English/Turkish) are filled in; the unused
  `bundle.android` block is gone.

### Fixed

- `read_only_specs` no longer panics on an unexpected tool-spec shape; it
  returns an empty list instead.
- `read_page` SSRF guard: only `http`/`https` and public hosts are accepted;
  loopback, private, link-local, and DNS-rebinding targets are rejected.
- Error codes for configuration (400/403) and agent limits (413/508) now explain
  the real cause in both languages.
- An "unchanged" attached file is sent once and then referenced by content hash
  instead of being resent on every turn.
- Uncompressed messages are labelled neutrally ("sent as-is") instead of a
  misleading "%0 saved".

### Security

- Local backend bound to `127.0.0.1` with a CSPRNG session token, CORS
  allowlist, and DNS-rebinding host guard.
- Agent file tools cannot escape the workspace root; file edits are reviewable
  diffs.
- `web_search` and `read_page` are the only tools that deliberately make
  outbound requests; `read_page` URLs are screened before fetch (SSRF guard).
  `run_command` is documented honestly as an unsandboxed shell behind the
  permission gate.
- Provider keys are stored in the Windows Credential Manager encrypted with
  DPAPI, with a backup slot and quarantine for unreadable blobs.
- No telemetry of any kind.

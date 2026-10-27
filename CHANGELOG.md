# Changelog

All notable changes to Thalamus Desktop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

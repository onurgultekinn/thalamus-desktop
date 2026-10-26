# Changelog

All notable changes to Thalamus Desktop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Lossless prompt-compression engine in pure Rust: JSON `@T` table encoding plus
  certified plain-table handling for XML/SQL/INI/TOML/YAML, with round-trip
  verification on every candidate.
- Chat with streaming, regenerate, edit-and-resend, history search, pinning, and
  Markdown/JSON export.
- Per-message token usage and cost, with an offline price table and optional live
  pricing from the public LiteLLM catalogue (12-hour cache).
- Project workspace: file explorer, editor with save/run/autosave, PowerShell
  terminal via `portable-pty` and xterm.js, and a repository map for AI context.
- Agent mode with ten workspace-scoped tools and five permission modes;
  `run_command` is limited to `auto` and `autonomous`.
- Edits recorded during an agent run and applied through a reviewable diff.
- Agent Mesh multi-agent envelopes that reuse the lossless encoder, with a mock
  brain for key-less runs; Agent Company plan, flow, and office views.
- Any OpenAI-compatible provider: 18 presets plus custom base URLs; keys stored
  in the OS credential vault; local model discovery, start, and idle shutdown.
- English and Turkish UI, Dark (Obsidian) and Nord Red themes, and the global
  Nucleus command surface.
- On-device screenshot classification with MediaPipe (no upload).

### Security

- Local backend bound to `127.0.0.1` with session token, CORS allowlist, and
  DNS-rebinding guard.
- Agent tools cannot escape the workspace root and have no network access.
- No telemetry of any kind.

<!--
When the first beta is tagged, add a version section:

## [0.1.0-beta] - YYYY-MM-DD

### Added
- ...
-->

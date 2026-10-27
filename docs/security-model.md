# Security model

This document describes each protection in Thalamus Desktop, where it lives in
the code, and — equally important — what it does not protect against. It is
written to be honest: a defence is only listed if it is actually implemented.

## Threat model

Thalamus runs on a single Windows machine. The threats it takes seriously:

1. **Another local process** finding the `127.0.0.1:8277` port and driving the
   API with the user's stored provider keys.
2. **A malicious web page** in the user's browser trying to reach the local
   backend (DNS rebinding, CORS).
3. **A malicious model or prompt** trying to make the agent read or write files
   outside the workspace, reach private networks, or run arbitrary commands.
4. **Credential theft** through bulk dumping of Windows credential files.
5. **Prompt injection** in fetched web content.

Threats it does **not** claim to stop: an attacker already running as the same
Windows user with full privileges, a compromised OS, or a compromised provider.

## Controls

### 1. Session token on the local API

- **File:** `src-tauri/src/backend/mod.rs` — `session_token`, `auth_mw`.
- **What:** a 32-byte random token from the OS CSPRNG (`getrandom`), rendered as
  64 hex characters. Every request except `/api/health` must send it as
  `x-thalamus-token`. The token is handed to the webview through the
  `backend_token` Tauri command (`src-tauri/src/lib.rs`) and is not written to
  disk.
- **Failure mode:** if token generation ever fails, the token is empty and every
  authenticated route returns 401 (fail-closed) — the API never becomes open.
- **Limits:** any process that can call the Tauri IPC (i.e. code already running
  inside the app) can obtain the token; this protects the TCP port, not the IPC
  boundary.

### 2. Host guard (DNS rebinding)

- **File:** `src-tauri/src/backend/mod.rs` — `host_allowed`, `host_guard`.
- **What:** the `Host` header must be `127.0.0.1`, `localhost`, or `[::1]`
  (optionally with a port). Userinfo (`@`) is rejected; lookalikes such as
  `localhost.evil.com` or `127.0.0.1.nip.io` are rejected.
- **Why:** a page can point its own domain at `127.0.0.1`; CORS blocks reading
  the response, but a POST can still have side effects (e.g. writing files via
  the agent loop). The host guard blocks the request before routing.

### 3. CORS allowlist

- **File:** `src-tauri/src/backend/mod.rs` — `router`.
- **What:** only `http://localhost:1420`, `http://127.0.0.1:1420`,
  `tauri://localhost`, and `http://tauri.localhost` are allowed origins.
- **Limits:** CORS is a browser control. Non-browser clients (a local process)
  are not constrained by it — the session token is what stops those.

### 4. Workspace confinement (`safe_join`)

- **File:** `src-tauri/src/backend/tools.rs` — `safe_join`, used by every file
  tool.
- **What:** the requested path is joined to the workspace root and
  canonicalized; anything that resolves outside the root is rejected. `..`,
  symlinks, and absolute paths are covered by canonicalization.
- **Scope:** this applies to agent file tools. The IDE's own file commands
  (`thalamus_read_file` etc. in `lib.rs`) operate on paths the user selected
  through the UI.

### 5. Permission modes

- **File:** `src-tauri/src/backend/ai.rs` — `shell_allowed`; UI in
  `src/components/ThalamusCopilot.tsx`.
- **Modes:** read-only, plan, ask, safe, auto, autonomous.
- **What:** mutating tools and `run_command` are gated by mode. `run_command` is
  only advertised to the model in `auto` and `autonomous`; sub-agents always run
  read-only (`read_only_specs`).
- **Limits:** in `auto`/`autonomous` the user has, by choice, granted the agent
  the ability to change files and run commands. The mode is the boundary, not a
  sandbox.

### 6. SSRF guard for `read_page`

- **File:** `src-tauri/src/backend/arastir.rs` — `url_allowed`.
- **What:** only `http`/`https`. Loopback, private ranges, link-local,
  unspecified, broadcast, and CGNAT addresses are rejected, as are hostnames
  that resolve to them. The check runs after DNS resolution, so rebinding to a
  private IP is caught.
- **Why this matters:** the local backend sits on `127.0.0.1`; without this
  guard, `read_page` would be a way to reach it.

### 7. Credential vault (DPAPI)

- **File:** `src-tauri/src/secrets.rs`.
- **What:** provider keys are written to the Windows Credential Manager encrypted
  with DPAPI (`CredProtectW`), to a primary and a backup slot. Legacy plaintext
  entries are upgraded on first read. Unreadable blobs are repaired from the
  backup or quarantined, never silently deleted.
- **Limits (from the file's own threat-model note):** DPAPI does **not** protect
  against another process running as the same Windows user — such a process can
  call DPAPI itself. It defeats bulk dumps of credential files and offline
  analysis. Full protection requires OS-level controls (Defender/EDR).

### 8. External-content framing (`frame_external`)

- **File:** `src-tauri/src/backend/tools.rs` — `frame_external`.
- **What:** results from `web_search` and `read_page` over a threshold are wrapped
  in `<external-content>…</external-content>` with an instruction to treat the
  content as data, not instructions. This is a prompt-injection hardening, not a
  guarantee.

### 9. Sensitive environment scrubbing

- **File:** `src-tauri/src/backend/tools.rs` — `is_sensitive_env_name`,
  `strip_sensitive_env`.
- **What:** before `run_command` spawns a shell, variables ending in `_API_KEY`,
  `_ACCESS_KEY`, `_PRIVATE_KEY`, `_SECRET_KEY`, `_TOKEN`, `_SECRET`,
  `_PASSWORD`, `_PASSWD`, `_CREDENTIALS`, `_CREDENTIAL` (plus `API_KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `OPENAI_API_KEY`) are removed from the child
  environment. `PATH`, `SystemRoot`, `TEMP`, `USERPROFILE`, `HOME` are kept.

## Known risks

- **`run_command` is not sandboxed.** It is a real shell running as the user in
  the workspace root. It can read any file the user can read, reach the network,
  and spawn other processes. The permission gate and the visible command log
  (`toolRuns` in the chat, showing command, exit code, and duration) are the
  controls.
- **Prompt injection cannot be fully prevented.** `frame_external` and the
  compression pipeline reduce risk; they do not eliminate it. A model that
  follows injected instructions can still call tools within its permitted mode.
- **DPAPI is per-Windows-user, not per-application.** See control 7.
- **Unsigned installers.** There is no code-signing certificate yet, so
  SmartScreen warns and there is no signature to verify authenticity against —
  only the `SHA256SUMS.txt` published with each release.
- **The local backend trusts the webview.** Once a request carries a valid
  session token it is trusted; the token is the whole authentication scheme.

## Planned hardening

- Code signing for the Windows installers.
- An optional, stricter sandbox for `run_command` (e.g. a restricted token or a
  separate low-privilege process) behind an opt-in setting.
- Structured output validation for tool arguments before execution.
- Rate limiting on the local API to blunt accidental runaway loops.

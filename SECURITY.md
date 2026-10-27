# Security Policy

## Supported versions

Thalamus Desktop is in early beta. Only the current pre-release line receives
security fixes.

| Version | Supported |
|---|---|
| `0.1.0-beta` (current) | ✅ |
| Older pre-releases | ❌ |

## Reporting a vulnerability

If you find a security vulnerability, please report it **privately** rather than
opening a public issue.

- **GitHub private vulnerability reporting (preferred):** open the repository's
  **Security** tab and choose **Report a vulnerability**. This creates a private
  advisory visible only to you and the maintainers.
- **Email:** as a fallback, the maintainer's address is listed in
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [TRADEMARK.md](TRADEMARK.md).
  Please include "Thalamus security" in the subject.

Include a description of the issue, reproduction steps, the app version, and —
if applicable — the error code shown in the app (see [ERRORS.md](ERRORS.md)).

> Response-time commitment: **TODO (maintainer to confirm)**. The intention is
> to acknowledge within 3 business days and to share a remediation plan within
> 10 business days for confirmed issues. This is a goal, not an SLA.

## Scope notes

- Provider API keys are stored in the Windows Credential Manager, encrypted with
  DPAPI, and never leave the machine except in direct requests to the provider
  you configured.
- The local backend binds to `127.0.0.1` only. Report anything that changes that
  assumption, such as a way to make it listen on another interface.
- Agent file tools are restricted to the workspace root; escape paths from that
  sandbox are in scope.
- The agent's tools that deliberately make outbound requests are `web_search`
  and `read_page`; `read_page` applies an SSRF guard. Any way to make it reach
  the local backend or private networks is in scope. `run_command` is not
  sandboxed by design — see [docs/security-model.md](docs/security-model.md).

## What is not a vulnerability

- `run_command` can run arbitrary commands **in `auto`/`autonomous` mode**; that
  is documented behaviour, gated by the permission mode.
- SmartScreen warnings on the unsigned installers (documented in
  [docs/install.md](docs/install.md)).
- Prompt injection through content the user asks the agent to read, unless it
  bypasses a documented control (workspace confinement, SSRF guard, permission
  mode).

For the full model, see [docs/security-model.md](docs/security-model.md).

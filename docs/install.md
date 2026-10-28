# Install and first run

Thalamus Desktop is a Windows desktop application. This page covers installing
it, getting past the SmartScreen warning safely, and fixing the common first-run
problems. Every troubleshooting item below maps to real behaviour in the code or
to a code in [ERRORS.md](../ERRORS.md).

## Requirements

| Item | Requirement | Where it comes from |
|---|---|---|
| OS | Windows 10 or 11 (x64) | The terminal uses Windows PowerShell via `portable-pty` (`src-tauri/src/lib.rs`) |
| WebView2 runtime | Any current version | `tauri.conf.json` does not pin a minimum (`minimumWebview2Version` is unset), and the app sets no webview option that needs a specific build. Windows 10/11 ships a suitable runtime; if it is missing, install it from Microsoft. |
| Disk | A few hundred MB for the app plus your models | — |
| Network | Needed only for remote providers | Local models work offline |

**macOS and Linux are not supported.** They are planned.

## Install

1. Open [GitHub Releases](../../releases) and download the installer for the
   latest beta — either the NSIS `.exe` or the MSI `.msi`. Both install the same
   app.
2. The installer is not code-signed yet, so Windows SmartScreen will show
   *"Windows protected your PC"*.

### Getting past SmartScreen safely

1. In the SmartScreen dialog, click **More info**.
2. Check that the app name is *Thalamus*.
3. Click **Run anyway**.

Because there is no signature to verify, verify the download against the
release's `SHA256SUMS.txt`:

```powershell
Get-FileHash -Algorithm SHA256 .\Thalamus_*.msi
```

The printed hash must match the line for that file in `SHA256SUMS.txt`. If it
does not, delete the file and download it again.

### Installer options

- **Languages:** the NSIS installer ships English and Turkish and uses the OS
  language by default.
- **Install scope:** the current default is per-user (`currentUser`). It is not
  changed for the beta; a machine-wide install would require an elevated
  install mode, which is a separate decision.

## First run

1. The app opens on the chat view with a local profile prompt. This is **not**
   an account — the name stays in `localStorage` and only personalises the UI.
2. Open **Settings → Providers**.
3. Either paste an API key for a remote provider, or point Thalamus at a local
   model (below).
4. Open a project folder from the sidebar to use the IDE and the agent's file
   tools. The agent can only touch files inside this workspace root.

## Connecting a model

### Remote provider

1. **Settings → Providers** → pick a preset (OpenAI, DeepSeek, Gemini, Groq,
   OpenRouter, …) or enter a custom OpenAI-compatible base URL.
2. Paste the key. It is written to the Windows Credential Manager, encrypted
   with DPAPI, not to a config file.
3. Pick a model id and press **Test** to confirm the endpoint and key.

### Local model

Thalamus discovers local runtimes and can start/stop them from Settings:

- **Ollama** — if `ollama.exe` is installed, Thalamus serves downloaded models
  through it (`ollama serve`). It also reuses the `llama-server.exe` that ships
  inside Ollama.
- **llama.cpp** — a standalone `llama-server.exe`, or the copy bundled with LM
  Studio (`.gguf` files). Thalamus can launch a `.gguf` file directly.
- **Python (transformers)** — detected only if Python has `torch`,
  `transformers`, `fastapi`, and `uvicorn` installed.
- **LM Studio** — running its OpenAI-compatible server is detected on the
  usual loopback ports.

Local models idle-shutdown automatically; see **Settings → Local models**.

## Troubleshooting

### "Can't reach the local engine" / error 503

The local backend listens on `127.0.0.1:8277`. If that port is already taken,
the backend cannot start and the app reports the engine as unavailable
(`thalamus_get_engine_status` returns the real start error).

- Find the holder: `Get-NetTCPConnection -LocalPort 8277 | Select-Object OwningProcess`
- Stop it, or start Thalamus with a different port by setting the
  `THALAMUS_PORT` environment variable.
- Restart the app and open **Settings**; the engine status line should read
  *Local compression engine active*.

### WebView2 missing or too old

If the window is blank or the app fails to open, install the
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
Current Windows 10/11 usually has it preinstalled.

### Antivirus / SmartScreen warning

Unsigned installers trigger reputation warnings. Verify the hash as shown
above; if it matches, add an exclusion for the install folder or use
**More info → Run anyway**.

### The key vault rejects or loses a key

Thalamus writes keys to the Windows Credential Manager, encrypted with DPAPI,
with a primary and a backup slot. Symptoms of a vault problem:

- A key you saved is empty on the next launch.
- Error 401 after you re-entered a key.

Steps:

1. Open **Credential Manager → Windows Credentials**.
2. Delete every entry beginning `thalamus:key:` (including `backup:` and
   `quarantine:` slots).
3. Re-enter the key in **Settings → Providers**.

If the issue persists on a non-domain machine, it is usually a profile
corruption; see [docs/security-model.md](security-model.md) for the DPAPI threat
model.

### The agent refuses to run a command

`run_command` is only available in **auto** and **autonomous** permission modes.
Switch the mode in the agent panel. In every other mode the tool is not even
advertised to the model.

### The agent can't see my files

The agent's file tools are confined to the workspace root. Open the folder that
contains the files you want it to read; paths outside it are rejected
(documented as error 403 in [ERRORS.md](../ERRORS.md)).

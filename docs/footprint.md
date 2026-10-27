# Lightweight footprint

This page describes how Thalamus's resource footprint is measured. **No result
numbers are recorded here yet** — they must come from a real run on a named
machine. Do not fill this in from memory or from another app's figures.

## Why measure this

An AI workbench that idles in the background should be light. The numbers that
matter are startup time, idle memory, idle CPU, and install size — not peak
memory during a large request.

## Method

The measurement script is `scripts/measure-footprint.ps1`. It:

1. Optionally launches the app and times until the main window appears.
2. Waits `-IdleSeconds` (default 60) with the app untouched.
3. Records Working Set and Private Bytes.
4. Averages CPU over `-SampleSeconds` (default 10), summed across the process
   tree and normalised by the core count.
5. Repeats `-Runs` times (default 5) and reports the **median** of each metric.
6. Optionally measures the install folder size.

It prints a Markdown table to stdout and writes nothing to disk.

### Measuring Thalamus

```powershell
# Fully installed app, launched fresh each run
.\scripts\measure-footprint.ps1 `
  -ProcessName Thalamus `
  -ExePath "$env:LOCALAPPDATA\Programs\Thalamus\Thalamus.exe" `
  -InstallDir "$env:LOCALAPPDATA\Programs\Thalamus" `
  -Runs 5

# Already running (startup reported as n/a)
.\scripts\measure-footprint.ps1 -ProcessName Thalamus
```

If your install path differs, check the shortcut's target or the Program
Files folder.

### Measuring a comparison app

The same script takes any process name, so you can run the same protocol against
an editor for context:

```powershell
.\scripts\measure-footprint.ps1 -ProcessName Code -Runs 5
.\scripts\measure-footprint.ps1 -ProcessName Cursor -Runs 5
```

Use the same idle period and run count for both, or the comparison is
meaningless.

## Machine information to record

When you fill in the results, include:

| Field | Example |
|---|---|
| CPU | — |
| RAM | — |
| Storage type | SSD / HDD |
| Windows version | — |
| WebView2 version | (Settings, or `Get-AppxPackage *WebView2*`) |
| Thalamus version | — |

## Results

> TODO: run the script on a named machine and paste the printed table here.
> Include the machine information above.

| Metric | Median | Unit |
|---|---:|---|
| Startup (window visible) | TODO | s |
| Working set (idle 60 s) | TODO | MB |
| Private bytes (idle 60 s) | TODO | MB |
| Average CPU (idle) | TODO | % |
| Install folder | TODO | MB |

### Comparison (optional)

> TODO: same protocol on the same machine for a comparison app.

## Limitations

- Working Set and Private Bytes are sampled once per run, not tracked over time;
  a periodic peak is not captured.
- Startup is "process started → main window has a handle", which includes
  WebView2 initialisation and can vary with disk cache state.
- CPU is averaged over a short idle window; a single background task during the
  sample will skew it upward.

# Lightweight footprint measurement
#
# Measures startup time, idle memory (working set and private bytes), average
# CPU, and install-folder size for a running application process.
#
# Usage:
#   .\scripts\measure-footprint.ps1 -ProcessName Thalamus
#   .\scripts\measure-footprint.ps1 -ProcessName Thalamus -InstallDir "C:\Program Files\Thalamus"
#   .\scripts\measure-footprint.ps1 -ProcessName Code -Runs 5     # comparison run
#
# The "startup" number needs the process to be closed before the script starts
# it. Pass -ExePath to let the script launch it; otherwise it only measures an
# already-running process (startup is reported as "n/a").
#
# Nothing is written to disk; the Markdown table goes to stdout.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProcessName,

    # Optional: launch this executable and time until the main window appears.
    [string]$ExePath,

    # Optional: measure the size of this folder (e.g. the install directory).
    [string]$InstallDir,

    # Number of runs; the median is reported.
    [int]$Runs = 5,

    # Seconds to let the app sit idle before sampling memory/CPU.
    [int]$IdleSeconds = 60,

    # Sampling interval for the idle CPU average.
    [int]$SampleSeconds = 10
)

$ErrorActionPreference = 'Stop'

# Markdown tablosu makine dilinden bagimsiz olsun: ondalik ayirici nokta.
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function N([object]$v) { if ($null -eq $v) { 'n/a' } else { $v.ToString($inv) } }

function Get-MainProcess {
    param([string]$Name)
    Get-Process -Name $Name -ErrorAction SilentlyContinue |
        Sort-Object -Property WorkingSet64 -Descending |
        Select-Object -First 1
}

function Wait-ForWindow {
    param([int]$ProcessId, [int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $p) { return $false }
        if ($p.MainWindowHandle -ne 0) { return $true }
        Start-Sleep -Milliseconds 150
    }
    return $false
}

function Measure-Startup {
    param([string]$Path)
    if (-not $Path) { return $null }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Path -PassThru
    $ok = Wait-ForWindow -ProcessId $proc.Id
    $sw.Stop()
    if (-not $ok) { return $null }
    return [math]::Round($sw.Elapsed.TotalSeconds, 2)
}

function Measure-Idle {
    param([int]$ProcessId, [int]$Idle, [int]$Sample)
    Start-Sleep -Seconds $Idle
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }

    $wsMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $privateMb = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)

    # CPU percent sampled over a window, summed across the process tree.
    $tree = Get-CimInstance Win32_Process -Filter "Name = '$($p.ProcessName).exe'" |
        Select-Object -ExpandProperty ProcessId
    $samples = @()
    for ($i = 0; $i -lt $Sample; $i++) {
        $t1 = @{}
        foreach ($id in $tree) {
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc) { $t1[$id] = $proc.TotalProcessorTime.TotalMilliseconds }
        }
        Start-Sleep -Seconds 1
        $delta = 0.0
        foreach ($id in $tree) {
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc -and $t1.ContainsKey($id)) {
                $delta += ($proc.TotalProcessorTime.TotalMilliseconds - $t1[$id])
            }
        }
        $samples += ($delta / 1000.0) * 100.0 / [Environment]::ProcessorCount
    }
    $avgCpu = if ($samples.Count) {
        [math]::Round(($samples | Measure-Object -Average).Average, 1)
    } else { $null }

    return [pscustomobject]@{
        WorkingSetMB = $wsMb
        PrivateMB    = $privateMb
        CpuPercent   = $avgCpu
    }
}

function Get-FolderSizeMb {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path $Path)) { return $null }
    $bytes = (Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { return $null }
    return [math]::Round($bytes / 1MB, 1)
}

function Get-Median {
    param([object[]]$Values)
    $clean = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
    # Dikkat: 0 gecerli bir olcumdur; -not $clean onu yanlislikla elerdi.
    if ($clean.Count -eq 0) { return $null }
    $mid = [math]::Floor($clean.Count / 2)
    if ($clean.Count % 2 -eq 1) { return $clean[$mid] }
    return [math]::Round((($clean[$mid - 1] + $clean[$mid]) / 2), 2)
}

$startups = @()
$working = @()
$private = @()
$cpus = @()

for ($run = 1; $run -le $Runs; $run++) {
    Write-Host "run $run/$Runs" -NoNewline
    $proc = $null
    if ($ExePath) {
        Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        $startup = Measure-Startup -Path $ExePath
        $startups += $startup
        Write-Host (" startup={0}s" -f (N $startup)) -NoNewline
        $proc = Get-MainProcess -Name $ProcessName
    } else {
        $proc = Get-MainProcess -Name $ProcessName
    }

    if ($null -eq $proc) {
        Write-Host " (process not found)"
        continue
    }

    $idle = Measure-Idle -ProcessId $proc.Id -Idle $IdleSeconds -Sample $SampleSeconds
    if ($null -ne $idle) {
        $working += $idle.WorkingSetMB
        $private += $idle.PrivateMB
        $cpus += $idle.CpuPercent
        Write-Host (" mem={0}MB private={1}MB cpu={2}%" -f (N $idle.WorkingSetMB), (N $idle.PrivateMB), (N $idle.CpuPercent))
    } else {
        Write-Host " (process exited during measurement)"
    }

    if ($ExePath) {
        Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
}

$installMb = Get-FolderSizeMb -Path $InstallDir

$startupMedian = Get-Median $startups
$workingMedian = Get-Median $working
$privateMedian = Get-Median $private
$cpuMedian = Get-Median $cpus

Write-Host ""
Write-Host "## Footprint: $ProcessName ($Runs runs)"
Write-Host ""
Write-Host "| Metric | Median | Unit |"
Write-Host "|---|---:|---|"
Write-Host ("| Startup (window visible) | {0} | s |" -f (N $startupMedian))
Write-Host ("| Working set (idle {0}s) | {1} | MB |" -f $IdleSeconds, (N $workingMedian))
Write-Host ("| Private bytes (idle {0}s) | {1} | MB |" -f $IdleSeconds, (N $privateMedian))
Write-Host ("| Average CPU (idle) | {0} | % |" -f (N $cpuMedian))
Write-Host ("| Install folder | {0} | MB |" -f (N $installMb))

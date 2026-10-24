<#
.SYNOPSIS
  Runs one k6 scenario against the API on a deliberately small, resource-capped "server".

.EXAMPLE
  .\Run-LoadTest.ps1 -Profile tiny -Script mixed -Stages "5:20,10:30,20:30,40:30" -Label baseline-tiny
  .\Run-LoadTest.ps1 -Profile small -Script ws -Env @{ SUBS = 200; WRITE_RPS = 5; HOLD = 60 }

.NOTES
  Profiles (what typical cheap hosts give you):
    micro  0.25 vCPU /  256 MB   free-tier container
    tiny   0.50 vCPU /  512 MB   entry paid plan   <- the default we tune for
    small  1.00 vCPU / 1024 MB   next step up
    none   no limits             reference: what this machine can really do
  The load generator (k6) is pinned to different cores than the server, so it can't steal the server's CPU.
#>
param(
  [ValidateSet('micro', 'tiny', 'small', 'none')] [string] $Profile = 'tiny',
  [ValidateSet('mixed', 'ws', 'login')] [string] $Script = 'mixed',
  [string] $Stages = '',
  [hashtable] $Env = @{},
  [string] $Label = '',
  [int] $Port = 4200,
  [switch] $KeepDb          # reuse the DB left by the previous run instead of restoring the pristine copy
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\Limit-Process.ps1"

$root = Split-Path $PSScriptRoot -Parent
$server = Join-Path $root 'server'
$dbDir = Join-Path $env:LOCALAPPDATA 'taskflow-loadtest'   # outside OneDrive: don't sync 700 MB of test data
$k6 = Get-ChildItem (Join-Path $PSScriptRoot 'tools\k6') -Recurse -Filter k6.exe | Select-Object -First 1 -ExpandProperty FullName
if (-not $k6) { throw 'k6.exe not found under loadtest\tools\k6' }
$profiles = @{
  micro = @{ Cpu = 0.25; Mem = 256;  Heap = 150 }
  tiny  = @{ Cpu = 0.5;  Mem = 512;  Heap = 320 }
  small = @{ Cpu = 1.0;  Mem = 1024; Heap = 700 }
  none  = @{ Cpu = 0;    Mem = 0;    Heap = 4096 }
}
$p = $profiles[$Profile]
if (-not $Label) { $Label = "$Script-$Profile-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
$out = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Force $out | Out-Null

# --- 1. data ---
if (-not $KeepDb) {
  Write-Host 'Restoring pristine database...'
  Copy-Item (Join-Path $dbDir 'load.base.db') (Join-Path $dbDir 'load.db') -Force
  Remove-Item (Join-Path $dbDir 'load.db-journal'), (Join-Path $dbDir 'load.db-wal'), (Join-Path $dbDir 'load.db-shm') -ErrorAction SilentlyContinue
}

# --- 2. server environment (same variables a production deploy would set) ---
Get-Content (Join-Path $server '.env.load') | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item "env:$($k.Trim())" ($v.Trim().Trim('"'))
}
$env:PORT = "$Port"
$env:DATABASE_URL = ($env:DATABASE_URL)  # from .env.load
foreach ($kv in $Env.GetEnumerator()) { if ($kv.Key -like 'SERVER_*') { Set-Item "env:$($kv.Key.Substring(7))" "$($kv.Value)" } }

# --- 3. start the server under limits ---
$nodeArgs = @("--max-old-space-size=$($p.Heap)", '--import', 'tsx', 'src/index.ts')
$log = Join-Path $out "$Label.server.log"
Write-Host "Starting API  profile=$Profile  cpu=$($p.Cpu) core(s)  mem=$($p.Mem) MB  heap<=$($p.Heap) MB"
if ($Profile -eq 'none') {
  $srv = Start-Process node -ArgumentList $nodeArgs -WorkingDirectory $server -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
} else {
  $srv = Start-LimitedProcess -File node -Args $nodeArgs -CpuCores $p.Cpu -MemoryMB $p.Mem -Core 2 -WorkingDirectory $server -StdOut $log -StdErr "$log.err"
}
$up = $false
for ($i = 0; $i -lt 120 -and -not $srv.HasExited; $i++) {
  try { if ((Invoke-RestMethod "http://localhost:$Port/healthz" -TimeoutSec 2).ok) { $up = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) { Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 15; if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }; throw 'API did not become healthy' }
Write-Host "API up (pid $($srv.Id))"

# --- 4. run k6, sampling the server's CPU and memory once a second ---
$k6Args = @('run', '--summary-export', (Join-Path $out "$Label.k6.json"), '-e', "BASE_URL=http://localhost:$Port")
if ($Stages) { $k6Args += @('-e', "STAGES=$Stages") }
foreach ($kv in $Env.GetEnumerator()) { if ($kv.Key -notlike 'SERVER_*') { $k6Args += @('-e', "$($kv.Key)=$($kv.Value)") } }
$k6Args += (Join-Path $PSScriptRoot "k6\$Script.js")
# Start-Process does not quote array elements: our paths contain spaces.
$k6Args = @($k6Args | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } })
$k6proc = Start-Process $k6 -ArgumentList $k6Args -WorkingDirectory (Join-Path $PSScriptRoot 'k6') -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $out "$Label.k6.txt") -RedirectStandardError (Join-Path $out "$Label.k6.err")
# every core from 6 up: nowhere near the server (core 2), whatever the machine's core count
$allCores = (1L -shl [Environment]::ProcessorCount) - 1
$k6proc.ProcessorAffinity = [IntPtr]($allCores -band (-bnot 0x3FL))

$csv = Join-Path $out "$Label.monitor.csv"
try {
'second,cpu_pct_of_core,rss_mb,private_mb' | Set-Content $csv
$t0 = Get-Date; $prevCpu = $srv.TotalProcessorTime.TotalSeconds; $prevT = $t0; $crashed = $false
while (-not $k6proc.HasExited) {
  Start-Sleep -Seconds 1
  if ($srv.HasExited) { $crashed = $true; Write-Warning "SERVER EXITED (code $($srv.ExitCode)) - likely killed by the memory cap"; Stop-Process -Id $k6proc.Id -Force; break }
  $srv.Refresh(); $now = Get-Date; $cpu = $srv.TotalProcessorTime.TotalSeconds
  $pct = ($cpu - $prevCpu) / (($now - $prevT).TotalSeconds) * 100
  '{0:N0},{1:N0},{2:N0},{3:N0}' -f ($now - $t0).TotalSeconds, $pct, ($srv.WorkingSet64 / 1MB), ($srv.PrivateMemorySize64 / 1MB) | Add-Content $csv
  $prevCpu = $cpu; $prevT = $now
}
} finally {
  if ($k6proc -and -not $k6proc.HasExited) { Stop-Process -Id $k6proc.Id -Force }
  if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
}

# --- 5. report ---
Write-Host "`n===== k6 output (tail) ====="
Get-Content (Join-Path $out "$Label.k6.txt") -Tail 70
$stepsArg = ''
if ($Env.ContainsKey('STEPS')) { $stepsArg = "$($Env.STEPS):$(if ($Env.ContainsKey('STEP_SECS')) { $Env.STEP_SECS } else { 45 })" }
$report = node (Join-Path $PSScriptRoot 'summarize.mjs') (Join-Path $out "$Label.k6.json") $csv $Profile $(if ($crashed) { 'CRASHED' } else { 'ok' }) $stepsArg
$report | Set-Content -Encoding utf8 (Join-Path $out "$Label.md")   # (Tee-Object would write UTF-16)
$report
Write-Host "`nSaved: $out\$Label.*"

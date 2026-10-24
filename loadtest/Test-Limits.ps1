# Proves the limiter works before we trust any result produced under it:
# a CPU-burning process must get ~the requested share of a core, and a memory hog must be stopped at the cap.
param([double] $CpuCores = 0.5, [int] $MemoryMB = 256)
. "$PSScriptRoot\Limit-Process.ps1"

Write-Host "== CPU: burning for 8s under a cap of $CpuCores core(s) =="
$p = Start-LimitedProcess -File node -Args '-e', 'const t=Date.now();while(Date.now()-t<8000){}' -CpuCores $CpuCores -MemoryMB 512 -Core 2
$p.WaitForExit()
$cpuSeconds = $p.TotalProcessorTime.TotalSeconds
$wall = ($p.ExitTime - $p.StartTime).TotalSeconds
"{0:N1}s of CPU in {1:N1}s wall = {2:N0}% of one core (target {3:N0}%)" -f $cpuSeconds, $wall, ($cpuSeconds / $wall * 100), ($CpuCores * 100)

Write-Host "`n== Memory: allocating past the $MemoryMB MB cap =="
$m = Start-LimitedProcess -File node -Args '-e', "const a=[];for(let i=0;i<2000;i++){a.push(Buffer.alloc(8*1024*1024,1));if(i%10==0)console.log('allocated '+(i*8)+' MB')}" -CpuCores 2 -MemoryMB $MemoryMB -Core 3 -StdOut "$env:TEMP\memtest.out" -StdErr "$env:TEMP\memtest.err"
$m.WaitForExit()
$last = (Get-Content "$env:TEMP\memtest.out" -ErrorAction SilentlyContinue | Select-Object -Last 1)
"exit code $($m.ExitCode); last progress line: $last"
if ($m.ExitCode -ne 0) { "-> stopped by the cap, as intended" } else { "-> NOT stopped: the memory limit is not working" }

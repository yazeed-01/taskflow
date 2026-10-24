# Runs a process under hard CPU and memory limits using a Windows Job Object — the OS mechanism behind
# container limits on Windows. Docker isn't needed.
#
#   . .\Limit-Process.ps1
#   $p = Start-LimitedProcess -File node -Args '...' -CpuCores 0.5 -MemoryMB 512 -Core 0
#
# CPU:    hard cap (a thread is paused for the rest of the scheduling interval once the budget is spent) AND
#         pinned to one logical core. CpuCores=0.5 means "half of one core", like a 0.5 vCPU container.
# Memory: hard cap on committed memory. Exceeding it makes allocations fail (the process crashes), as in an OOM kill.
# Caveat: this limits the *process*. The OS file cache is not limited, so a database that would not fit in a
#         512 MB container's page cache is served faster here than it would be there.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JobLimit {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED {
    public BASIC Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct CPURATE { public uint ControlFlags; public uint CpuRate; }

  // cpuRate: 1..10000 = hundredths of a percent of TOTAL system CPU. memoryBytes: hard cap.
  public static bool Apply(IntPtr process, uint cpuRate, ulong memoryBytes, ulong affinityMask) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var ext = new EXTENDED();
    // 0x100 process memory | 0x200 job memory | 0x10 affinity | 0x2000 kill when the job handle closes
    ext.Basic.LimitFlags = 0x100 | 0x200 | 0x10 | 0x2000;
    ext.ProcessMemoryLimit = (UIntPtr)memoryBytes;
    ext.JobMemoryLimit = (UIntPtr)memoryBytes;
    ext.Basic.Affinity = (UIntPtr)affinityMask;
    int size = Marshal.SizeOf(typeof(EXTENDED));
    IntPtr p = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(ext, p, false);
    bool ok = SetInformationJobObject(job, 9, p, (uint)size); // JobObjectExtendedLimitInformation
    Marshal.FreeHGlobal(p);
    if (!ok) return false;

    var rate = new CPURATE { ControlFlags = 0x1 | 0x4, CpuRate = cpuRate }; // ENABLE | HARD_CAP
    IntPtr q = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CPURATE)));
    Marshal.StructureToPtr(rate, q, false);
    ok = SetInformationJobObject(job, 15, q, (uint)Marshal.SizeOf(typeof(CPURATE))); // JobObjectCpuRateControlInformation
    Marshal.FreeHGlobal(q);
    if (!ok) return false;
    return AssignProcessToJobObject(job, process);
  }
}
'@

function Start-LimitedProcess {
  param(
    [Parameter(Mandatory)] [string] $File,
    [string[]] $Args = @(),
    [double] $CpuCores = 0.5,   # fraction of ONE core (0.5 = half a core)
    [int] $MemoryMB = 512,
    [int] $Core = 0,            # which logical core to pin to
    [string] $WorkingDirectory = (Get-Location).Path,
    [string] $StdOut,
    [string] $StdErr
  )
  $logical = [Environment]::ProcessorCount
  $mask = [uint64]1 -shl $Core
  # CpuRate is relative to the whole machine, so "0.5 of one core" on a 20-core box is 0.5/20 = 2.5% = 250 units.
  $rate = [uint32][math]::Max(1, [math]::Min(10000, [math]::Round($CpuCores / $logical * 10000)))

  $sp = @{ FilePath = $File; WorkingDirectory = $WorkingDirectory; PassThru = $true; NoNewWindow = $true }
  # Start-Process does not quote array elements, so quote any that contain whitespace.
  if ($Args.Count) { $sp.ArgumentList = @($Args | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) }
  if ($StdOut) { $sp.RedirectStandardOutput = $StdOut }
  if ($StdErr) { $sp.RedirectStandardError = $StdErr }
  $proc = Start-Process @sp
  if (-not [JobLimit]::Apply($proc.Handle, $rate, [uint64]$MemoryMB * 1MB, $mask)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Stop-Process -Id $proc.Id -Force
    throw "Could not apply job limits (Win32 error $err)"
  }
  return $proc
}

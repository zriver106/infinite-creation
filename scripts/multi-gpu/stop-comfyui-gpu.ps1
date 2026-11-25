# ic29 多显卡：停止某个附加 ComfyUI 实例（按端口找监听进程）。拒绝停 8189。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File stop-comfyui-gpu.ps1 -Port 8190 [-DryRun]
param([Parameter(Mandatory = $true)][int]$Port, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
if ($Port -eq 8189) { throw "[refuse] 8189 是现有实例，本脚本不处理" }
$conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if (-not $conns.Count) { Write-Host "端口 $Port 没有监听进程"; exit 0 }
foreach ($c in $conns) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  Write-Host ("PID {0}: {1}" -f $p.ProcessId, $p.CommandLine)
  if ($p.CommandLine -notmatch "--port $Port") { throw "[refuse] PID $($p.ProcessId) 不像是端口 $Port 的 ComfyUI 实例" }
  if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Confirm:$false; Write-Host "已停止 PID $($p.ProcessId)" }
}

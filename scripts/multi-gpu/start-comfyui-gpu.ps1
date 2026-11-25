# ic29 多显卡：为第 N 张卡分离启动一个 ComfyUI 实例（与 start-comfyui.ps1 同样走 WMI Win32_Process Create）。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-comfyui-gpu.ps1 -Gpu 1 -Port 8190 -DryRun   # 只做检查、打印命令
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-comfyui-gpu.ps1 -Gpu 1 -Port 8190           # 检查通过后启动
# 安全检查（任何一项不过就拒绝启动；-Force 只跳过「显存已被占用」这一项）：
#   1) 端口不能是 8189、不能已在监听；
#   2) nvidia-smi 必须能看到第 Gpu 张卡（本机只有 1 张卡时 -Gpu 1 会被拒绝，不会退化成 CPU 或挤到 GPU 0）；
#   3) 目标卡已用显存 > 4 GB 视为已有实例/其它程序在用（防止误绑到 8189 正在出片的那张卡）。
# 启动成功后：在 IC「设置 → ComfyUI 服务」添加端点 http://127.0.0.1:<Port>、显卡 <Gpu>，测试连接后打开启用开关并保存。
param(
  [Parameter(Mandatory = $true)][int]$Gpu,
  [Parameter(Mandatory = $true)][int]$Port,
  [switch]$DryRun,
  [switch]$Force,
  [int]$WaitSec = 300
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'run-comfyui-gpu.cmd'

function Test-Port($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

if ($Port -eq 8189) { throw "[refuse] 8189 是现有 ComfyUI 实例的端口，新实例请用 8190 起" }
if (Test-Port $Port) { throw "[refuse] 端口 $Port 已在监听" }

$smi = & nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used --format=csv,noheader,nounits 2>$null
if (-not $smi) { throw "[refuse] nvidia-smi 不可用" }
$gpus = @($smi | ForEach-Object {
  $f = $_.Split(',') | ForEach-Object { $_.Trim() }
  [pscustomobject]@{ Index = [int]$f[0]; Uuid = $f[1]; Name = $f[2]; TotalMB = [int]$f[3]; UsedMB = [int]$f[4] }
})
Write-Host ("本机显卡 {0} 张：" -f $gpus.Count)
$gpus | ForEach-Object { Write-Host ("  [{0}] {1}  {2}/{3} MiB  {4}" -f $_.Index, $_.Name, $_.UsedMB, $_.TotalMB, $_.Uuid) }
$target = $gpus | Where-Object { $_.Index -eq $Gpu }
if (-not $target) { throw "[refuse] 没有第 $Gpu 张卡（nvidia-smi 只看到 $($gpus.Count) 张）。插卡后再启动。" }
if ($target.UsedMB -gt 4096 -and -not $Force) {
  throw "[refuse] GPU $Gpu 已用 $($target.UsedMB) MiB，疑似已有 ComfyUI（例如 8189）或其它程序在用。确认无误再加 -Force。"
}
if ($Gpu -eq 0 -and -not $Force) {
  throw "[refuse] GPU 0 是现有 8189 实例所在的卡（8189 未显式绑卡，Windows 下 ComfyUI 默认只用第 0 张）。确需在 GPU 0 上开第二个实例请加 -Force（H3 单任务已占约 28 GB，32 GB 卡上不建议）。"
}

$cmdLine = "cmd.exe /c `"`"$runner`" $Gpu $Port`""
Write-Host "将启动：$cmdLine"
Write-Host "实例目录：C:\tmp_infinite_creation\ComfyUI_instances\gpu${Gpu}_$Port （input/output/temp/user/logs）"
if ($DryRun) { Write-Host '[dry-run] 检查通过，未启动'; exit 0 }

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $here }
if ($r.ReturnValue -ne 0) { throw "启动失败（WMI 返回 $($r.ReturnValue)）" }
$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Port $Port) { Write-Host "[ok] ComfyUI GPU $Gpu 已就绪：http://127.0.0.1:$Port"; exit 0 }
  Start-Sleep -Seconds 1
}
throw "端口 $Port 在 $WaitSec 秒内未就绪；查看 C:\tmp_infinite_creation\ComfyUI_instances\gpu${Gpu}_$Port\logs\comfyui-$Port.log"

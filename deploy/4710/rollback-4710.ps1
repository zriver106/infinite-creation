# Roll 4710 back to the original run-frontend.cmd (live studio\dist, untouched by the switch). Target < 60 s.
param([string]$Archive = '')
$ROOT = 'C:\tmp_infinite_creation'
$OLDJS = 'index-3PFBhChK.js'
$LOG = if ($Archive) { "$Archive\rollback.log" } else { "C:\Users\usazr\Documents\moviePro\_\4710_rollback_$(Get-Date -Format 'yyyyMMdd_HHmmss').log" }
function L($m) { $l = "$(Get-Date -Format 'HH:mm:ss.fff') $m"; Write-Host $l; Add-Content -Path $LOG -Value $l }
function Listener($p) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique }
$t0 = Get-Date
L 'rollback start'
# if the archive has run-frontend.cmd and the live one differs, restore it (the switch never edits it, so normally no-op)
if ($Archive -and (Test-Path "$Archive\run-frontend.cmd")) {
  if ((Get-FileHash "$Archive\run-frontend.cmd" -Algorithm MD5).Hash -ne (Get-FileHash "$ROOT\run-frontend.cmd" -Algorithm MD5).Hash) { Copy-Item "$ROOT\run-frontend.cmd" "$Archive\run-frontend.cmd.changed_$(Get-Date -Format HHmmss)"; Copy-Item "$Archive\run-frontend.cmd" "$ROOT\run-frontend.cmd" -Force; L 'restored run-frontend.cmd from archive' }
}
foreach ($p in (Listener 4710)) {
  $o = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if ($o.CommandLine -match 'studio_4710_command_20261123') { Stop-Process -Id $p -Force; L "stopped new 4710 pid $p" }
  elseif ($o.CommandLine -match 'node_modules\\vite\\bin\\vite\.js preview\s*$') { L "4710 already the original ($p); nothing to do"; exit 0 }
  else { L "ABORT: unknown process on 4710: $p $($o.CommandLine)"; exit 2 }
}
for ($i = 0; $i -lt 20 -and (Listener 4710); $i++) { Start-Sleep -Milliseconds 250 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$ROOT\run-frontend.cmd`""; CurrentDirectory = $ROOT }
L "WMI create return $($r.ReturnValue)"
for ($i = 0; $i -lt 80 -and -not (Listener 4710); $i++) { Start-Sleep -Milliseconds 500 }
$ok = $false; try { $ok = (Invoke-WebRequest 'http://127.0.0.1:4710/' -UseBasicParsing -TimeoutSec 10).Content -match [regex]::Escape($OLDJS) } catch {}
$np = Listener 4710
L ("rollback " + ($(if ($ok) { 'OK' } else { 'CHECK FAILED' })) + " pid $np in " + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + ' s')
if (-not $ok) { exit 1 }

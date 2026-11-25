# Switch 4710 from the live Studio (run-frontend.cmd) to "Studio + command" (run-frontend-command.cmd).
# Touches nothing but PID 29372 (after cmdline check). Does not touch 4610 / config.json / live dist.
# On any failed self-check it runs rollback-4710.ps1 automatically.
$ErrorActionPreference = 'Stop'
$N    = 'C:\tmp_infinite_creation\studio_4710_command_20261123'
$ROOT = 'C:\tmp_infinite_creation'
$IC   = "$ROOT\infinite-creation"
$OLDPID = 29372
$NEWJS = (Select-String -Path "$N\dist\index.html" -Pattern 'index-[A-Za-z0-9_-]+\.js').Matches[0].Value
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$ARC = "C:\Users\usazr\Documents\moviePro\_\4710_switch_backup_$stamp"
New-Item -ItemType Directory $ARC -Force | Out-Null
$LOG = "$ARC\switch.log"
function L($m) { $l = "$(Get-Date -Format 'HH:mm:ss.fff') $m"; Write-Host $l; Add-Content -Path $LOG -Value $l }
function Listener($p) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique }
function Get200($u) { try { $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 15; return $r } catch { return $null } }

L "switch start; archive $ARC"
# 0. preconditions
if (-not (Get200 'http://127.0.0.1:4610/api/health')) { L 'ABORT: 4610 not healthy, nothing changed'; exit 2 }
if (-not (Get200 'http://127.0.0.1:4620/api/command/ov?part=sessions')) { L 'ABORT: 4620 command preview not answering, nothing changed'; exit 2 }
if (-not (Test-Path "$N\dist\assets\$NEWJS")) { L 'ABORT: new dist missing'; exit 2 }
$o = Get-CimInstance Win32_Process -Filter "ProcessId=$OLDPID"
if (-not $o -or $o.CommandLine -notmatch 'node_modules\\vite\\bin\\vite\.js preview\s*$') { L "ABORT: PID $OLDPID cmdline mismatch: $($o.CommandLine)"; exit 2 }
$par = Get-CimInstance Win32_Process -Filter "ProcessId=$($o.ParentProcessId)"
if (-not $par -or $par.CommandLine -notmatch 'run-frontend\.cmd') { L "ABORT: parent of $OLDPID is not run-frontend.cmd: $($par.CommandLine)"; exit 2 }
if ((Listener 4710) -notcontains $OLDPID) { L "ABORT: 4710 listener is not $OLDPID"; exit 2 }
L "precheck ok: $OLDPID '$($o.CommandLine)' parent $($par.ProcessId) '$($par.CommandLine)'"

# 1. backup (copy only)
Copy-Item "$IC\studio\dist" "$ARC\studio_dist" -Recurse
Copy-Item "$IC\studio\vite.config.js", "$ROOT\run-frontend.cmd", "$ROOT\ic-env.cmd", "$ROOT\start-studio.ps1", "$ROOT\stop-studio.ps1" $ARC
"$OLDPID`t$($o.CommandLine)`t$($o.CreationDate)`nparent $($par.ProcessId)`t$($par.CommandLine)" | Out-File "$ARC\old_process.txt" -Encoding ascii
$h = Get-ChildItem $ARC -Recurse -File | ? { $_.Name -notin 'switch.log','md5.txt' } | % { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm MD5).Hash, $_.FullName.Substring($ARC.Length + 1) }
[IO.File]::WriteAllText("$ARC\md5.txt", (($h -join "`n") + "`n"))
L "backup done ($($h.Count) files)"

# 2. stop only the old 4710 node (re-check right before)
$o2 = Get-CimInstance Win32_Process -Filter "ProcessId=$OLDPID"
if ($o2.CommandLine -ne $o.CommandLine) { L 'ABORT: cmdline changed between checks'; exit 2 }
$t0 = Get-Date
Stop-Process -Id $OLDPID -Force
L "stopped $OLDPID"
for ($i = 0; $i -lt 20 -and (Listener 4710); $i++) { Start-Sleep -Milliseconds 250 }

# 3. start new build the same way start-studio.ps1 does (WMI, detached)
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$N\run-frontend-command.cmd`""; CurrentDirectory = $ROOT }
L "WMI create return $($r.ReturnValue) pid $($r.ProcessId)"
$ok = $false
for ($i = 0; $i -lt 60; $i++) { if (Listener 4710) { $ok = $true; break }; Start-Sleep -Milliseconds 500 }
$t1 = Get-Date
L ("4710 listening=" + $ok + " downtime " + [math]::Round(($t1 - $t0).TotalSeconds, 1) + " s")

# 4. self-check
$fail = @()
if (-not $ok) { $fail += 'not listening' } else {
  $hp = Get200 'http://127.0.0.1:4710/'
  if (-not $hp -or $hp.Content -notmatch [regex]::Escape($NEWJS)) { $fail += 'index.html is not the new build' }
  $hl = Get200 'http://127.0.0.1:4710/api/health'; if (-not $hl) { $fail += '/api/health via 4710 failed' }
  $pj = Get200 'http://127.0.0.1:4710/api/projects'; if (-not $pj) { $fail += '/api/projects via 4710 failed' }
  $cm = Get200 'http://127.0.0.1:4710/api/command/ov?part=sessions'; if (-not $cm -or $cm.Content -notmatch '"ok":true') { $fail += 'command overview via 4710 failed' }
  try { Invoke-WebRequest 'http://127.0.0.1:4710/api/command/ov' -Method Post -UseBasicParsing -TimeoutSec 10 | Out-Null; $fail += 'POST /api/command not refused' } catch { if ($_.Exception.Response.StatusCode.value__ -ne 403) { $fail += "POST /api/command gave $($_.Exception.Response.StatusCode.value__) not 403" } }
}
$np = Listener 4710
if ($np) { $no = Get-CimInstance Win32_Process -Filter "ProcessId=$($np | Select-Object -First 1)"; L "new 4710 pid $($no.ProcessId) cmd '$($no.CommandLine)'" }
if ($fail.Count) {
  L ("SELF-CHECK FAILED: " + ($fail -join '; ') + " -> rollback")
  & "$N\rollback-4710.ps1" -Archive $ARC
  exit 1
}
L 'SELF-CHECK OK: switched'
exit 0

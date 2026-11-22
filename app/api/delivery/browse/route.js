// 选文件夹：由后端在本机弹出 Windows 系统「选择文件夹」对话框，返回选中的绝对路径（不保存，保存走 PUT /api/projects/:id/delivery）。
// IC 不是 Electron，浏览器拿不到文件夹的绝对路径，所以只能由后端弹窗；界面同时保留手动填路径。
// 限制：对话框弹在运行后端的那台机器、那个登录会话里。后端若以隐藏窗口或服务方式运行，可能看不到窗口——
// 这时等超时（120 秒）返回 timeout，用手动填路径即可。同一时刻只允许一个对话框。
import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 120 * 1000;
let inflight = false;

const PS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description = '选择交付目录（无限创作）'",
  '$d.ShowNewFolderButton = $true',
  '$r = $d.ShowDialog($owner)',
  "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('OK:' + $d.SelectedPath) } else { Write-Output 'CANCEL' }",
].join('; ');

export async function POST() {
  if (process.platform !== 'win32') {
    return NextResponse.json({ error: '只有 Windows 本机部署支持弹出选文件夹窗口，请手动填写路径' }, { status: 501 });
  }
  if (inflight) return NextResponse.json({ error: '已有一个选文件夹窗口打开着，请先在那个窗口里选择或取消' }, { status: 409 });
  inflight = true;
  try {
    const out = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        { timeout: TIMEOUT_MS, windowsHide: false, encoding: 'utf8', maxBuffer: 1 << 20 },
        (err, stdout) => resolve({ err, stdout: String(stdout || '') }),
      );
    });
    const line = out.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('OK:') || l === 'CANCEL') || '';
    if (line.startsWith('OK:')) return NextResponse.json({ path: line.slice(3) });
    if (line === 'CANCEL') return NextResponse.json({ cancelled: true });
    if (out.err && out.err.killed) return NextResponse.json({ timeout: true, error: '选文件夹窗口 120 秒内没有响应（可能弹在了看不见的会话里），请手动填写路径' });
    return NextResponse.json({ error: '弹出选文件夹窗口失败，请手动填写路径' + (out.err && out.err.message ? '：' + out.err.message : '') }, { status: 500 });
  } finally {
    inflight = false;
  }
}

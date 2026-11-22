import { useEffect, useState } from 'react';
import { FolderOpen, Save } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, Checkbox, Field, Input, Select, Spinner } from './ui.jsx';
import { useToast } from './toast.jsx';

// 「系统设置 - 通用配置」里的「交付目录」：按项目保存（projects.context.delivery_dir / delivery_enabled），
// 不写 config.json。项目选择默认是最近打开的项目（ProjectWorkspace 记在 localStorage 的 ic:lastProjectId）。
// 「选择文件夹…」由后端在本机弹系统对话框（IC 不是 Electron，浏览器拿不到绝对路径）；也可以直接手填路径。
// 规则：某章成片导出成功、且启用时，主成片复制为 <交付目录>\EP<N>.mp4（N 只从章名「第N章」解析，解析不到跳过）；
// 覆盖前旧 EP<N>.mp4 先归档到 历史候选\IC自动交付归档\ 并核 sha256。失败只报错，不影响合成。
function lastProjectId() {
  try {
    return localStorage.getItem('ic:lastProjectId') || '';
  } catch {
    return '';
  }
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export default function DeliverySettings() {
  const toast = useToast();
  const [projects, setProjects] = useState(null);
  const [pid, setPid] = useState('');
  const [loaded, setLoaded] = useState(null); // 该项目已保存的 { dir, enabled, log }
  const [dir, setDir] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get('/api/projects?type=agent&pageSize=100')
      .then((r) => {
        if (!alive) return;
        const items = (r && r.items) || [];
        setProjects(items);
        const want = lastProjectId();
        setPid(items.some((p) => p.id === want) ? want : items[0] ? items[0].id : '');
      })
      .catch((e) => alive && setErr('项目列表加载失败：' + e.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!pid) return undefined;
    let alive = true;
    setLoaded(null);
    api
      .get('/api/projects/' + pid + '/delivery')
      .then((d) => {
        if (!alive) return;
        setLoaded(d);
        setDir(d.dir || '');
        setEnabled(d.enabled !== false);
        setErr('');
      })
      .catch((e) => alive && setErr('交付设置加载失败：' + e.message));
    return () => {
      alive = false;
    };
  }, [pid]);

  const dirty = !!loaded && (dir.trim() !== (loaded.dir || '') || enabled !== (loaded.enabled !== false));

  async function browse() {
    setBusy('browse');
    try {
      const r = await api.post('/api/delivery/browse');
      if (r.path) setDir(r.path);
      else if (r.cancelled) toast.info('已取消选择');
      else if (r.error) toast.warn(r.error);
    } catch (e) {
      toast.error(e.message + '（可以直接在输入框里手动填写路径）');
    } finally {
      setBusy('');
    }
  }

  async function save() {
    if (!pid) return;
    setBusy('save');
    try {
      const d = await api.put('/api/projects/' + pid + '/delivery', { dir: dir.trim(), enabled });
      setLoaded(d);
      setDir(d.dir || '');
      setEnabled(d.enabled !== false);
      toast.success('交付设置已保存（仅对所选项目生效）');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  if (projects === null) {
    return err ? (
      <p className="m-0 text-[12px] text-[var(--danger)]">{err}</p>
    ) : (
      <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
        <Spinner size={14} /> 加载项目列表…
      </div>
    );
  }
  if (!projects.length) return <p className="m-0 text-[12px] text-[var(--fg-3)]">还没有项目。</p>;

  const log = (loaded && loaded.log) || [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="项目" hint="交付目录按项目分别保存；默认是最近打开的项目。">
          <Select value={pid} onChange={setPid} items={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <Field label="启用">
          <div className="flex h-10 items-center">
            <Checkbox checked={enabled} disabled={!loaded} onChange={setEnabled} label="成片导出成功后自动复制到交付目录" />
          </div>
        </Field>
      </div>
      <Field label="交付目录" hint="必须是已存在的文件夹（绝对路径）。留空 = 不交付。">
        <div className="flex items-center gap-2">
          <Input value={dir} disabled={!loaded} onChange={(e) => setDir(e.target.value)} placeholder={'例如 D:\\交付'} className="font-mono text-[12.5px]" />
          <Button variant="secondary" size="md" disabled={!loaded || !!busy} loading={busy === 'browse'} onClick={browse}>
            <FolderOpen size={14} /> 选择文件夹…
          </Button>
        </div>
      </Field>
      {err ? <p className="m-0 text-[12px] text-[var(--danger)]">{err}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" disabled={!loaded || !dirty || !!busy} loading={busy === 'save'} onClick={save}>
          <Save size={14} /> 保存交付设置
        </Button>
        <span className="text-[11px] text-[var(--fg-4)]">这一块单独保存，不写 config.json，也不受上方「保存配置」影响。</span>
      </div>
      <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
        某章成片导出成功后，主成片复制为 交付目录\EP&lt;N&gt;.mp4（N 只从章名「第N章」解析，解析不到就跳过）。覆盖同名文件之前，旧的 EP&lt;N&gt;.mp4 先归档到
        交付目录\历史候选\IC自动交付归档\，sha256 一致才覆盖；覆盖后再核一次。只碰 EP&lt;N&gt;.mp4 和这次的归档文件，目录里别的文件一概不动。失败只报错，不影响合成。
      </p>
      {log.length ? (
        <div className="flex flex-col gap-1 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
          <span className="text-[11px] text-[var(--fg-3)]">最近交付记录</span>
          {log.slice(0, 5).map((e, i) => (
            <span
              key={i}
              className={'break-all text-[11px] leading-relaxed ' + (e.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--fg-3)]')}
            >
              {fmtTime(e.at)} · {e.chapter || '—'} ·{' '}
              {e.status === 'ok'
                ? 'EP' + e.ep + ' 交付成功' + (e.unchanged ? '（内容未变）' : '') + (e.archivePath ? '，旧文件已归档' : '')
                : e.status === 'failed'
                  ? '交付失败（' + (e.step || '') + '）：' + (e.error || '')
                  : '跳过：' + (e.reason || '')}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

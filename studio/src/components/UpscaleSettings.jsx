import { useEffect, useState } from 'react';
import { Cloud, Cpu, Lock, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Field, Input, Segmented, Select, Spinner } from './ui.jsx';
import { useToast } from './toast.jsx';

export default function UpscaleSettings() {
  const toast = useToast();
  const [loaded, setLoaded] = useState(null);
  const [provider, setProvider] = useState('volc');
  const [key, setKey] = useState('');
  const [style, setStyle] = useState('balanced');
  const [concurrency, setConcurrency] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/upscale/settings').then((s) => {
      setLoaded(s);
      setProvider(s.provider || 'volc');
      setStyle(s.volc.enhanceStyle || 'balanced');
      setConcurrency(s.volc.concurrency || 2);
    }).catch((e) => setError(e.message));
  }, []);

  async function save(clearKey = false) {
    setBusy(true);
    try {
      const s = await api.put('/api/upscale/settings', {
        provider: 'volc',
        volc: { ...(clearKey ? { clearKey: true } : key.trim() ? { apiKey: key.trim() } : {}), enhanceStyle: style, concurrency: Number(concurrency) },
      });
      setLoaded(s);
      setKey('');
      setError('');
      toast.success(clearKey ? '已清除火山 Key' : '升级2K 设置已保存');
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
    } finally { setBusy(false); }
  }

  if (!loaded && !error) return <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]"><Spinner /> 加载升级设置…</div>;

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        value={provider}
        onChange={setProvider}
        options={[
          { value: 'volc', label: '火山', icon: <Cloud size={13} /> },
          { value: 'local', label: '本地 · 暂未开放', icon: <Cpu size={13} /> },
        ]}
      />
      {provider === 'local' ? (
        <div className="rounded-xl border border-[var(--line)] bg-white/[0.025] p-4 text-[12px] leading-relaxed text-[var(--fg-3)]">
          <Badge tone="neutral">暂未开放</Badge>
          <p className="mb-0">本地升级将使用本机显卡。这次先接火山，不会向本地 ComfyUI 或 GPU 队列提交任务。</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--fg-3)]">
            <Badge tone={loaded?.volc?.configured ? 'success' : 'neutral'} dot>{loaded?.volc?.configured ? 'Key 已配置' : 'Key 未配置'}</Badge>
            <span>{loaded?.endpoint || '火山 AI MediaKit'}</span>
          </div>
          <Field label="火山 MediaKit API Key" hint="留空 = 保留现有 Key。仅存服务端设置；页面和接口永不读回 Key。不是方舟 Ark Key。">
            <div className="flex gap-2">
              <Input type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={loaded?.volc?.configured ? '已配置；填入新 Key 可替换' : '填写 AI MediaKit API Key'} />
              {loaded?.volc?.configured ? <Button variant="ghost" size="md" disabled={busy} title="清除已保存的 Key" onClick={() => save(true)}><Trash2 size={13} /> 清除</Button> : null}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="增强风格" hint="默认沿用本项目 EP 2K 的 balanced。">
              <Select value={style} onChange={setStyle} items={(loaded?.enhanceStyles || [{ id: 'balanced', label: '均衡' }, { id: 'clear', label: '清晰' }]).map((s) => ({ value: s.id, label: s.label }))} />
            </Field>
            <Field label="同时处理条数" hint="与本地 GPU 队列完全独立。">
              <Select value={String(concurrency)} onChange={setConcurrency} items={[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: n + ' 条' }))} />
            </Field>
          </div>
          <div className="rounded-xl border border-[var(--line)] bg-white/[0.025] p-3.5 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
            <p className="m-0"><b className="text-[var(--fg-2)]">画质增强 · 标准版</b>（standard / common / 2k），保持原片帧率，升级后合回原音轨。</p>
            <p className="mb-0 mt-1.5">原片保留，新版单独列在成片里，并默认「选用」；可以随时切回原片。2K 角标按 ffprobe 实测短边 ≥ 1440 像素判断，不看文件名。</p>
            <p className="mb-0 mt-1.5">火山按用量计费；点单条或批量升级前会确认。上传、处理、下载和失败状态都显示在成片卡片上。</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--fg-4)]"><Lock size={12} /> Key 不进代码、不进日志、不回传浏览器</span>
            <Button variant="primary" size="md" loading={busy} onClick={() => save()}><Save size={13} /> 保存升级设置</Button>
          </div>
        </>
      )}
      {error ? <p className="m-0 text-[12px] text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}

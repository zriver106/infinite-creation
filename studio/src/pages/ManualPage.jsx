import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FilePlus2, FolderPlus, Pencil, Save, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

// ---- 极简 Markdown 渲染（标题 / 表格 / 引用 / 列表 / 代码块 / 加粗 / 行内代码），不引入依赖 ----
function inline(text, keyBase) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) parts.push(<strong key={keyBase + '-' + i++} className="font-semibold text-[var(--fg)]">{t.slice(2, -2)}</strong>);
    else parts.push(<code key={keyBase + '-' + i++} className="rounded bg-white/[0.07] px-1 py-px text-[0.92em]">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function Markdown({ text }) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={k++} className="my-3 overflow-x-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-black/30 p-3 text-[12px] leading-relaxed text-[var(--fg-2)]">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const n = h[1].length;
      const cls = ['', 'text-[20px] mt-1', 'text-[17px] mt-5', 'text-[15px] mt-4', 'text-[14px] mt-3'][n];
      out.push(<div key={k++} className={'mb-2 font-semibold text-[var(--fg)] ' + cls}>{inline(h[2], 'h' + k)}</div>);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      out.push(
        <div key={k++} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[12px] leading-relaxed">
            <thead><tr>{head.map((c, ci) => <th key={ci} className="border border-[var(--line)] bg-white/[0.05] px-2 py-1.5 text-left font-semibold text-[var(--fg)]">{inline(c, 'th' + ci)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-[var(--line)] px-2 py-1.5 align-top text-[var(--fg-2)]">{inline(c, 'td' + ri + '-' + ci)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<blockquote key={k++} className="my-3 border-l-2 border-[var(--accent)] pl-3 text-[13px] leading-relaxed text-[var(--fg-2)]">{buf.map((b, bi) => <p key={bi} className="m-0 mb-1">{inline(b, 'q' + bi)}</p>)}</blockquote>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++]);
      out.push(
        <ul key={k++} className="my-2 list-none space-y-1.5 p-0 text-[13px] leading-relaxed text-[var(--fg-2)]">
          {buf.map((b, bi) => {
            const mm = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(b);
            return <li key={bi} className="flex gap-2"><span className="shrink-0 text-[var(--fg-4)]">{/\d/.test(mm[1]) ? mm[1] : '•'}</span><span className="min-w-0">{inline(mm[2], 'li' + bi)}</span></li>;
          })}
        </ul>,
      );
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```|\s*\|)/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(<p key={k++} className="my-2 text-[13px] leading-[1.8] text-[var(--fg-2)]">{inline(buf.join(' '), 'p' + k)}</p>);
  }
  return <div>{out}</div>;
}

function readUrlSel() {
  const p = new URLSearchParams(window.location.search);
  return { cat: p.get('cat') || '', doc: p.get('doc') || '' };
}

function writeUrlSel(cat, doc) {
  const q = new URLSearchParams(window.location.search);
  q.set('mode', 'manual');
  if (cat) q.set('cat', cat); else q.delete('cat');
  if (doc) q.set('doc', doc); else q.delete('doc');
  window.history.replaceState(null, '', '/?' + q.toString());
}

export default function ManualPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState({});
  const [sel, setSel] = useState(readUrlSel());
  const [doc, setDoc] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const j = await api.get('/api/manual');
      setData(j);
      setErr('');
      return j;
    } catch (e) {
      setErr(e.message);
      return null;
    }
  }, []);

  const loadDoc = useCallback(async (cat, file) => {
    try {
      const j = await api.get('/api/manual/doc?cat=' + encodeURIComponent(cat) + '&file=' + encodeURIComponent(file));
      setDoc(j);
      setDraft(j.content);
      setEditing(false);
    } catch (e) {
      toast.error(e.message);
    }
  }, [toast]);

  useEffect(() => {
    loadList().then((j) => {
      if (!j) return;
      const cat = j.categories.find((c) => c.id === sel.cat) || j.categories[0];
      if (!cat) return;
      setOpen((o) => ({ ...o, [cat.id]: true }));
      const d = cat.docs.find((x) => x.file === sel.doc) || cat.docs[0];
      if (d) {
        setSel({ cat: cat.id, doc: d.file });
        loadDoc(cat.id, d.file);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = editing && doc && draft !== doc.content;

  function pick(catId, file) {
    if (dirty && !window.confirm('当前文档有未保存的修改，切换后会丢失。继续吗？')) return;
    setSel({ cat: catId, doc: file });
    writeUrlSel(catId, file);
    loadDoc(catId, file);
  }

  async function save() {
    if (!doc) return;
    setSaving(true);
    try {
      const r = await api.put('/api/manual/doc', { cat: doc.cat, file: doc.file, content: draft, baseHash: doc.hash });
      toast.success(r.changed ? '已保存到磁盘（旧版已备份）' : '内容没有变化，未写盘');
      await loadDoc(doc.cat, doc.file);
      loadList();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status) {
    try {
      await api.patch('/api/manual/doc', { cat: doc.cat, file: doc.file, status });
      toast.success('状态已改为「' + status + '」');
      await loadDoc(doc.cat, doc.file);
      loadList();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function newDoc(catId) {
    const title = window.prompt('新文档标题：');
    if (!title) return;
    try {
      const r = await api.post('/api/manual/doc', { cat: catId, title });
      await loadList();
      setOpen((o) => ({ ...o, [catId]: true }));
      pick(r.cat, r.file);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function newCat() {
    const title = window.prompt('新分类名称（会在手册目录下建同名文件夹）：');
    if (!title) return;
    try {
      await api.post('/api/manual', { title });
      await loadList();
      toast.success('已新增分类「' + title + '」');
    } catch (e) {
      toast.error(e.message);
    }
  }

  const total = useMemo(() => (data ? data.categories.reduce((n, c) => n + c.docs.length, 0) : 0), [data]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="MANUAL"
        title="手册"
        description="分镜、提示词、运镜、剪辑等制作规则。这里看到的和编辑的，就是磁盘上的同一份文件；写提示词时读的也是它。保存前旧版会自动备份。"
        actions={data ? <Badge tone="neutral">{data.categories.length} 类 · {total} 篇</Badge> : null}
      />
      {data ? (
        <p className="m-0 break-all text-[11px] text-[var(--fg-4)]" data-testid="manual-root">手册目录：{data.root}</p>
      ) : null}
      {err ? <div className="panel p-4 text-[13px] text-[var(--danger)]">{err}</div> : null}
      {data ? (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="panel w-full shrink-0 p-2 lg:w-[290px]" data-testid="manual-tree">
            {data.categories.map((c) => {
              const isOpen = !!open[c.id];
              return (
                <div key={c.id} className="mb-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="nav-item flex-1"
                      data-active={sel.cat === c.id}
                      onClick={() => setOpen((o) => ({ ...o, [c.id]: !isOpen }))}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span className="flex-1 text-left font-semibold">{c.title}</span>
                      <span className="text-[11px] text-[var(--fg-4)]">{c.docs.length}</span>
                    </button>
                    <button type="button" title="在该分类下新建文档" className="rounded-lg p-1.5 text-[var(--fg-3)] hover:bg-white/[0.06] hover:text-[var(--fg)]" onClick={() => newDoc(c.id)}>
                      <FilePlus2 size={14} />
                    </button>
                  </div>
                  {isOpen ? (
                    <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-[var(--line)] pl-2">
                      {c.docs.length === 0 ? <p className="m-0 px-2 py-1 text-[11px] text-[var(--fg-4)]">暂无文档</p> : null}
                      {c.docs.map((d) => (
                        <button
                          key={d.file}
                          type="button"
                          data-active={sel.cat === c.id && sel.doc === d.file}
                          className="nav-item items-start text-left"
                          onClick={() => pick(c.id, d.file)}
                          title={d.title}
                        >
                          <span className="min-w-0 flex-1 text-[12px] leading-snug">{d.title}</span>
                          {d.status === '草案' ? <span className="shrink-0 rounded-full border border-[var(--accent)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--accent)]">草案</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={newCat}>
              <FolderPlus size={14} className="mr-1.5" />新增分类
            </Button>
          </div>

          <div className="panel min-w-0 flex-1 p-5" data-testid="manual-doc">
            {doc ? (
              <Fragment>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] pb-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-[var(--fg-4)]">{doc.catTitle}</span>
                      <Badge tone={doc.status === '草案' ? 'warn' : 'success'}>{doc.status}</Badge>
                      {dirty ? <Badge tone="warn">未保存</Badge> : null}
                    </div>
                    <h3 className="m-0 mt-1 text-[16px] font-semibold text-[var(--fg)]">{doc.title}</h3>
                    {doc.source ? <p className="m-0 mt-1 text-[11px] text-[var(--fg-4)]">来源：{doc.source}</p> : null}
                    <p className="m-0 mt-0.5 break-all text-[11px] text-[var(--fg-4)]">文件：{doc.path}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!editing ? (
                      <Button variant="secondary" onClick={() => { setDraft(doc.content); setEditing(true); }}><Pencil size={13} className="mr-1.5" />编辑</Button>
                    ) : (
                      <Fragment>
                        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}><Save size={13} className="mr-1.5" />保存</Button>
                        <Button variant="ghost" onClick={() => { if (!dirty || window.confirm('放弃未保存的修改？')) { setDraft(doc.content); setEditing(false); } }}><X size={13} className="mr-1.5" />取消</Button>
                      </Fragment>
                    )}
                    <Button variant="ghost" onClick={() => setStatus(doc.status === '草案' ? '现行' : '草案')}>标为{doc.status === '草案' ? '现行' : '草案'}</Button>
                  </div>
                </div>
                {editing ? (
                  <Textarea
                    rows={28}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    data-testid="manual-editor"
                    className="font-mono text-[12px] leading-relaxed"
                  />
                ) : (
                  <div data-testid="manual-view"><Markdown text={doc.content} /></div>
                )}
              </Fragment>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-[var(--fg-3)]"><BookOpen size={16} />从左侧选择一篇文档</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Captions,
  CheckCircle2,
  Cloud,
  Film,
  FolderOutput,
  KeyRound,
  Lock,
  Save,
  Server,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wand2,
  Workflow,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api.js';
import {
  HW_DEFAULT_FREE,
  HW_PRESETS,
  RUNNINGHUB_TIERS,
  RUNNINGHUB_WORKFLOWS,
  comfyBaseUrl,
  enabledComfyEndpoints,
  normalizeComfyEndpoints,
  hardwareMode,
  VIDEO_RESOLUTION_CUSTOM,
} from '../lib/shared.js';
import { Badge, Button, EmptyState, Field, Input, Segmented, Select, Spinner, Switch } from '../components/ui.jsx';
import { RESOLUTION_SELECT_ITEMS, RATIO_SELECT_ITEMS } from '../components/visuals.jsx';
import PageHeader from '../components/PageHeader.jsx';
import SkillsPanel from '../components/SkillsPanel.jsx';
import SkillPipelinePanel from '../components/SkillPipelinePanel.jsx';
import SubtitlePanel from '../components/SubtitlePanel.jsx';
import WorkflowConfigPanel from '../components/WorkflowConfigPanel.jsx';
import DeliverySettings from '../components/DeliverySettings.jsx';
import UpscaleSettings from '../components/UpscaleSettings.jsx';
import { useToast } from '../components/toast.jsx';
// Claude API 密钥卡片与指挥中心「设置」页是同一个组件：读写 4620 的 /api/command/settings/claude-api，不进 config.json
import { ApiKeyCard } from './CommandPage.jsx';

const TIER_OPTIONS = RUNNINGHUB_TIERS.map((t) => ({ value: t.id, label: t.label }));
const REWRITE_LANG_OPTIONS = [
  { value: 'same', label: '与原提示词一致（推荐）' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

// 设置分类：沿用经典界面的左侧分类导航，右侧只渲染当前分类，避免一条长页面从头滚到尾。
const CATEGORIES = [
  { id: 'general', label: '通用配置', desc: '分镜数量 · 任务调度', icon: SlidersHorizontal },
  { id: 'comfyui', label: 'ComfyUI 服务', desc: '执行端 · 并发队列', icon: Server },
  // ic28：原「LLM 模型」并入「Agent 运行时」（OpenAI 兼容接口成为内置运行时的模型 / 外部 Agent 的后备）
  { id: 'agent', label: 'Agent 运行时', desc: 'Agent 大脑 · CLI / OpenAI 兼容接口 · 改写', icon: Bot },
  { id: 'upscale2k', label: '升级2K', desc: '火山 / 本地 · 成片超分', icon: Film },
  { id: 'subtitle', label: '字幕与语音识别', desc: 'Whisper 模型 · 本地环境', icon: Captions },
  { id: 'claudeapi', label: 'Claude API 密钥', desc: '指挥系统会话 · 只存本机', icon: KeyRound },
  { id: 'skills', label: '技能库', desc: '全局技能包管理', icon: Wand2 },
  { id: 'pipeline', label: '流水线编排', desc: '技能节点 · 导入导出', icon: Workflow, beta: true },
];

export default function SettingsPage({ onBack, publicMode = false }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [savedCfg, setSavedCfg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState('');
  const [llmTest, setLlmTest] = useState('');
  const [comfyInfo, setComfyInfo] = useState(null);
  const [agents, setAgents] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsErr, setAgentsErr] = useState('');
  const [agentTest, setAgentTest] = useState('');
  const [brainTest, setBrainTest] = useState('');
  const [mcpServer, setMcpServer] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [activeCat, setActiveCat] = useState('general');
  const contentRef = useRef(null);

  const loadConfig = useCallback(() => {
    setLoadErr('');
    api
      .get('/api/config')
      .then((c) => {
        setCfg(c);
        setSavedCfg(c);
        detectComfy(c.comfyui);
      })
      .catch((e) => setLoadErr(e.message || '未知错误'));
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);

  const reloadWorkflows = useCallback(() => {
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 本机 CLI Agent 检测：结果不落盘，重新检测会清空后端缓存（force=1）。
  const loadAgents = useCallback((force = false) => {
    setAgentsLoading(true);
    setAgentsErr('');
    api
      .get('/api/agents' + (force ? '?force=1' : ''))
      .then((r) => {
        setAgents(r.agents || []);
        setMcpServer(r.mcpServer || null);
      })
      .catch((e) => setAgentsErr(e.message || '检测失败'))
      .finally(() => setAgentsLoading(false));
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  async function detectComfy(comfyui) {
    try {
      setComfyInfo(await api.post('/api/comfyui/test', { comfyui }));
    } catch {
      setComfyInfo({ ok: false, error: '连接失败' });
    }
  }

  // —— 渲染队列（RunningHub 多用户调度）——
  // 所有值随配置保存；调度器每轮重新读 config.json，改完立即生效，不需要重启。
  const queue = cfg?.generation?.queue || {};
  const setQueue = (patch) =>
    setCfg((c) => ({ ...c, generation: { ...c.generation, queue: { ...(c.generation.queue || {}), ...patch } } }));
  const setPoolMin = (pool, value) =>
    setQueue({ pools: { ...(queue.pools || {}), [pool]: { ...((queue.pools || {})[pool] || {}), min: value } } });
  const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  // —— 新建项目默认配置（创建项目表单的初值）——
  const defaults = cfg?.projectDefaults || {};
  const setDefaults = (patch) =>
    setCfg((c) => ({ ...c, projectDefaults: { ...(c.projectDefaults || {}), ...patch } }));

  async function save() {
    setSaving(true);
    try {
      const s = await api.put('/api/config', cfg);
      setCfg(s);
      setSavedCfg(s);
      toast.success('配置已保存');
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function canLeave() {
    if (cfg !== savedCfg) {
      const r = await toast.confirm('配置有未保存的修改，保存后再返回？', {
        confirmLabel: '保存并返回',
        cancelLabel: '取消',
        discardLabel: '放弃修改',
      });
      if (r === 'discard') {
        setCfg(savedCfg);
        return true;
      }
      if (!r) return false;
      const saved = await save();
      if (!saved) return false;
    }
    return true;
  }

  async function handleBack() {
    if (!(await canLeave())) return;
    onBack();
  }

  async function testComfy() {
    try {
      const r = await api.post('/api/comfyui/test', { comfyui: cfg.comfyui });
      setComfyInfo(r);
      const multi = !isRunningHubCfg(cfg) && Array.isArray(r.endpoints) && r.endpoints.length > 1;
      const head = multi ? '可用端点 ' + r.okCount + '/' + r.total + ' · ' : '';
      setTest(timeLabel() + ' · ' + head + (r.ok ? '连接成功 · ' + r.system + ' · ' + r.device : '连接失败：' + r.error));
    } catch (e) {
      setTest(timeLabel() + ' · 失败：' + e.message);
    }
  }

  async function testLlm() {
    setLlmTest('测试中…');
    try {
      const r = await api.post('/api/llm/test', { llm: cfg.llm });
      setLlmTest(timeLabel() + ' · ' + (r.ok ? '连接成功 · ' + r.model : '连接失败：' + r.error));
    } catch (e) {
      setLlmTest(timeLabel() + ' · 失败：' + e.message);
    }
  }

  if (!cfg) {
    return (
      <div className="panel mx-auto flex w-full max-w-[520px] flex-col items-center gap-3 px-6 py-12">
        {loadErr ? (
          <>
            <EmptyState icon={Settings2} title="配置加载失败" description={loadErr} />
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={loadConfig}>
                重试
              </Button>
              <Button variant="secondary" size="md" onClick={onBack}>
                返回
              </Button>
            </div>
          </>
        ) : (
          <>
            <Spinner size={18} />
            <span className="text-[12px] text-[var(--fg-3)]">配置加载中…</span>
          </>
        )}
      </div>
    );
  }

  const hwMode = hardwareMode(cfg);
  const isRunningHub = (cfg.comfyui.provider || 'native') === 'runninghub';
  const dirty = cfg !== savedCfg;
  const categories = CATEGORIES;
  const active = categories.some((c) => c.id === activeCat) ? activeCat : categories[0].id;

  // 对外托管模式：密钥、工作流、硬件适配、技能管理都属于管理员范畴，
  // 前端只展示只读的服务信息，避免把任何密钥或可写配置暴露给外部用户。
  if (publicMode) {
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5">
        <PageHeader
          eyebrow="Service"
          title="服务信息"
          description="本页面由本机统一管理；生成服务与密钥均在服务端，不会下发到浏览器。"
          actions={
            <Button variant="ghost" size="md" onClick={onBack}>
              <ArrowLeft size={14} /> 返回
            </Button>
          }
        />
        <Section icon={Cloud} title="生成服务" description="由本机配置">
          <div className="grid gap-2.5 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3.5 text-[11.5px] sm:grid-cols-2">
            <ReadonlyRow label="执行端" value={isRunningHub ? '云端渲染' : '原生 ComfyUI'} />
            <ReadonlyRow label="云端版本" value={isRunningHub ? cfg.comfyui.tier || 'standard' : '—'} />
            <ReadonlyRow label="Agent 大脑" value={(cfg.agent?.runtime || 'openclaude') === 'openclaude' ? 'OpenAI 兼容接口 · ' + (cfg.llm.model || '—') : '外部 Agent · ' + cfg.agent.runtime} />
            <ReadonlyRow label="视觉输入" value={cfg.llm.vision ? '已开启' : '未开启'} />
            <ReadonlyRow label="视频超时" value={(cfg.generation.videoTimeoutMinutes || '—') + ' 分钟'} />
            <ReadonlyRow label="图片超时" value={(cfg.generation.imageTimeoutMinutes || '—') + ' 分钟'} />
          </div>
        </Section>
        <Section icon={Lock} title="数据与隐私" description="本地部署说明">
          <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
            <li>项目、素材与成片保存在服务端；浏览器端只能访问当前服务暴露的接口。</li>
            <li>开源版没有账号与会话校验，请只部署在可信网络内；公网访问请在反向代理层自行加认证。</li>
          </ul>
        </Section>
      </div>
    );
  }

  function switchMode(mode) {
    setTest('');
    setComfyInfo(null);
    // 切换执行端时，各任务类型的工作流跟随该端预设：
    // 只有「自定义且在该端可用」的选择才保留，其余一律回到新执行端的默认工作流，避免下面卡片显示与上方类型不符的节点。
    const target = mode === 'runninghub' ? RUNNINGHUB_WORKFLOWS : HW_PRESETS[mode];
    const prev = cfg.workflows || {};
    const byId = new Map(workflows.map((w) => [w.spec?.id || w.id, w]));
    const usableHere = (id) => {
      const w = byId.get(id);
      if (!w || w.spec?.builtin !== false) return false; // 只保留自定义工作流
      const sid = String(id);
      if (mode === 'runninghub') return sid.startsWith('runninghub_');
      if (sid.startsWith('runninghub_')) return false;
      const hw = w.spec?.hw;
      return hw == null || hw === mode;
    };
    const next = {};
    for (const [k, def] of Object.entries(target)) {
      const cur = prev[k];
      next[k] = cur && usableHere(cur) ? cur : def;
    }
    for (const [k, v] of Object.entries(prev)) {
      if (!(k in next) && usableHere(v)) next[k] = v;
    }

    if (mode === 'runninghub') {
      setCfg({ ...cfg, comfyui: { ...cfg.comfyui, provider: 'runninghub' }, workflows: next });
      return;
    }
    const free = cfg.generation.freeAfterEvery;
    setCfg({
      ...cfg,
      comfyui: { ...cfg.comfyui, provider: 'native' },
      hardware: { ...cfg.hardware, mode },
      workflows: next,
      generation: {
        ...cfg.generation,
        freeAfterEvery: free == null || Number(free) === HW_DEFAULT_FREE[hwMode] ? HW_DEFAULT_FREE[mode] : free,
      },
    });
  }

  // —— Agent 运行时（内置 openclaude / 本机 CLI）——
  const agentCfg = cfg.agent || { runtime: 'openclaude', extraPath: '', custom: {} };
  const agentRuntime = agentCfg.runtime || 'openclaude';
  const isExternalAgent = agentRuntime !== 'openclaude';
  const externalAgents = agents.filter((a) => a.id !== 'openclaude');
  const selectedAgent = externalAgents.find((a) => a.id === agentRuntime);
  const customCfg = agentCfg.custom || {};

  function setAgent(patch) {
    setCfg({ ...cfg, agent: { ...agentCfg, ...patch } });
  }

  function setAgentCustom(patch) {
    setAgent({ custom: { ...customCfg, ...patch } });
  }

  function switchAgentMode(mode) {
    setAgentTest('');
    if (mode === 'openclaude') {
      setAgent({ runtime: 'openclaude' });
      return;
    }
    const first = externalAgents.find((a) => a.available);
    setAgent({ runtime: first ? first.id : 'custom' });
  }

  async function testAgent() {
    setAgentTest('检测中…');
    try {
      const r = await api.post('/api/agents/test', { agentId: agentRuntime, custom: customCfg });
      setAgentTest(
        r.ok
          ? '可用' + (r.version ? ' · ' + r.version : '') + (r.path ? ' · ' + r.path : '')
          : '不可用：' + (r.error || '未知错误'),
      );
    } catch (e) {
      setAgentTest('失败：' + e.message);
    }
  }

  // 按当前（可未保存）的 Agent 大脑设置真的问一句，验证剧本/提示词改写这类一问一答走得通
  async function testBrain() {
    setBrainTest('试跑中…（外部 CLI 冷启动可能要十几秒）');
    try {
      const r = await api.post('/api/agents/test', { ping: true, agent: agentCfg, llm: cfg.llm });
      const via = r.via === 'llm' ? 'OpenAI 兼容接口' : r.via === 'llm-fallback' ? 'OpenAI 兼容接口（外部 Agent 失败后回落）' : String(r.via || '').replace(/^agent:/, '外部 Agent · ');
      setBrainTest(
        timeLabel() + ' · ' + (r.ok ? '可用 · ' + via + ' · ' + (r.secs ?? '?') + ' 秒 · 回复「' + (r.content || '') + '」' : '不可用：' + (r.error || '未知错误')),
      );
    } catch (e) {
      setBrainTest(timeLabel() + ' · 失败：' + e.message);
    }
  }

  function copyMcpConfig() {
    if (!mcpServer) return;
    if (!navigator.clipboard) {
      toast.error('当前环境不支持剪贴板，请手动复制');
      return;
    }
    const snippet = JSON.stringify({ mcpServers: { ic: { command: mcpServer.command, args: mcpServer.args } } }, null, 2);
    navigator.clipboard
      .writeText(snippet)
      .then(() => toast.success('MCP 配置已复制'))
      .catch(() => toast.error('复制失败，请手动选择文本'));
  }

  function switchCategory(id) {
    setActiveCat(id);
    // 切换分类时如果内容区顶部已经滚出视口，回到内容区开头，避免落在新分类的中间。
    const el = contentRef.current;
    if (el && el.getBoundingClientRect().top < 80) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
      <PageHeader
        eyebrow="Settings"
        title="设置"
        description="ComfyUI 服务、LLM、Agent 运行时与硬件适配；修改后需要保存才会生效。"
        actions={
          <>
            <Button variant="ghost" size="md" onClick={handleBack}>
              <ArrowLeft size={14} /> 返回
            </Button>
            <Button variant="primary" size="md" loading={saving} onClick={save}>
              <Save size={14} /> 保存配置
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[228px_minmax(0,1fr)]">
        <aside className="flex h-fit flex-col gap-3 lg:sticky lg:top-[86px]">
          <nav className="panel flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible" aria-label="设置分类">
            <p className="section-label hidden px-2.5 pb-2 pt-2 lg:block">Settings</p>
            {categories.map((c) => {
              const Icon = c.icon;
              const on = active === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  data-active={on}
                  aria-current={on ? 'page' : undefined}
                  className="nav-item w-auto shrink-0 lg:w-full"
                  onClick={() => switchCategory(c.id)}
                >
                  <Icon size={15} className={on ? 'shrink-0 text-[var(--accent)]' : 'shrink-0 text-[var(--fg-3)]'} />
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {c.label}
                      {c.beta ? (
                        <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                          beta
                        </span>
                      ) : null}
                    </span>
                    <span className="hidden text-[10.5px] leading-tight text-[var(--fg-4)] lg:block">{c.desc}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="panel hidden flex-col gap-2.5 p-3.5 lg:flex">
            <div className="flex items-center justify-between gap-2">
              <span className="section-label">配置状态</span>
              <Badge tone={dirty ? 'accent' : 'neutral'} dot>
                {dirty ? '未保存' : '已保存'}
              </Badge>
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
              {dirty ? '有修改尚未写入 config.json。' : '当前配置已写入 config.json。'}
            </p>
          </div>
        </aside>

        <div ref={contentRef} className="flex min-w-0 scroll-mt-[84px] flex-col gap-4">
          {active === 'general' ? (
            <>
              <Section icon={Film} title="分镜视频生成" description="每个分镜一次生成几条候选视频；候选越多，渲染耗时和显存占用越高。">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="分镜抽卡数量" hint="默认 1（一个分镜一条视频）；>1 时生成多个候选供勾选最优导出，范围 1-10。">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={String(cfg.generation?.videosPerShot ?? 1)}
                      onChange={(e) =>
                        setCfg({ ...cfg, generation: { ...cfg.generation, videosPerShot: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) } })
                      }
                    />
                  </Field>
                </div>
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                  生成多个候选会成倍增加渲染耗时与显存占用，建议 2～3。修改后对新提交的分镜任务生效；已有候选不会被删除。
                </p>
              </Section>

              <Section icon={Users} title="Agent 调度" description="多个章节并行时，限制同时运行的 Agent 会话数；超出的任务会排队等待。">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="同时运行的 Agent 数" hint="默认 4。每个章节占一个槽位（包含渲染等待），建议 2～4。">
                    <Input
                      type="number"
                      min={1}
                      max={32}
                      value={String(cfg.generation?.agentConcurrency ?? 4)}
                      onChange={(e) =>
                        setCfg({ ...cfg, generation: { ...cfg.generation, agentConcurrency: Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 4))) } })
                      }
                    />
                  </Field>
                  <Field label="Agent 排队超时（分钟）" hint="等待空闲槽位超过该时长自动放弃，避免任务永久排队。">
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      value={String(cfg.generation?.agentQueueTimeoutMinutes ?? 120)}
                      onChange={(e) =>
                        setCfg({ ...cfg, generation: { ...cfg.generation, agentQueueTimeoutMinutes: Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 120))) } })
                      }
                    />
                  </Field>
                </div>
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                  超出的章节会显示「等待 Agent 槽位」，不会占用模型请求，也不会触发模型停滞看门狗。渲染仍由云端渲染队列按并发数控制。
                </p>
              </Section>

              <Section icon={FolderOutput} title="交付目录" description="按项目分别保存：某章成片导出成功后，自动复制为交付目录里的 EP<N>.mp4。">
                <DeliverySettings />
              </Section>

              <Section icon={SlidersHorizontal} title="新建项目默认配置" description="创建新项目时表单的默认值；保存后对新创建的项目生效，不影响已有项目。">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="默认分辨率">
                    <Select
                      value={defaults.resolution || '480P'}
                      onChange={(v) => setDefaults({ resolution: v })}
                      items={RESOLUTION_SELECT_ITEMS}
                    />
                  </Field>
                  <Field label="默认宽高比">
                    <Select
                      value={defaults.aspectRatio || '16:9'}
                      onChange={(v) => setDefaults({ aspectRatio: v })}
                      items={RATIO_SELECT_ITEMS}
                    />
                  </Field>
                </div>
                {(defaults.resolution || '480P') === VIDEO_RESOLUTION_CUSTOM ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="默认宽度（px）">
                      <Input
                        type="number"
                        min={64}
                        step={32}
                        value={defaults.width ? String(defaults.width) : ''}
                        onChange={(e) => setDefaults({ width: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                        placeholder="1024"
                      />
                    </Field>
                    <Field label="默认高度（px）">
                      <Input
                        type="number"
                        min={64}
                        step={32}
                        value={defaults.height ? String(defaults.height) : ''}
                        onChange={(e) => setDefaults({ height: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                        placeholder="576"
                      />
                    </Field>
                  </div>
                ) : null}
                <div className="flex flex-col gap-3 pt-1">
                  <Switch
                    checked={defaults.enableBgm !== false}
                    onChange={(v) => setDefaults({ enableBgm: v })}
                    label="自动生成背景音乐"
                    hint="视频阶段生成纯音乐并合成到成片。"
                  />
                  <Switch
                    checked={defaults.enableSubtitles !== false}
                    onChange={(v) => setDefaults({ enableSubtitles: v })}
                    label="自动添加字幕"
                    hint="按「字幕与语音识别」选择的模式烧录到成片。"
                  />
                  <Switch
                    checked={defaults.autoScript !== false}
                    onChange={(v) => setDefaults({ autoScript: v })}
                    label="自动生成剧本"
                    hint="剧本为空时先由 Agent 写剧本再拆分镜；关闭后需先提供剧本。"
                  />
                </div>
              </Section>
            </>
          ) : null}

          {active === 'comfyui' ? (
            <Section icon={Server} title="ComfyUI 服务" description="生成图片与视频的执行端">
              <div className="grid gap-1.5">
                <div className="text-[12px] font-medium text-[var(--fg-2)]">资产出图方式</div>
                <Segmented
                  value={cfg.generation?.assetImageSource === 'ic' ? 'ic' : 'muse'}
                  onChange={(v) => setCfg({ ...cfg, generation: { ...(cfg.generation || {}), assetImageSource: v } })}
                  options={[
                    { value: 'muse', label: 'Muse 出图（默认）' },
                    { value: 'ic', label: 'IC 自带生图' },
                  ]}
                />
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                  {cfg.generation?.assetImageSource === 'ic'
                    ? 'IC 按资产提示词自己文生图 / 图生图、换装、年龄变体（上游原流程）。'
                    : '人物、场景、道具、服装图由 Muse 在 IC 外制作入库，由我们的 Agent 绑定；IC 不生图、不改图、不换装，缺的图只记进缺件单。音色照常由 IC 生成。项目里单独设过「缺件单 / 自动」的，按项目设置。'}
                </p>
              </div>
              <div className="hairline" />
              <Segmented
                value={isRunningHub ? 'runninghub' : hwMode}
                onChange={switchMode}
                options={[
                  { value: 'nvidia', label: '英伟达 · 原版工作流' },
                  { value: 'amd', label: 'AMD · GGUF 量化适配' },
                  { value: 'runninghub', label: 'RunningHub · 云端渲染' },
                ]}
              />
              <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                当前执行端：<b className="text-[var(--fg-2)]">{isRunningHub ? '云端渲染' : '本地 ComfyUI'}</b>
                {' · '}有效并发 <b className="text-[var(--fg-2)]">{isRunningHub ? Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1) : Math.max(1, enabledComfyEndpoints(cfg.comfyui).length)}</b>
                {isRunningHub
                  ? '（由下方「任务并发数量」控制，保存后立即生效）'
                  : '（= 启用的端点数：每个 ComfyUI 实例单队列串行，渲染按空闲端点分派；多张显卡请每卡启动一个实例后在下方添加）'}
              </p>

              {!isRunningHub ? (
                <>
                  <ComfyEndpointsEditor
                    comfyui={cfg.comfyui}
                    onChange={(endpoints) => setCfg((c) => ({ ...c, comfyui: { ...c.comfyui, endpoints, baseUrl: (endpoints.find((e) => e.enabled && e.baseUrl) || endpoints[0] || {}).baseUrl || c.comfyui.baseUrl } }))}
                  />
                  <Field
                    label="服务说明"
                    hint={
                      <span>
                        可以自行部署并ComfyUI跑通项目文件夹 /comfyui_original_workflows/NVIDIA/ 中的示例工作流，或者获取项目配套的ComfyUI工作流本地一键启动整合包可从{' '}
                        <a href="https://pan.quark.cn/s/9748d626c346?pwd=7NcR" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                          夸克网盘https://pan.quark.cn/s/9748d626c346?pwd=7NcR
                        </a>{' '}
                        ，打开链接即可获取。
                        <br />
                        <span className="text-[var(--danger)]">第三方服务免责声明：ComfyUI一键整合包是请第三方大佬做的，可能会包含第三方网站涉及的一些收费相关问题，制作不易理性支持。请仔细查验以免被骗，不要相信任何加你联系方式的陌生人卖你的资料。</span>
                      </span>
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="md" onClick={testComfy}>
                        测试全部启用端点
                      </Button>
                    </div>
                  </Field>
                  <TestResult text={test} />
                </>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="Api-key"
                      hint={
                        <span>
                          云端渲染执行，无需本地显卡。可从{' '}
                          <a
                            href="https://www.runninghub.cn/call-api/bill-task?tab=keys&type=consumer&inviteCode=6to0etcb"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] hover:underline"
                          >
                            这里查询 Api-key
                          </a>{' '}
                          获取。
                        </span>
                      }
                    >
                      <Input
                        type="password"
                        value={cfg.comfyui.apiKey || ''}
                        onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, apiKey: e.target.value } })}
                        placeholder="请输入云端渲染 Api-key"
                      />
                    </Field>
                    <Field label="版本">
                      <Select value={cfg.comfyui.tier || 'standard'} onChange={(v) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, tier: v } })} items={TIER_OPTIONS} />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="md" onClick={testComfy}>
                      测试连接
                    </Button>
                    <span className="font-mono text-[10.5px] text-[var(--fg-4)]">最终服务 URL：{comfyBaseUrl(cfg)}</span>
                  </div>
                  <TestResult text={test} />
                  <Field label="任务并发数量（Beta）" hint="并发过高可能触发云端限流或排队。">
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={String(cfg.generation.runninghubConcurrency ?? 1)}
                      onChange={(e) =>
                        setCfg({ ...cfg, generation: { ...cfg.generation, runninghubConcurrency: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))) } })
                      }
                      className="w-28"
                    />
                  </Field>

                  <div className="rounded-xl border border-[var(--line)] bg-white/[0.015] p-3.5">
                    <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">多用户排队调度</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--fg-4)]">
                      全局槽位 = 上面的「任务并发数量」。开启后按在线人数动态分配，一人独占时可用满全部槽位，多人时自动收缩、批量提交不会堵死后来者。
                      默认关闭：按提交顺序渲染，不做用户间轮转，排队超时与生成超时都不生效（渲染再慢也会一直等，只能手动停止）。
                    </p>
                    <Switch
                      className="mt-3"
                      checked={queue.enabled === true}
                      onChange={(v) => setQueue({ enabled: v })}
                      label="启用多用户排队调度"
                      hint="多人共用同一个渲染账号时才需要打开；单人自用建议保持关闭。保存后立即生效（无需重启）。"
                    />
                    <fieldset
                      disabled={queue.enabled !== true}
                      className={'mt-3 grid min-w-0 gap-3 sm:grid-cols-2' + (queue.enabled === true ? '' : ' opacity-45')}
                    >
                      <Field label="单用户并发上限" hint="0 = 按在线人数自动（推荐）">
                        <Input
                          type="number"
                          min={0}
                          max={20}
                          value={String(queue.perUserConcurrency ?? 0)}
                          onChange={(e) => setQueue({ perUserConcurrency: clampInt(e.target.value, 0, 20, 0) })}
                          className="w-28"
                        />
                      </Field>
                      <Field label="每人最多排队" hint="超出直接拒绝，防止队列无限膨胀">
                        <Input
                          type="number"
                          min={1}
                          max={500}
                          value={String(queue.perUserMaxWaiting ?? 50)}
                          onChange={(e) => setQueue({ perUserMaxWaiting: clampInt(e.target.value, 1, 500, 50) })}
                          className="w-28"
                        />
                      </Field>
                      <Field label="等待提权（分钟）" hint="排队超过该时长自动优先，防止饿死">
                        <Input
                          type="number"
                          min={0}
                          max={180}
                          value={String(queue.agingMinutes ?? 15)}
                          onChange={(e) => setQueue({ agingMinutes: clampInt(e.target.value, 0, 180, 15) })}
                          className="w-28"
                        />
                      </Field>
                      <Field
                        label="排队超时（分钟）"
                        hint={queue.enabled === true ? '等不到槽位就主动放弃' : '排队调度关闭时不生效，任务不会因等待超时被放弃'}
                      >
                        <Input
                          type="number"
                          min={1}
                          max={720}
                          value={String(queue.queueTimeoutMinutes ?? 120)}
                          onChange={(e) => setQueue({ queueTimeoutMinutes: clampInt(e.target.value, 1, 720, 120) })}
                          className="w-28"
                        />
                      </Field>
                      <Field label="失败自动重试" hint="仅网络/超时类错误会重试">
                        <Input
                          type="number"
                          min={0}
                          max={5}
                          value={String(queue.retryTimes ?? 2)}
                          onChange={(e) => setQueue({ retryTimes: clampInt(e.target.value, 0, 5, 2) })}
                          className="w-28"
                        />
                      </Field>
                      <Field label="余额不足自动暂停（分钟）" hint="命中配额错误时暂停派发，任务不丢">
                        <Input
                          type="number"
                          min={0}
                          max={120}
                          value={String(queue.pauseOnQuotaErrorMinutes ?? 10)}
                          onChange={(e) => setQueue({ pauseOnQuotaErrorMinutes: clampInt(e.target.value, 0, 120, 10) })}
                          className="w-28"
                        />
                      </Field>
                      <Field label="图片保底槽位" hint="有积压时优先保留，避免被长视频堵死">
                        <Input
                          type="number"
                          min={0}
                          max={20}
                          value={String(queue.pools?.image?.min ?? 1)}
                          onChange={(e) => setPoolMin('image', clampInt(e.target.value, 0, 20, 1))}
                          className="w-28"
                        />
                      </Field>
                      <Field label="视频保底槽位">
                        <Input
                          type="number"
                          min={0}
                          max={20}
                          value={String(queue.pools?.video?.min ?? 1)}
                          onChange={(e) => setPoolMin('video', clampInt(e.target.value, 0, 20, 1))}
                          className="w-28"
                        />
                      </Field>
                    </fieldset>
                  </div>
                </>
              )}

              <div className="flex flex-col gap-4 border-t border-[var(--line)] pt-4">
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-3)]">
                  {isRunningHub
                    ? '云端 RunningHub 使用云端工作流，可在下方查看或自定义各任务类型对应的工作流；保存设置后生效。'
                    : '默认英伟达原版；AMD 模式额外启用显存释放与分阶段运行的显存 / CK 拦截。为每个任务类型指定 ComfyUI 工作流，可提交自定义工作流并配置输入 / 输出节点；保存设置后生效。'}
                </p>
                <WorkflowConfigPanel cfg={cfg} setCfg={setCfg} workflows={workflows} mode={isRunningHub ? 'runninghub' : hwMode} onReloadWorkflows={reloadWorkflows} />
                {!isRunningHub && hwMode === 'amd' ? (
                  <div className="flex flex-col gap-2 rounded-xl border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] p-3.5">
                    <Field
                      label="每 N 个生成后释放 ComfyUI 显存（0 = 关闭）"
                      hint="利：避免 AMD Dynamic VRAM 连续生成后逐步变慢。弊：每次释放后下一次生成多花 1 - 3 分钟重载模型。"
                    >
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        value={String(cfg.generation.freeAfterEvery ?? 0)}
                        onChange={(e) =>
                          setCfg({ ...cfg, generation: { ...cfg.generation, freeAfterEvery: Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))) } })
                        }
                        className="w-24"
                      />
                    </Field>
                    {comfyInfo && comfyInfo.ok === false ? (
                      <p className="m-0 text-[11px] text-[var(--fg-3)]">当前 ComfyUI 连接失败，无法判断 Dynamic VRAM 状态，建议先测试连接。</p>
                    ) : null}
                    {comfyInfo && comfyInfo.ok && !comfyInfo.dynamicVram && (cfg.generation.freeAfterEvery ?? 0) > 0 ? (
                      <p className="m-0 text-[11px] text-[var(--accent)]">检测到 ComfyUI 未启用 Dynamic VRAM，连续生成不会产生退化，建议把 N 设为 0。</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}

          {active === 'upscale2k' ? (
            <Section icon={Film} title="升级2K" description="给已有成片做画质增强；原片始终保留，升级版与原片可切换选用。此处单独保存。">
              <UpscaleSettings />
            </Section>
          ) : null}

          {active === 'subtitle' ? (
            <Section icon={Captions} title="字幕与语音识别" description="导出成片时用 whisper 按实际音轨生成字幕">
              <SubtitlePanel cfg={cfg} setCfg={setCfg} />
            </Section>
          ) : null}

          {active === 'agent' ? (
            <Section icon={Bot} title="Agent 运行时 · 大脑" description="剧本、分镜、提示词撰写与改写统一由这里的运行时完成">
              <Segmented
                value={isExternalAgent ? 'external' : 'openclaude'}
                onChange={switchAgentMode}
                options={[
                  { value: 'external', label: '外部 Agent（本机 CLI）' },
                  { value: 'openclaude', label: '内置 openclaude（OpenAI 兼容接口）' },
                ]}
              />
              <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                {isExternalAgent
                  ? '外部 Agent 使用它自己的模型与登录态：流水线任务通过本地 MCP 服务调用本项目的领域工具；剧本生成/改写、按技能写提示词、反馈改写（仅 LLM 改写）等一问一答也由它完成。'
                  : '内置 openclaude 的大脑就是下方的 OpenAI 兼容接口：流水线任务与剧本/提示词/改写等一问一答都打到这个接口。'}
              </p>

              {isExternalAgent ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                    <Field label="选择 Agent" hint="未安装的 CLI 也能先选中，装好后再点「重新检测」。">
                      <Select
                        value={agentRuntime}
                        onChange={(v) => {
                          if (!v) return;
                          setAgent({ runtime: v });
                          setAgentTest('');
                          setBrainTest('');
                        }}
                        disabled={agentsLoading}
                        items={[
                          ...externalAgents.map((a) => ({ value: a.id, label: a.name + (a.available ? '' : '（未安装）') })),
                          { value: 'custom', label: '自定义 CLI' },
                        ]}
                      />
                    </Field>
                    <Button variant="secondary" size="md" loading={agentsLoading} onClick={() => loadAgents(true)}>
                      重新检测
                    </Button>
                    <Button variant="secondary" size="md" disabled={agentsLoading} onClick={testAgent}>
                      检测可执行
                    </Button>
                  </div>

                  {agentsErr ? <p className="m-0 text-[11.5px] text-[var(--danger)]">检测失败：{agentsErr}</p> : null}

                  {selectedAgent && selectedAgent.available ? (
                    <p className="m-0 text-[11.5px] text-[var(--success)]">
                      ✅ 已安装{selectedAgent.version ? ' · ' + selectedAgent.version : ''}
                      {selectedAgent.path ? ' · ' + selectedAgent.path : ''}
                    </p>
                  ) : null}
                  {selectedAgent && !selectedAgent.available ? (
                    <p className="m-0 text-[11.5px] text-[var(--fg-3)]">
                      ❌ 未安装{selectedAgent.bin ? '：' + selectedAgent.bin : ''}
                      {selectedAgent.installUrl ? (
                        <>
                          {' · '}
                          <a href={selectedAgent.installUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                            安装说明
                          </a>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {selectedAgent?.hint ? <p className="m-0 text-[11.5px] text-[var(--accent)]">⚠ {selectedAgent.hint}</p> : null}
                  {selectedAgent && selectedAgent.textChat === false ? (
                    <p className="m-0 text-[11.5px] text-[var(--accent)]">
                      ⚠ {selectedAgent.name} 目前只接流水线任务（MCP），暂不支持剧本/提示词改写这类一问一答：
                      {agentCfg.llmFallback ? '这些调用会回落到下方 OpenAI 兼容接口。' : '这些调用会直接报错，建议打开下方「回落」。'}
                    </p>
                  ) : null}
                  {agentTest ? (
                    <p className={`m-0 text-[11.5px] ${agentTest.startsWith('可用') ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                      {agentTest}
                    </p>
                  ) : null}

                  <Field label="文本调用模型" hint="剧本 / 提示词 / 改写这类一问一答用的模型；留空 = 跟随 CLI 自己的默认模型。Claude Code 可填 opus、sonnet 等。">
                    <Input
                      value={agentCfg.textModel || ''}
                      onChange={(e) => setAgent({ textModel: e.target.value })}
                      placeholder="留空 = CLI 默认"
                      className="w-64"
                    />
                  </Field>

                  {agentRuntime === 'custom' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="名称">
                        <Input value={customCfg.name || ''} onChange={(e) => setAgentCustom({ name: e.target.value })} placeholder="自定义 CLI" />
                      </Field>
                      <Field label="可执行文件" hint="例如 my-agent 或 /usr/local/bin/my-agent">
                        <Input value={customCfg.bin || ''} onChange={(e) => setAgentCustom({ bin: e.target.value })} placeholder="my-agent" />
                      </Field>
                      <Field label="启动参数" className="sm:col-span-2" hint="例如 --print 或 -p {prompt}；支持 {mcpConfig}">
                        <Input value={customCfg.args || ''} onChange={(e) => setAgentCustom({ args: e.target.value })} placeholder="--print" />
                      </Field>
                      <div className="sm:col-span-2">
                        <Switch
                          checked={customCfg.promptViaStdin !== false}
                          onChange={(v) => setAgentCustom({ promptViaStdin: v })}
                          label="通过 stdin 传入 prompt（推荐）"
                          hint="关闭后 prompt 会拼在启动参数末尾。一问一答时 stdout 全文即结果。"
                        />
                      </div>
                      <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)] sm:col-span-2">
                        自定义 CLI 需要自行接入 MCP：把下方配置加到它的 MCP 设置中；任务运行时本项目会注入 IC_MCP_* 环境变量。
                      </p>
                      {mcpServer ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] px-3 py-2.5 sm:col-span-2">
                          <Button variant="secondary" size="sm" onClick={copyMcpConfig}>
                            复制 MCP 配置
                          </Button>
                          <span className="min-w-0 break-all font-mono text-[10.5px] text-[var(--fg-3)]">
                            {mcpServer.command} {mcpServer.args.join(' ')}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <Field label="额外 PATH" hint="可选；多个目录用系统 PATH 分隔符（macOS/Linux 为 :，Windows 为 ;）。">
                    <Input
                      value={agentCfg.extraPath || ''}
                      onChange={(e) => setAgent({ extraPath: e.target.value })}
                      placeholder="/opt/homebrew/bin:/usr/local/bin"
                    />
                  </Field>

                  <p className="m-0 rounded-xl border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--fg-3)]">
                    外部 Agent 使用其自身模型与登录态；本项目通过本地 MCP 服务提供领域工具（一问一答不挂 MCP、禁用文件/命令工具）。外部 Agent 拥有其 CLI 自身权限，请只选择可信 Agent，首次运行请在任务日志确认工具调用。
                  </p>
                </>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="md" onClick={testBrain}>
                  试跑一句
                </Button>
                <TestResult text={brainTest} />
              </div>
              <p className="m-0 -mt-1 text-[11px] text-[var(--fg-4)]">按当前（未保存也算）的设置真的问一句「回复 OK」，会消耗一次极短的模型调用。</p>

              <div className="hairline" />

              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-[12.5px] font-medium text-[var(--fg-2)]">OpenAI 兼容接口</h3>
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
                  {isExternalAgent ? '外部 Agent 模式下作后备：仅在外部 Agent 不可用（未安装 / 未登录 / 超时 / 不支持一问一答）且打开「回落」时使用。' : '内置 openclaude 的模型配置（原「LLM 模型」）。'}
                </p>
              </div>

              {isExternalAgent ? (
                <Switch
                  checked={!!agentCfg.llmFallback}
                  onChange={(v) => setAgent({ llmFallback: v })}
                  label="外部 Agent 不可用时回落 OpenAI 兼容接口"
                  hint="关闭时外部 Agent 失败就直接报错（不会悄悄换模型）。打开前请确认下方接口已填好 Base URL / API Key 并「测试连接」通过。"
                />
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Base URL" hint="需以 /v1 结尾。" className="sm:col-span-2">
                  <Input value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} placeholder="https://api.example.com/v1" />
                </Field>
                <Field label="模型">
                  <Input value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} placeholder="模型名" />
                </Field>
                <Field label="API Key">
                  <Input
                    type="password"
                    value={cfg.llm.apiKey || ''}
                    onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })}
                    placeholder="API Key"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="md" onClick={testLlm}>
                  测试连接
                </Button>
                <TestResult text={llmTest} />
              </div>

              <div className="hairline" />

              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-[12.5px] font-medium text-[var(--fg-2)]">图片输入与改写</h3>
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">对当前运行时生效（外部 Agent 或 OpenAI 兼容接口）。</p>
              </div>
              <Switch
                checked={!!cfg.llm.vision}
                onChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: v } })}
                label="支持图片输入（多模态 / 视觉模型）"
                hint="开启后，写分镜 / 图生图提示词、反馈改写、参考图命名时会把参考图交给大脑；Claude Code 原生支持，OpenAI 兼容接口请确认模型支持视觉。"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="提示词改写语言" hint="分镜反馈选择「仅 LLM 改写」时的输出语言。">
                  <Select
                    value={cfg.llm.rewriteLanguage || 'same'}
                    onChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, rewriteLanguage: v } })}
                    items={REWRITE_LANG_OPTIONS}
                  />
                </Field>
                <Field label="改写最大输出（token）" hint="默认 4000；范围 256 - 32768。只对 OpenAI 兼容接口生效（外部 CLI 不支持限长）。">
                  <Input
                    type="number"
                    min={256}
                    max={32768}
                    value={String(cfg.llm.rewriteMaxTokens ?? 4000)}
                    onChange={(e) =>
                      setCfg({ ...cfg, llm: { ...cfg.llm, rewriteMaxTokens: Math.max(256, Math.min(32768, Math.round(Number(e.target.value) || 0))) } })
                    }
                  />
                </Field>
              </div>
              <details className="rounded-xl border border-[var(--line)] bg-white/[0.015] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
                <summary className="cursor-pointer text-[var(--fg-3)] hover:text-[var(--fg-2)]">为什么需要设置改写输出上限？</summary>
                <p className="m-0 mt-2">
                  思考型模型会先输出 reasoning、再写正文，二者共用这一份预算；预算不足时正文会被截断，表现为改写只剩一两句、参考占位符丢失。
                  建议默认 4000；任务报「LLM 输出被截断」时优先调大。
                </p>
              </details>
            </Section>
          ) : null}

          {active === 'claudeapi' ? (
            <Section icon={KeyRound} title="Claude API 密钥" description="给指挥系统里的 Claude 会话用；只存在本机 local_secrets，不写 config.json；保存后只显示末 4 位，页面和日志都不回显密钥。与「指挥 → 设置」是同一份。">
              <ApiKeyCard />
            </Section>
          ) : null}

          {active === 'skills' ? (
            <Section icon={Wand2} title="技能库" description="扩展 Agent 的剧本、分镜与提示词能力">
              <SkillsPanel />
            </Section>
          ) : null}

          {active === 'pipeline' ? (
            <Section icon={Workflow} title="流水线编排" badge="BETA" description="按环节指定生成时优先加载的技能，缺失时自动匹配其它技能">
              <SkillPipelinePanel cfg={cfg} setCfg={setCfg} setSavedCfg={setSavedCfg} />
            </Section>
          ) : null}

          {dirty ? (
            <div className="sticky bottom-4 z-40 flex items-center justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--panel)_92%,var(--accent)_8%)] px-4 py-2.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,.95)] backdrop-blur">
              <span className="flex items-center gap-2 text-[12px] text-[var(--fg-2)]">
                <Badge tone="accent" dot>未保存</Badge>
                配置有修改，保存后生效
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCfg(savedCfg)}>
                  放弃修改
                </Button>
                <Button variant="primary" size="sm" loading={saving} onClick={save}>
                  <Save size={13} /> 保存
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, description, badge, children }) {
  return (
    <section className="panel flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-[14px] font-semibold text-[var(--fg)]">{title}</h2>
            {badge ? (
              <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? <p className="m-0 mt-0.5 text-[11.5px] text-[var(--fg-3)]">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function timeLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isRunningHubCfg(cfg) {
  return cfg?.comfyui?.provider === 'runninghub';
}

// 本地 ComfyUI 端点列表（多显卡）：每行 = 地址 + 显卡编号 + 启用开关 + 测试连接。
// 有效并发 = 启用的端点数；调度器把每次渲染派给空闲端点，单个端点连不上会自动改派其它端点。
function ComfyEndpointsEditor({ comfyui, onChange }) {
  const endpoints = normalizeComfyEndpoints(comfyui);
  const [results, setResults] = useState({});
  const [testing, setTesting] = useState({});
  const update = (i, patch) => onChange(endpoints.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const remove = (i) => onChange(endpoints.filter((_, j) => j !== i));
  const add = () => {
    const used = new Set(endpoints.map((e) => e.id));
    let n = endpoints.length;
    while (used.has('gpu' + n)) n++;
    // 建议地址：在最后一个端点的端口上 +1（8189 → 8190）
    let next = '';
    const m = /^(.*:)(\d+)$/.exec(endpoints[endpoints.length - 1]?.baseUrl || '');
    if (m) next = m[1] + (Number(m[2]) + 1);
    onChange([...endpoints, { id: 'gpu' + n, name: 'GPU ' + n, baseUrl: next || 'http://127.0.0.1:8190', gpu: String(n), enabled: false }]);
  };
  const testOne = async (e) => {
    setTesting((t) => ({ ...t, [e.id]: true }));
    try {
      const r = await api.post('/api/comfyui/test', { baseUrl: e.baseUrl });
      setResults((s) => ({ ...s, [e.id]: timeLabel() + ' · ' + (r.ok ? '连接成功 · ' + r.system + ' · ' + r.device + (r.vramFree ? ' · 空闲显存 ' + Math.round(r.vramFree / 1024 ** 3) + ' GB' : '') : '连接失败：' + r.error) }));
    } catch (err) {
      setResults((s) => ({ ...s, [e.id]: timeLabel() + ' · 失败：' + err.message }));
    } finally {
      setTesting((t) => ({ ...t, [e.id]: false }));
    }
  };
  const enabledCount = enabledComfyEndpoints({ endpoints }).length;
  return (
    <Field
      label={'本地端点（启用 ' + enabledCount + ' / 共 ' + endpoints.length + '）'}
      hint="每张显卡启动一个 ComfyUI 实例（各自端口，启动脚本用 --cuda-device 绑卡，共享模型目录）。显卡编号只用于展示与核对，绑卡在启动脚本里完成。新加的端点默认不启用，测试连接成功后再打开。"
      action={
        <Button variant="secondary" size="xs" onClick={add}>
          添加端点
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {endpoints.map((e, i) => (
          <div key={e.id} className="rounded-xl border border-[var(--line)] bg-white/[0.015] p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Switch checked={e.enabled} onChange={(v) => update(i, { enabled: v })} />
              <Input value={e.name} onChange={(ev) => update(i, { name: ev.target.value })} placeholder="名称" className="w-28" />
              <Input value={e.baseUrl} onChange={(ev) => update(i, { baseUrl: ev.target.value })} placeholder="http://127.0.0.1:8190" className="min-w-[200px] flex-1" />
              <span className="text-[11px] text-[var(--fg-4)]">显卡</span>
              <Input value={e.gpu} onChange={(ev) => update(i, { gpu: ev.target.value })} placeholder="0" className="w-14" />
              <Button variant="secondary" size="sm" loading={!!testing[e.id]} onClick={() => testOne(e)}>
                测试连接
              </Button>
              <Button variant="ghost" size="sm" disabled={endpoints.length <= 1} onClick={() => remove(i)}>
                删除
              </Button>
            </div>
            {results[e.id] ? (
              <div className="mt-1.5">
                <TestResult text={results[e.id]} />
              </div>
            ) : null}
          </div>
        ))}
        {enabledCount === 0 ? (
          <span className="text-[11.5px] text-[var(--danger)]">没有启用的端点：本地渲染将无法执行，请至少启用一个。</span>
        ) : null}
      </div>
    </Field>
  );
}

function TestResult({ text }) {
  if (!text) return null;
  const ok = text.includes('成功');
  return (
    <span className={ok ? 'flex items-start gap-1.5 text-[11.5px] text-[var(--success)]' : 'flex items-start gap-1.5 text-[11.5px] text-[var(--danger)]'}>
      <span className="mt-[1px] shrink-0">{ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}</span>
      <span className="break-all">{text}</span>
    </span>
  );
}

function ReadonlyRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="text-[var(--fg-4)]">{label}</span>
      <span className="truncate font-mono text-[10.5px] text-[var(--fg-2)]" title={value}>
        {value || '—'}
      </span>
    </div>
  );
}

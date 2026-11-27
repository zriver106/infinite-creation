import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { STYLE_CUSTOM, resolveStyle, splitStyle, VIDEO_RESOLUTION_CUSTOM, IMAGE_RESOLUTION_ITEMS } from '../lib/shared.js';
import { RESOLUTION_SELECT_ITEMS, RATIO_SELECT_ITEMS } from './visuals.jsx';
import { Button, Field, Input, Select, Switch } from './ui.jsx';
import { FormSection, Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';
import StylePicker from './StylePicker.jsx';
import { EXPRESSION_SWITCHES, expressionSwitchValues } from '@shared';

// 出图方式（Andy 11-26）：项目级覆盖系统设置「资产出图方式」。存 projects.context.asset_mode（PUT /asset-settings）。
const ASSET_MODE_ITEMS = [
  { value: 'inherit', label: '跟随系统设置' },
  { value: 'gap-list', label: 'Muse 出图' },
  { value: 'auto', label: '本地模型（IC 生图）' },
];
const assetModeOf = (project) => { const v = (project && project.context && project.context.asset_mode) || ''; return v === 'gap-list' || v === 'auto' ? v : 'inherit'; };

export default function ProjectSettingsDialog({ open, onOpenChange, project, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [styleSel, setStyleSel] = useState('');
  const [customStyle, setCustomStyle] = useState('');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [imageRes, setImageRes] = useState('1K');
  const [assetMode, setAssetMode] = useState('inherit');
  const [cw, setCw] = useState('');
  const [ch, setCh] = useState('');
  const [enableBgm, setEnableBgm] = useState(true);
  const [enableSub, setEnableSub] = useState(true);
  const [autoScript, setAutoScript] = useState(true);
  // 表现手段开关：Q版插入 / 夸张特效 / 网络流行语与谐音 / 段子与接梗（老项目缺字段视为开）
  const [exprSwitches, setExprSwitches] = useState(() => expressionSwitchValues(null));
  const [saving, setSaving] = useState(false);
  // am 线程表（资产出图：一个线程一个车道；总导 11-26）
  const [threads, setThreads] = useState([]);

  useEffect(() => {
    if (!open || !project) return;
    const init = splitStyle(project.style);
    setName(project.name || '');
    setStyleSel(init.sel);
    setCustomStyle(init.custom);
    setRes(project.video_resolution || '480P');
    setRatio(project.video_aspect_ratio || '16:9');
    setImageRes(project.image_resolution || '1K');
    setAssetMode(assetModeOf(project));
    setCw(project.video_width ? String(project.video_width) : '');
    setCh(project.video_height ? String(project.video_height) : '');
    setEnableBgm(project.enable_bgm !== false);
    setEnableSub(project.enable_subtitles !== false);
    setAutoScript(project.auto_script !== false);
    setExprSwitches(expressionSwitchValues(project));
    setThreads(((project.context && project.context.asset_image_threads) || []).map((t) => ({ ...t })));
  }, [open, project]);

  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/projects/' + project.id, {
        name: name.trim(),
        style: resolveStyle(styleSel, customStyle),
        video_resolution: res,
        video_aspect_ratio: ratio,
        video_width: Number(cw) || 0,
        video_height: Number(ch) || 0,
        image_resolution: imageRes,
        enable_bgm: enableBgm,
        enable_subtitles: enableSub,
        auto_script: autoScript,
        ...exprSwitches,
      });
      if (assetMode !== assetModeOf(project)) await api.put('/api/projects/' + project.id + '/asset-settings', { mode: assetMode });
      const cleanThreads = threads.filter((t) => String(t.name || '').trim() && String(t.session || '').trim());
      if (cleanThreads.length && JSON.stringify(cleanThreads) !== JSON.stringify((project.context && project.context.asset_image_threads) || [])) {
        await api.post('/api/projects/' + project.id + '/asset-images', { action: 'threads', threads: cleanThreads });
      }
      toast.success('项目设置已保存');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title="项目设置"
      description="修改项目名、画面风格与成片参数；章节与素材在各自页面管理。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="md" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" size="md" loading={saving} disabled={!name.trim() || saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FormSection index="01" title="基本信息">
          <Field label="项目名" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="画面风格">
            <StylePicker value={styleSel} onChange={(style) => setStyleSel(style)} />
          </Field>
          {styleSel === STYLE_CUSTOM ? (
            <Input value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} placeholder="请填写自定义风格" />
          ) : null}
        </FormSection>

        <div className="hairline" />

        <FormSection index="02" title="视频参数">
          <div className="grid grid-cols-2 gap-3">
            <Field label="分辨率">
              <Select value={res} onChange={setRes} items={RESOLUTION_SELECT_ITEMS} />
            </Field>
            <Field label="宽高比">
              <Select value={ratio} onChange={setRatio} items={RATIO_SELECT_ITEMS} />
            </Field>
          </div>
          {res === VIDEO_RESOLUTION_CUSTOM ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="宽度（px）">
                <Input type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" />
              </Field>
              <Field label="高度（px）">
                <Input type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" />
              </Field>
            </div>
          ) : null}
          <div className="flex flex-col gap-3 pt-1">
            <Switch
              checked={enableBgm}
              onChange={setEnableBgm}
              label="自动生成背景音乐"
              hint="开启后，视频阶段会自动生成纯音乐并合成到成片。"
            />
            <Switch
              checked={enableSub}
              onChange={setEnableSub}
              label="自动添加字幕"
              hint="按「设置 → 字幕与语音识别」选择的模式烧录：语音识别（需 Python 环境）或分镜台词（不显示角色名）。"
            />
            <Switch
              checked={autoScript}
              onChange={setAutoScript}
              label="自动生成剧本"
              hint="开启后，剧本为空的章节会先由 Agent 写剧本再拆分镜；关闭后需先在章节「剧本」里编写或粘贴。"
            />
          </div>
        </FormSection>

        <div className="hairline" />

        <FormSection index="03" title="图片参数" description="素材库新建或重新生成的图片使用该档位">
          <Field
            label="图片分辨率"
            hint="1K / 2K / 4K，按各素材宽高比自动换算像素（32 的倍数）；文生图直接按档位出图，图生图生成后归一化到该档位。"
          >
            <Select value={imageRes} onChange={setImageRes} items={IMAGE_RESOLUTION_ITEMS} />
          </Field>
          <Field
            label="出图方式"
            hint={assetMode === 'auto'
              ? '本地模型：IC 用本机 ComfyUI 自己文生图 / 图生图、换装、年龄变体，占显卡。'
              : assetMode === 'gap-list'
                ? 'Muse 出图：IC 按缺图单派 am 出图，IC 的审图 Agent 审过就入库、不过自动退回返修（素材库页「资产出图」点按钮）；音色照常由 IC 生成。'
                : '跟随「系统设置 → ComfyUI 服务 → 资产出图方式」。'}
          >
            <Select value={assetMode} onChange={setAssetMode} items={ASSET_MODE_ITEMS} />
          </Field>
          <Field label="am 线程" hint="资产出图派单用的 am 会话：一个线程一个车道（人物 / 场景 / 道具UI），线程数就是并行数。会话 id 用 muse-cli threads 查。">
            <div className="flex flex-col gap-1.5">
              {threads.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input className="w-[90px]" value={t.name || ''} placeholder="名称" onChange={(e) => setThreads((ts) => ts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <Input className="flex-1" value={t.session || ''} placeholder="am 会话 id" onChange={(e) => setThreads((ts) => ts.map((x, j) => (j === i ? { ...x, session: e.target.value } : x)))} />
                  <Select className="w-[100px]" value={t.lane || 'person'} onChange={(v) => setThreads((ts) => ts.map((x, j) => (j === i ? { ...x, lane: v } : x)))} items={[{ value: 'person', label: '人物' }, { value: 'scene', label: '场景' }, { value: 'prop', label: '道具UI' }]} />
                  <Button variant="ghost" size="sm" onClick={() => setThreads((ts) => ts.filter((_, j) => j !== i))}>删</Button>
                </div>
              ))}
              <Button variant="secondary" size="sm" className="self-start" onClick={() => setThreads((ts) => [...ts, { name: '', session: '', lane: 'person' }])}>加一个线程</Button>
            </div>
          </Field>
        </FormSection>

        <div className="hairline" />

        <FormSection index="04" title="表现手段">
          <div className="flex flex-col gap-3 pt-1">
            {EXPRESSION_SWITCHES.map((s) => (
              <Switch
                key={s.key}
                checked={exprSwitches[s.key] !== false}
                onChange={(v) => setExprSwitches((prev) => ({ ...prev, [s.key]: !!v }))}
                label={s.label}
                hint={s.hint}
              />
            ))}
          </div>
        </FormSection>
      </div>
    </Modal>
  );
}

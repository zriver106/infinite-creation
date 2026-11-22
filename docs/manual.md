# 手册（Studio「手册」菜单）

创作菜单里的「手册」用来查看和编辑制作规则。页面上改的和磁盘上的是同一份文件，不要另备一份再手工同步。

## 目录结构

由环境变量 `IC_MANUAL_DIR` 指定根目录；未设置时使用 `data/manual/`（该路径通常被 `.gitignore` 忽略，适合本地手册，不进仓库）。

```
<IC_MANUAL_DIR>/
  manual.json          # 分类与文档清单（配置驱动，加类只需改这份或用页面「新增分类」）
  分镜/*.md
  提示词/*.md
  运镜/*.md
  剪辑/*.md
  _backup/             # 保存前自动生成的带时间戳备份，不要手改
```

未写进 `manual.json` 的 `.md` 也会自动出现在对应分类下列表中。

## `manual.json` 示例

```json
{
  "version": 1,
  "title": "制作手册",
  "categories": [
    { "id": "storyboard", "title": "分镜", "dir": "分镜", "desc": "剧情节拍与镜头单位", "docs": [
      { "file": "01_example.md", "title": "示例文档", "status": "现行", "source": "" }
    ]},
    { "id": "prompt", "title": "提示词", "dir": "提示词", "desc": "", "docs": [] },
    { "id": "camera", "title": "运镜", "dir": "运镜", "desc": "", "docs": [] },
    { "id": "edit", "title": "剪辑", "dir": "剪辑", "desc": "", "docs": [] }
  ]
}
```

`status` 只能是 `现行` 或 `草案`（未确认的条目请标「草案」）。

## HTTP API

- `GET /api/manual` 分类与文档清单
- `POST /api/manual` 新增分类 `{ title, dir?, desc? }`
- `GET /api/manual/doc?cat=<id>&file=<name.md>` 读取正文
- `PUT /api/manual/doc` 保存正文 `{ cat, file, content, baseHash }`（`baseHash` 与当前文件不一致时返回 409，避免覆盖别人的改动）
- `POST /api/manual/doc` 新建文档 `{ cat, title, file? }`
- `PATCH /api/manual/doc` 改标题或状态 `{ cat, file, title?, status? }`

## 写提示词时读哪里

读 `IC_MANUAL_DIR`（或默认的 `data/manual/`）下的 `manual.json` 与各分类目录中的 Markdown，不要再维护第二份副本。

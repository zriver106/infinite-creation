# 首尾帧控制（手册 13 号 / 临时规则「首尾帧控制审图」，总导 11-28）：按一镜的首尾机位，从场景母本渲染透视灰模 + 真深度 + 线稿。
# 灰模给 ControlNet 当底图，深度/线稿当结构控制；人形占位（躯干＋头＋鼻子＋前伸小臂）把每个人朝哪边定死在结构里。
#
# 用法：python rig_render.py 母本.json 机位.json 输出目录
# 机位.json（朝向一律用母本的罗盘角：0=北、90=东；坐标：米，X 东、Y 北、Z 上）：
#   { "first": {"pos":[x,y], "eye":1.4, "yaw":160, "pitch":-6, "lens_mm":28},
#     "last":  {...},                       # 可省（只出首帧）
#     "W":1280, "H":720,
#     "people": [{"x":..,"y":..,"yaw":0,"pose":"sit|stand","role":"lead|bg|<人物名>","col":[r,g,b],"arms":true,"only":"first|last"}]
#               # 省略 = 母本座位全部坐满（L01 类 workstations 或 seats 表）；only 表示只在首帧或只在尾帧出现
#   }
# 输出：<输出目录>/<first|last>/{灰模,深度,线稿}.png，以及 meta.json（每个占位在画面里的位置，审图核人数用）。
import json, math, os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_master as SM
import scene_struct as SS
from scene_struct import box

SHIRT = (205, 203, 198); SKIN = (225, 190, 160); HAIR = (30, 30, 30); PANTS = (35, 40, 70)


def math_deg(compass):
    """罗盘角（0=北、90=东）→ 渲染器角（东=0、北=90）。"""
    return 90.0 - float(compass)


def _face_side(compass):
    return {0: 'n', 90: 'e', 180: 's', 270: 'w'}[int(round(float(compass) / 90.0) * 90) % 360]


def seated(x, y, compass, col, arms=True):
    a = math.radians(math_deg(compass)); fx, fy = math.cos(a), math.sin(a)
    f = box(x - 0.2, y - 0.2, 0.45, x + 0.2, y + 0.2, 0.62, {'side': (60, 60, 70)})
    tx, ty = x - fx * 0.05, y - fy * 0.05
    f += box(tx - 0.21, ty - 0.13, 0.62, tx + 0.21, ty + 0.13, 1.12, {'side': col})
    face = _face_side(compass); back = {'n': 's', 's': 'n', 'e': 'w', 'w': 'e'}[face]
    f += box(x - 0.1, y - 0.11, 1.14, x + 0.1, y + 0.11, 1.38, {'side': SKIN, face: SKIN, back: HAIR, 'top': HAIR})
    # 朝向线索：方块头前后对称，深度/线稿看不出脸朝哪，所以要鼻子和前伸小臂
    nx, ny = x + fx * 0.13, y + fy * 0.13
    f += box(nx - 0.025, ny - 0.025, 1.2, nx + 0.025, ny + 0.025, 1.27, {'side': SKIN})
    if arms:   # 主角不加：躯干框＋小臂在线稿里像一台显示器
        px, py = -fy, fx
        for sgn in (-1, 1):
            sx, sy = tx + px * 0.17 * sgn, ty + py * 0.17 * sgn
            ex, ey = sx + fx * 0.42, sy + fy * 0.42
            f += box(min(sx, ex) - 0.05, min(sy, ey) - 0.05, 0.74, max(sx, ex) + 0.05, max(sy, ey) + 0.05, 0.84, {'side': col})
    return f


def standing(x, y, compass, col):
    a = math.radians(math_deg(compass)); fx, fy = math.cos(a), math.sin(a); px, py = -fy, fx
    f = []
    for sgn in (-1, 1):
        lx, ly = x + px * 0.1 * sgn, y + py * 0.1 * sgn
        f += box(lx - 0.08, ly - 0.08, 0, lx + 0.08, ly + 0.08, 0.92, {'side': PANTS})
    f += box(x - 0.22, y - 0.14, 0.92, x + 0.22, y + 0.14, 1.5, {'side': col})
    for sgn in (-1, 1):
        ax, ay = x + px * 0.27 * sgn, y + py * 0.27 * sgn
        f += box(ax - 0.05, ay - 0.05, 0.85, ax + 0.05, ay + 0.05, 1.45, {'side': col})
    face = _face_side(compass); back = {'n': 's', 's': 'n', 'e': 'w', 'w': 'e'}[face]
    f += box(x - 0.1, y - 0.11, 1.52, x + 0.1, y + 0.11, 1.76, {'side': SKIN, face: SKIN, back: HAIR, 'top': HAIR})
    nx, ny = x + fx * 0.13, y + fy * 0.13
    f += box(nx - 0.025, ny - 0.025, 1.6, nx + 0.025, ny + 0.025, 1.67, {'side': SKIN})
    return f


def default_people(M):
    """母本座位全部坐满。L01 类（workstations.rows/cols，seating_rule 朝北）或 seats 表（at + yaw，罗盘角）。"""
    out = []
    ws = M.get('workstations')
    if ws and ws.get('rows') and ws.get('cols'):
        yaw = float(ws.get('yaw', 0) or 0)
        for r in ws['rows']:
            for c in ws['cols']:
                out.append({'x': c['x'], 'y': r.get('chair_y', r['y'] - 0.8), 'yaw': yaw, 'pose': 'sit', 'role': 'bg'})
    for s in M.get('seats') or []:
        at = s.get('at')
        if isinstance(at, (list, tuple)) and len(at) >= 2:
            out.append({'x': float(at[0]), 'y': float(at[1]), 'yaw': float(s.get('yaw') or 0), 'pose': 'sit', 'role': 'bg'})
    return out


def ref_colors(ref):
    """从人物定妆图取上衣 / 裤子颜色（图中间竖条的上段、下段取中位色）：灰模占位按人上色，
    出图时底图里就是「这个位置穿这身」，避免两个人物参考对调服装（试点第 3、4、18 镜）。"""
    try:
        im = Image.open(ref).convert('RGB'); W, H = im.size
        a = np.asarray(im.crop((int(W * 0.42), int(H * 0.32), int(W * 0.58), int(H * 0.52)))).reshape(-1, 3)
        b = np.asarray(im.crop((int(W * 0.44), int(H * 0.60), int(W * 0.56), int(H * 0.78)))).reshape(-1, 3)
        top = tuple(int(v) for v in np.median(a, axis=0)); bottom = tuple(int(v) for v in np.median(b, axis=0))
        return top, bottom
    except Exception:
        return None, None


def person_faces(p):
    col = tuple(p.get('col') or SHIRT)
    pants = None
    if p.get('ref') and not p.get('col'):
        top, bottom = ref_colors(p['ref'])
        if top: col = top
        pants = bottom
    if p.get('pose') == 'stand':
        global PANTS
        keep = PANTS
        if pants: PANTS = pants
        try: return standing(p['x'], p['y'], p.get('yaw', 0), col)
        finally: PANTS = keep
    return seated(p['x'], p['y'], p.get('yaw', 0), col, arms=p.get('arms', (p.get('role') or 'bg') == 'bg'))   # 只有背景人加前伸小臂


def render_one(M, cam_spec, people, W, H, out):
    os.makedirs(out, exist_ok=True)
    GL = {SM.C['glass'], SM.C['office_glass'], SM.C['acrylic'], SM.C['glass_counter']}
    sh, fc = SM.build(M, skip_wall=None, ceiling=True)
    for p in people: fc += person_faces(p)
    hfov = math.degrees(2 * math.atan(18.0 / float(cam_spec.get('lens_mm', 28))))
    pos = cam_spec['pos']
    cam = SS.Cam((pos[0], pos[1], cam_spec.get('eye', 1.45)), math_deg(cam_spec['yaw']), cam_spec.get('pitch', -6), W, H, hfov_deg=hfov)
    img = SS.raster(cam, sh, [x for x in fc if x[1] not in GL], transparent=[x for x in fc if x[1] in GL])
    zb = SS.LAST['zb']; ok = np.isfinite(zb); d = np.zeros(zb.shape, np.float32)
    if ok.any():
        lo, hi = np.percentile(zb[ok], 1), np.percentile(zb[ok], 99)
        d[ok] = 1.0 - np.clip((zb[ok] - lo) / max(1e-6, hi - lo), 0, 1)   # 近白远黑
    img.save(os.path.join(out, '灰模.png'))
    Image.fromarray((d * 255).astype(np.uint8)).convert('RGB').save(os.path.join(out, '深度.png'))
    Image.fromarray(np.where(SS.LAST['edge'], 255, 0).astype(np.uint8)).convert('RGB').save(os.path.join(out, '线稿.png'))
    # 每个占位头部中心投到画面：在不在画里、在左还是在右（审图核人数、核左右用）
    seen = []
    for p in people:
        z = 1.7 if p.get('pose') == 'stand' else 1.26
        c = cam.to_cam((p['x'], p['y'], z))
        if c[2] <= 0.05: continue
        u, v = cam.proj(c)
        if 0 <= u < W and 0 <= v < H:
            seen.append({'role': p.get('role', 'bg'), 'x': p['x'], 'y': p['y'], 'u': round(u / W, 3), 'v': round(v / H, 3), 'dist': round(c[2], 2)})
    return {'size': [W, H], 'people_in_frame': seen}


def main(mp, rp, out):
    M = json.load(open(mp, encoding='utf-8-sig')); R = json.load(open(rp, encoding='utf-8-sig'))
    W, H = int(R.get('W', 1280)), int(R.get('H', 720))
    # 背景同事永远按母本座位坐满；rig.people 只列剧中人物，叠上去，并把剧中人物坐着的那个座位让出来
    named = [p for p in (R.get('people') or []) if (p.get('role') or 'bg') != 'bg']
    bg = [p for p in (R.get('people') or []) if (p.get('role') or 'bg') == 'bg']
    if R.get('bg_from_master', True): bg = default_people(M) + bg
    taken = [p for p in named if p.get('pose') != 'stand']
    bg = [b for b in bg if all(math.hypot(b['x'] - q['x'], b['y'] - q['y']) > 0.45 for q in taken)]
    people = bg + named
    meta = {}
    for which in ('first', 'last'):
        spec = R.get(which)
        if not spec: continue
        ppl = [p for p in people if p.get('only') in (None, '', which)]
        meta[which] = render_one(M, spec, ppl, W, H, os.path.join(out, which))
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(json.dumps({'ok': True, 'views': list(meta.keys()), 'people': {k: len(v['people_in_frame']) for k, v in meta.items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main(*sys.argv[1:4])

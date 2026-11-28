# 场景结构资产导出（Andy 11-28 方法：三视图不能分别画，必须从同一个空间母本投影出来）。
# 场景 JSON → 方块灰模（同一份几何）→
#   正交：plan（顶视平面图，当 D）、front（从南往北的正视图）、left（从西往东的左视图）、right（从东往西的右视图）
#   透视：每个 Cam 的灰模（gray）和线稿（line），给 am 当构图底图做图生图
# 标注（名字、编号、P 点、机位、北向、比例尺）只叠在图层上，几何一笔不改。纯 PIL + numpy。
# 用法：python scene_struct.py scene.json 输出目录
import json, math, sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

COL = {
    'floor': (214, 210, 200), 'wall': (236, 233, 226), 'wall_dark': (222, 218, 210), 'ceiling': (244, 243, 240),
    'window': (170, 205, 230), 'door': (196, 160, 112), 'glass': (180, 215, 225),
    'desk_top': (245, 245, 245), 'desk_side': (200, 200, 200), 'partition': (150, 155, 160), 'partition_top': (130, 135, 140),
    'screen': (40, 110, 230), 'monitor_back': (25, 25, 25), 'seat': (215, 50, 45), 'backrest': (120, 20, 20),
    'office': (160, 200, 210), 'highlight': (250, 215, 60), 'person': (120, 160, 120),
}
DIRS = {'east': 0, 'northeast': 45, 'north': 90, 'northwest': 135, 'west': 180, 'southwest': 225, 'south': 270, 'southeast': 315}
FONT = 'C:/Windows/Fonts/msyh.ttc'


def ang(v):
    return math.radians(DIRS[v] if isinstance(v, str) else v)


class Cam:
    """透视或正交相机。yaw：水平朝向（东=0、北=90），pitch：俯仰（向下为负）。"""
    def __init__(self, pos, yaw, pitch_deg, W, H, hfov_deg=None, ortho_scale=None, roll_deg=0.0):
        self.p, self.W, self.H = pos, W, H
        a, pt = ang(yaw), math.radians(pitch_deg)
        self.f = (math.cos(a) * math.cos(pt), math.sin(a) * math.cos(pt), math.sin(pt))
        self.r = (math.sin(a), -math.cos(a), 0.0)
        fx, fy, fz = self.f; rx, ry, rz = self.r
        self.u = (ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx)
        if roll_deg:   # 绕镜头光轴转（荷兰角）：正数＝画面顺时针歪
            rr = math.radians(roll_deg); c, s_ = math.cos(rr), math.sin(rr)
            r0, u0 = self.r, self.u
            self.r = tuple(c * r0[i] - s_ * u0[i] for i in range(3))
            self.u = tuple(s_ * r0[i] + c * u0[i] for i in range(3))
        self.ortho = ortho_scale
        self.foc = (W / 2) / math.tan(math.radians(hfov_deg) / 2) if hfov_deg else None

    def to_cam(self, v):
        d = (v[0] - self.p[0], v[1] - self.p[1], v[2] - self.p[2])
        dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        return (dot(d, self.r), dot(d, self.u), dot(d, self.f))

    def proj(self, c):
        if self.ortho: return (self.W / 2 + self.ortho * c[0], self.H / 2 - self.ortho * c[1])
        return (self.W / 2 + self.foc * c[0] / c[2], self.H / 2 - self.foc * c[1] / c[2])

    def pt(self, v):
        c = self.to_cam(v)
        return self.proj(c) if (self.ortho or c[2] > 0.05) else None


def clip_near(poly, near=0.05):
    out = []
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ain, bin_ = a[2] >= near, b[2] >= near
        if ain: out.append(a)
        if ain != bin_:
            t = (near - a[2]) / (b[2] - a[2]); out.append(tuple(a[k] + t * (b[k] - a[k]) for k in range(3)))
    return out


def box(x0, y0, z0, x1, y1, z1, colors):
    c = lambda k: colors.get(k, colors.get('side'))
    return [
        ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], c('top')),
        ([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], c('n')),
        ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], c('s')),
        ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], c('e')),
        ([(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], c('w')),
    ]


def build(S, skip_walls=(), ceiling=True, people=False):
    """同一份几何。skip_walls：正交立面图把对着相机的那面墙去掉（剖面看进去）。"""
    R = S['room']; X0, Y0, X1, Y1, HH = R['x0'], R['y0'], R['x1'], R['y1'], R['h']
    shell, faces = [], []
    shell.append(([(X0, Y0, 0), (X1, Y0, 0), (X1, Y1, 0), (X0, Y1, 0)], COL['floor']))
    if ceiling: shell.append(([(X0, Y0, HH), (X1, Y0, HH), (X1, Y1, HH), (X0, Y1, HH)], COL['ceiling']))
    walls = {'north': ([(X0, Y1, 0), (X1, Y1, 0), (X1, Y1, HH), (X0, Y1, HH)], COL['wall']), 'south': ([(X0, Y0, 0), (X1, Y0, 0), (X1, Y0, HH), (X0, Y0, HH)], COL['wall']),
             'east': ([(X1, Y0, 0), (X1, Y1, 0), (X1, Y1, HH), (X1, Y0, HH)], COL['wall_dark']), 'west': ([(X0, Y0, 0), (X0, Y1, 0), (X0, Y1, HH), (X0, Y0, HH)], COL['wall_dark'])}
    for k, v in walls.items():
        if k not in skip_walls: shell.append(v)
    e = 0.01
    for o in S.get('openings', []):
        if o['side'] in skip_walls: continue
        col = COL['window'] if o['kind'] == 'window' else COL['glass'] if o['kind'] == 'glass_door' else COL['door']
        lo, hi, a, b = o.get('sill', 0), o.get('head', 2.1), o['from'], o['to']
        q = {'north': [(a, Y1 - e, lo), (b, Y1 - e, lo), (b, Y1 - e, hi), (a, Y1 - e, hi)], 'south': [(a, Y0 + e, lo), (b, Y0 + e, lo), (b, Y0 + e, hi), (a, Y0 + e, hi)],
             'east': [(X1 - e, a, lo), (X1 - e, b, lo), (X1 - e, b, hi), (X1 - e, a, hi)], 'west': [(X0 + e, a, lo), (X0 + e, b, lo), (X0 + e, b, hi), (X0 + e, a, hi)]}[o['side']]
        shell.append((q, col))
    of = S.get('office')
    if of: faces += box(of['x0'], of['y0'], 0, of['x1'], of['y1'], of['h'], {'side': COL['office'], 'top': COL['office']})
    ws = S['workstations']; ds = ws['desk']; face = ws.get('facing', 'north')
    hl = {(h['row'], h['col']) for h in ws.get('highlight', [])}
    for r in ws['rows']:
        yn = r['y_north']; ys = yn - ds['d']
        for c in ws['cols']:
            xw = c['x_west']; xe = xw + ds['w']; t = 0.04; ph = ds['partition_h']; t0 = 0.05
            top = COL['highlight'] if (r['row'], c['col']) in hl else COL['desk_top']
            faces += box(xw + t0, ys + (0 if face == 'north' else t0), 0, xe - t0, yn - (t0 if face == 'north' else 0), ds['h'], {'top': top, 'side': COL['desk_side']})
            if face == 'north':
                faces += box(xw + t, yn - t, 0, xe - t, yn, ph - 0.005, {'side': COL['partition'], 'top': COL['partition_top']})
                mon_y, chair_y, back = yn - 0.18, ys - 0.4, 's'
            else:
                faces += box(xw + t, ys, 0, xe - t, ys + t, ph - 0.005, {'side': COL['partition'], 'top': COL['partition_top']})
                mon_y, chair_y, back = ys + 0.18, yn + 0.4, 'n'
            if not any(abs(o['x_west'] + ds['w'] - xw) < 1e-6 for o in ws['cols']):
                faces += box(xw, ys, 0, xw + t, yn, ph, {'side': COL['partition'], 'top': COL['partition_top']})
            faces += box(xe - t, ys, 0, xe, yn, ph, {'side': COL['partition'], 'top': COL['partition_top']})
            mx = (xw + xe) / 2
            mon = {'side': COL['monitor_back'], 'top': COL['monitor_back'], ('s' if face == 'north' else 'n'): COL['screen']}
            faces += box(mx - 0.3, mon_y - 0.03, ds['h'] + 0.08, mx + 0.3, mon_y + 0.03, ds['h'] + 0.45, mon)
            faces += box(mx - 0.27, chair_y - 0.25, 0.42, mx + 0.27, chair_y + 0.25, 0.5, {'side': COL['seat'], 'top': COL['seat']})
            by0, by1 = (chair_y - 0.25, chair_y - 0.17) if back == 's' else (chair_y + 0.17, chair_y + 0.25)
            faces += box(mx - 0.27, by0, 0.5, mx + 0.27, by1, 1.05, {'side': COL['backrest'], 'top': COL['backrest']})
    if people:   # 175 cm 比例人（站在主过道里，只在三视图里放）
        x, y = people
        faces += box(x - 0.22, y - 0.13, 0, x + 0.22, y + 0.13, 1.45, {'side': COL['person'], 'top': COL['person']})
        faces += box(x - 0.11, y - 0.11, 1.53, x + 0.11, y + 0.11, 1.75, {'side': COL['person'], 'top': COL['person']})
    return shell, faces


LAST = {}


def raster(cam, shell, faces, line_only=False, transparent=()):
    W, H = cam.W, cam.H
    rgb = np.full((H, W, 3), 255, np.uint8); zb = np.full((H, W), np.inf); idb = np.full((H, W), -1, np.int32)
    ys, xs = np.mgrid[0:H, 0:W]; xs = xs + 0.5; ys = ys + 0.5
    pid = [0]
    glass = [False]
    gid = np.full((H, W), -1, np.int32)

    def draw(poly, col, bias=0.0):
        pid[0] += 1
        cs = [cam.to_cam(v) for v in poly]
        cp = cs if cam.ortho else clip_near(cs)
        if len(cp) < 3: return
        pts = [cam.proj(c) for c in cp]
        dep = [c[2] for c in cp]
        for i in range(1, len(cp) - 1):
            (x0, y0), (x1, y1), (x2, y2) = pts[0], pts[i], pts[i + 1]
            den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
            if abs(den) < 1e-9: continue
            bx0, bx1 = max(int(min(x0, x1, x2)), 0), min(int(max(x0, x1, x2)) + 1, W)
            by0, by1 = max(int(min(y0, y1, y2)), 0), min(int(max(y0, y1, y2)) + 1, H)
            if bx0 >= bx1 or by0 >= by1: continue
            X = xs[by0:by1, bx0:bx1]; Y = ys[by0:by1, bx0:bx1]
            a = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / den
            b = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / den
            c = 1 - a - b
            m = (a >= -1e-6) & (b >= -1e-6) & (c >= -1e-6)
            if not m.any(): continue
            if cam.ortho: z = a * dep[0] + b * dep[i] + c * dep[i + 1] - bias
            else: z = 1.0 / (a / dep[0] + b / dep[i] + c / dep[i + 1]) - bias
            sub = zb[by0:by1, bx0:bx1]; upd = m & (z < sub)
            if glass[0]:
                blk = rgb[by0:by1, bx0:bx1]
                blk[upd] = (0.55 * blk[upd] + 0.45 * np.array(col)).astype(np.uint8)
                gid[by0:by1, bx0:bx1][upd] = pid[0]
                continue
            sub[upd] = z[upd]
            rgb[by0:by1, bx0:bx1][upd] = (255, 255, 255) if line_only else col
            idb[by0:by1, bx0:bx1][upd] = pid[0]

    for poly, col in shell: draw(poly, col, bias=-0.02)
    for poly, col in faces: draw(poly, col)
    glass[0] = True
    for poly, col in transparent: draw(poly, col)
    edge = np.zeros((H, W), bool)
    edge[:, 1:] |= (gid[:, 1:] != gid[:, :-1]) & ((gid[:, 1:] >= 0) | (gid[:, :-1] >= 0))
    edge[1:, :] |= (gid[1:, :] != gid[:-1, :]) & ((gid[1:, :] >= 0) | (gid[:-1, :] >= 0))
    edge[:, 1:] |= idb[:, 1:] != idb[:, :-1]; edge[1:, :] |= idb[1:, :] != idb[:-1, :]
    rgb[edge] = (40, 40, 40)
    LAST.update(zb=zb, edge=edge)   # 控制图用（ControlNet 深度 / 线稿），不改原输出
    return Image.fromarray(rgb)


def font(n):
    try: return ImageFont.truetype(FONT, n)
    except Exception: return ImageFont.load_default()


def label(d, xy, text, size=16, fill=(0, 0, 0), anchor='mm'):
    if xy is None: return
    f = font(size)
    d.text(xy, text, fill=fill, font=f, anchor=anchor, stroke_width=3, stroke_fill=(255, 255, 255))


def arrow(d, p0, p1, fill, width=3):
    if p0 is None or p1 is None: return
    d.line([p0, p1], fill=fill, width=width)
    a = math.atan2(p1[1] - p0[1], p1[0] - p0[0]); L = 12
    d.polygon([p1, (p1[0] - L * math.cos(a - 0.45), p1[1] - L * math.sin(a - 0.45)), (p1[0] - L * math.cos(a + 0.45), p1[1] - L * math.sin(a + 0.45))], fill=fill)


def ortho_cam(S, view, W, H, margin=60):
    R = S['room']; X0, Y0, X1, Y1, HH = R['x0'], R['y0'], R['x1'], R['y1'], R['h']
    cx, cy = (X0 + X1) / 2, (Y0 + Y1) / 2
    if view == 'plan':
        s = min((W - 2 * margin) / (X1 - X0), (H - 2 * margin) / (Y1 - Y0))
        return Cam((cx, cy, 50), 'north', -90, W, H, ortho_scale=s)
    if view == 'front':   # 从南往北看
        s = min((W - 2 * margin) / (X1 - X0), (H - 2 * margin) / HH)
        return Cam((cx, Y0 - 50, HH / 2), 'north', 0, W, H, ortho_scale=s)
    if view == 'left':    # 从西往东看
        s = min((W - 2 * margin) / (Y1 - Y0), (H - 2 * margin) / HH)
        return Cam((X0 - 50, cy, HH / 2), 'east', 0, W, H, ortho_scale=s)
    if view == 'right':   # 从东往西看
        s = min((W - 2 * margin) / (Y1 - Y0), (H - 2 * margin) / HH)
        return Cam((X1 + 50, cy, HH / 2), 'west', 0, W, H, ortho_scale=s)


def annotate_plan(S, cam, img):
    d = ImageDraw.Draw(img); ws = S['workstations']; ds = ws['desk']
    for r in ws['rows']:
        for c in ws['cols']:
            x = c['x_west'] + ds['w'] / 2; y = r['y_north'] - ds['d'] / 2
            label(d, cam.pt((x, y, 1.2)), '%d-%d' % (r['row'], c['col']), 15)
        label(d, cam.pt((0.8, r['y_north'] - 0.35, 1.2)), '第%d排' % r['row'], 13, (90, 90, 90))
    for h in ws.get('highlight', []):
        rr = [r for r in ws['rows'] if r['row'] == h['row']][0]; cc = [c for c in ws['cols'] if c['col'] == h['col']][0]
        label(d, cam.pt((cc['x_west'] + ds['w'] / 2, rr['y_north'] - ds['d'] - 0.15, 1.2)), h['label'], 14, (160, 110, 0))
    R = S['room']
    # 墙线和门窗（立面在顶视里没有面积，按墙段画粗线）
    corners = [(R['x0'], R['y0']), (R['x1'], R['y0']), (R['x1'], R['y1']), (R['x0'], R['y1'])]
    pts = [cam.pt((x, y, 2.8)) for x, y in corners]; d.line(pts + [pts[0]], fill=(60, 60, 60), width=6)
    for o in S.get('openings', []):
        col = COL['window'] if o['kind'] == 'window' else COL['glass'] if o['kind'] == 'glass_door' else COL['door']
        a0, a1 = o['from'], o['to']
        seg = {'north': ((a0, R['y1']), (a1, R['y1'])), 'south': ((a0, R['y0']), (a1, R['y0'])), 'east': ((R['x1'], a0), (R['x1'], a1)), 'west': ((R['x0'], a0), (R['x0'], a1))}[o['side']]
        d.line([cam.pt((seg[0][0], seg[0][1], 2.8)), cam.pt((seg[1][0], seg[1][1], 2.8))], fill=tuple(max(0, c - 40) for c in col), width=12)
    label(d, cam.pt((R['x1'] - 1.0, R['y1'] - 0.3, 1.2)), '所有工位：人坐桌子南侧、面朝北', 14, (90, 90, 90))
    for o in S.get('openings', []):
        m = (o['from'] + o['to']) / 2
        pos = {'north': (m, R['y1'] + 0.3), 'south': (m, R['y0'] - 0.3), 'east': (R['x1'] + 0.3, m), 'west': (R['x0'] - 0.3, m)}[o['side']]
        label(d, cam.pt((pos[0], pos[1], 0)), o['id'] + ' ' + o['name'].split('（')[0], 14, (30, 80, 140))
    of = S.get('office')
    if of: label(d, cam.pt(((of['x0'] + of['x1']) / 2, (of['y0'] + of['y1']) / 2, 3)), '主管办公室', 16)
    for z in S.get('zones', []):
        label(d, cam.pt(((z['x0'] + z['x1']) / 2, (z['y0'] + z['y1']) / 2, 0)), z['name'], 13, (110, 110, 110))
    for sp in S.get('standing_points', []):
        x, y = sp['pos']; a = ang(sp['facing'])
        p0 = cam.pt((x, y, 1.3)); p1 = cam.pt((x + 0.55 * math.cos(a), y + 0.55 * math.sin(a), 1.3))
        if p0: d.ellipse([p0[0] - 7, p0[1] - 7, p0[0] + 7, p0[1] + 7], fill=(0, 150, 60))
        arrow(d, p0, p1, (0, 150, 60))
        label(d, cam.pt((x, y - 0.32, 1.3)), sp['id'], 14, (0, 120, 50))
    for cm in S.get('cameras', []):
        x, y = cm['pos'][0], cm['pos'][1]; a = ang(cm['yaw'])
        hf = math.radians(hfov_of(cm)) / 2; L = 2.2
        p0 = cam.pt((x, y, 2.5))
        for s in (-1, 1):
            q = cam.pt((x + L * math.cos(a + s * hf), y + L * math.sin(a + s * hf), 2.5)); d.line([p0, q], fill=(200, 30, 30), width=2)
        arrow(d, p0, cam.pt((x + 1.0 * math.cos(a), y + 1.0 * math.sin(a), 2.5)), (200, 30, 30), 4)
        label(d, cam.pt((x - 0.45 * math.cos(a), y - 0.45 * math.sin(a), 2.5)), cm['id'] + '（' + cm['cell'] + '）', 14, (200, 30, 30))
    # 北向、比例尺
    W = cam.W
    arrow(d, (W - 40, 90), (W - 40, 40), (0, 0, 0), 3); label(d, (W - 40, 105), '北', 16)
    p0 = cam.pt((R['x0'], R['y0'] - 0.8, 0)); p1 = cam.pt((R['x0'] + 2, R['y0'] - 0.8, 0))
    d.line([p0, p1], fill=(0, 0, 0), width=3); label(d, ((p0[0] + p1[0]) / 2, p0[1] + 14), '2 米', 13)


def annotate_elev(S, cam, img, view, person_at):
    d = ImageDraw.Draw(img)
    names = {'front': '正视图（从南往北看，去掉南墙）', 'left': '左视图（从西往东看，去掉西墙）', 'right': '右视图（从东往西看，去掉东墙）'}
    label(d, (20, 20), names[view], 18, anchor='lt')
    R = S['room']
    for o in S.get('openings', []):
        if (view == 'front' and o['side'] == 'north') or (view == 'left' and o['side'] == 'east') or (view == 'right' and o['side'] == 'west'):
            m = (o['from'] + o['to']) / 2
            pos = {'north': (m, R['y1'], 2.7), 'east': (R['x1'], m, 2.4), 'west': (R['x0'], m, 2.4)}[o['side']]
            label(d, cam.pt(pos), o['id'] + ' ' + o['name'].split('（')[0], 14, (30, 80, 140))
    for sp in S.get('standing_points', []):
        x, y = sp['pos']; h = 1.25 if sp['posture'] == 'sit' else 1.75
        p0, p1 = cam.pt((x, y, 0)), cam.pt((x, y, h))
        d.line([p0, p1], fill=(0, 150, 60), width=2); label(d, cam.pt((x, y, h + 0.15)), sp['id'], 13, (0, 120, 50))
    label(d, cam.pt((person_at[0], person_at[1], 1.95)), '175cm', 13, (60, 100, 60))
    for r in S['workstations']['rows']:
        pass


def hfov_of(cm):
    return cm.get('hfov_deg') or math.degrees(2 * math.atan(36 / (2 * cm.get('focal_mm', 24))))


def legend(img):
    W, H = img.size; cv = Image.new('RGB', (W + 300, H), 'white'); cv.paste(img, (0, 0)); d = ImageDraw.Draw(cv); f = font(17); y = 20
    for col, t in [(COL['screen'], '显示器屏幕正面'), (COL['monitor_back'], '显示器背面'), (COL['seat'], '椅面'), (COL['backrest'], '椅背（人背后）'), (COL['partition'], '隔板'), (COL['desk_top'], '桌面'), (COL['highlight'], '江澈工位'), (COL['window'], '窗'), (COL['door'], '木门'), (COL['glass'], '玻璃门'), (COL['office'], '主管办公室玻璃隔断'), (COL['person'], '175cm 比例人'), ((0, 150, 60), '站位点 P'), ((200, 30, 30), '机位 Cam')]:
        d.rectangle([W + 16, y + 3, W + 38, y + 21], fill=col, outline=(60, 60, 60)); d.text((W + 46, y), t, fill=(0, 0, 0), font=f); y += 30
    return cv


def export(S, out):
    os.makedirs(out, exist_ok=True)
    person_at = (2.0, 1.1)
    # 正交平面图（D）
    cam = ortho_cam(S, 'plan', 1600, 1400)
    sh, fc = build(S, ceiling=False)
    img = raster(cam, sh, fc); annotate_plan(S, cam, img); legend(img).save(os.path.join(out, '平面图_D.png'))
    # 正交三视图
    for view, skip in (('front', ('south',)), ('left', ('west',)), ('right', ('east',))):
        cam = ortho_cam(S, view, 1600, 560)
        sh, fc = build(S, skip_walls=skip, ceiling=False, people=person_at)
        img = raster(cam, sh, fc); annotate_elev(S, cam, img, view, person_at)
        legend(img).save(os.path.join(out, {'front': '正视图', 'left': '左视图', 'right': '右视图'}[view] + '.png'))
    # 每个 Cam：透视灰模 + 线稿（给 am 当构图底图，图上无字）
    for cm in S.get('cameras', []):
        cam = Cam(cm['pos'], cm['yaw'], cm.get('pitch_deg', -15), 1344, 768, hfov_deg=hfov_of(cm))
        sh, fc = build(S)
        raster(cam, sh, fc).save(os.path.join(out, cm['id'] + '_' + cm['cell'] + '_灰模.png'))
        raster(cam, sh, fc, line_only=True).save(os.path.join(out, cm['id'] + '_' + cm['cell'] + '_线稿.png'))
    print('ok', out)


if __name__ == '__main__':
    export(json.load(open(sys.argv[1], encoding='utf8')), sys.argv[2])

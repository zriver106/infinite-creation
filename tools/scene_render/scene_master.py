# 场景三视图及平面图（手册 13 号）：空间母本 JSON → 方块灰模 → 四台正交相机（平面 / 正 / 左 / 右）导出。
# 四张无标注无边框结构图（给 am 当底图做美术加工）+ 四张标注图（编号、坐标、北向、比例尺、地面线、175cm 比例人，给人核）。
# 三张立面统一比例尺和地面基准线；左右视图各自投影，不翻转；立面隐去靠观察方向那面墙。纯 PIL + numpy。
# 用法：python scene_master.py 母本.json 输出目录
import json, math, sys, os
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scene_struct import Cam, raster, box, font, label, arrow

S_PX = 110          # 每米像素（四张图统一）
MARGIN = 0.6        # 米
C = {
    'blue_seat': (60, 110, 190), 'rubber': (85, 88, 92), 'yellow': (230, 190, 40), 'acrylic': (210, 225, 230),
    'asphalt': (95, 95, 98), 'concrete': (200, 198, 192), 'concrete_dark': (165, 163, 158), 'facade': (215, 205, 190), 'shutter': (160, 165, 170), 'glass': (180, 215, 225), 'trunk': (110, 95, 75), 'foliage': (120, 160, 95), 'pole': (120, 125, 130),
    'wood': (200, 160, 110), 'fabric': (230, 215, 180), 'black': (35, 35, 35), 'glass_counter': (175, 215, 220), 'device': (90, 95, 100), 'gold': (215, 185, 110), 'lamp': (250, 250, 235), 'bottle': (170, 210, 240),
    'floor': (214, 210, 200), 'wall': (236, 233, 226), 'wall_dark': (222, 218, 210), 'ceiling': (244, 243, 240),
    'window': (170, 205, 230), 'door': (170, 125, 80), 'glass': (180, 215, 225), 'office_glass': (160, 200, 210),
    'desk_top': (245, 245, 245), 'desk_side': (200, 200, 200), 'partition': (150, 155, 160), 'partition_top': (130, 135, 140),
    'screen': (40, 110, 230), 'monitor_back': (25, 25, 25), 'seat': (215, 50, 45), 'backrest': (120, 20, 20),
    'pedestal': (232, 232, 228), 'folder': (205, 170, 120), 'dark_wood': (90, 60, 40), 'led': (255, 255, 210),
}
# 材质底色模式（SM_MATERIAL=1，总导 11-28 方案①）：不用红椅面 / 深红椅背 / 蓝屏幕这些标记色，改成接近真实材质的底色，
# 给低重绘幅度的图生图当底图——底色本身像真东西，结构靠底图锁住。椅子按母本 color（fabric / black / blue_seat）上色。
MATERIAL = os.environ.get('SM_MATERIAL') == '1'
REAR = (85, 85, 90)
if MATERIAL:
    C.update({'screen': (30, 34, 42), 'seat': (60, 60, 62), 'backrest': (45, 45, 48)})
    REAR = None


def build(M, skip_wall=None, ceiling=False):
    R = M['room']; X0, Y0, X1, Y1, HH = R['x0'], R['y0'], R['x1'], R['y1'], R['h']
    shell, f = [], []
    if M.get('exterior'):
        return shell, build_items(M, view=skip_wall)
    shell.append(([(X0, Y0, 0), (X1, Y0, 0), (X1, Y1, 0), (X0, Y1, 0)], C['floor']))
    if ceiling: shell.append(([(X0, Y0, HH), (X1, Y0, HH), (X1, Y1, HH), (X0, Y1, HH)], C['ceiling']))
    walls = {'north': [(X0, Y1, 0), (X1, Y1, 0), (X1, Y1, HH), (X0, Y1, HH)], 'south': [(X0, Y0, 0), (X1, Y0, 0), (X1, Y0, HH), (X0, Y0, HH)],
             'east': [(X1, Y0, 0), (X1, Y1, 0), (X1, Y1, HH), (X1, Y0, HH)], 'west': [(X0, Y0, 0), (X0, Y1, 0), (X0, Y1, HH), (X0, Y0, HH)]}
    for k, q in walls.items():
        if k != skip_wall: shell.append((q, C['wall'] if k in ('north', 'south') else C['wall_dark']))
    e = 0.01
    for o in M['openings']:
        if o['side'] == skip_wall: continue
        col = C['window'] if o['kind'] == 'window' else C['glass'] if o['kind'] == 'glass_door' else C['door']
        lo, hi, a, b = o.get('sill', 0), o.get('head', 2.1), o['from'], o['to']
        q = {'north': [(a, Y1 - e, lo), (b, Y1 - e, lo), (b, Y1 - e, hi), (a, Y1 - e, hi)], 'south': [(a, Y0 + e, lo), (b, Y0 + e, lo), (b, Y0 + e, hi), (a, Y0 + e, hi)],
             'east': [(X1 - e, a, lo), (X1 - e, b, lo), (X1 - e, b, hi), (X1 - e, a, hi)], 'west': [(X0 + e, a, lo), (X0 + e, b, lo), (X0 + e, b, hi), (X0 + e, a, hi)]}[o['side']]
        shell.append((q, col))
    # 主管办公室：西侧、北侧玻璃隔断（南、东是外墙），北侧留门洞
    of = M.get('office'); t = 0.06; g = {'side': C['office_glass'], 'top': C['office_glass']}
    if of:
        f += box(of['x0'], of['y0'], 0, of['x0'] + t, of['y1'], of['h'], g)
        dx0, dx1 = of['door']['x0'], of['door']['x1']
        f += box(dx1, of['y1'] - t, 0, of['x1'], of['y1'], of['h'], g)
        f += box(dx0, of['y1'] - t, 2.1, dx1, of['y1'], of['h'], g)                       # 门洞上方横档
        for it in of['furniture']:
            if it['id'] == 'OFF-DESK':
                hw, hd = (it['d'] / 2, it['w'] / 2) if it['yaw'] in (90, 270) else (it['w'] / 2, it['d'] / 2)
                f += box(it['x'] - hw, it['y'] - hd, 0, it['x'] + hw, it['y'] + hd, it['h'], {'side': C['dark_wood'], 'top': C['dark_wood']})
            else:
                x, y = it['x'], it['y']
                f += box(x - 0.3, y - 0.3, 0.42, x + 0.3, y + 0.3, 0.52, {'side': C['seat'], 'top': C['seat']})
                f += box(x + 0.22, y - 0.3, 0.52, x + 0.3, y + 0.3, 1.25, {'side': C['backrest'], 'top': C['backrest'], 'e': REAR or C['backrest']})   # 面朝西，椅背在东，背面朝东深灰
    # 工位
    ws = M.get('workstations') or {'rows': [], 'cols': [], 'desk': {'partition_h': 1.15}}; ds = ws['desk']; t = 0.04; ph = ds['partition_h']; t0 = 0.05
    for r in ws['rows']:
        yc = r['y']; yn, ys = yc + ds['d'] / 2, yc - ds['d'] / 2
        for c in ws['cols']:
            xw, xe = c['x'] - ds['w'] / 2, c['x'] + ds['w'] / 2
            f += box(xw + t0, ys, 0.70, xe - t0, yn - t0, ds['h'], {'top': C['desk_top'], 'side': C['desk_side']})             # 桌面板
            for lx in (xw + t0, xe - t0 - 0.04):
                f += box(lx, ys + 0.05, 0, lx + 0.04, ys + 0.09, 0.70, {'side': C['desk_side']})                               # 前腿（南）
            f += box(xw + t, yn - t, 0, xe - t, yn, ph - 0.005, {'side': C['partition'], 'top': C['partition_top']})             # 前挡板（北）
            if not any(abs(o['x'] + ds['w'] / 2 - xw) < 1e-6 for o in ws['cols']):
                f += box(xw, ys, 0, xw + t, yn, ph, {'side': C['partition'], 'top': C['partition_top']})
            f += box(xe - t, ys, 0, xe, yn, ph, {'side': C['partition'], 'top': C['partition_top']})
            f += box(xe - 0.5, yc - 0.25, 0, xe - 0.08, yc + 0.25, 0.6, {'side': C['pedestal'], 'top': C['pedestal']})            # 活动柜
            mx, my = c['x'], yn - 0.18
            f += box(mx - 0.3, my - 0.03, ds['h'] + 0.08, mx + 0.3, my + 0.03, ds['h'] + 0.45, {'side': C['monitor_back'], 'top': C['monitor_back'], 's': C['screen']})
            f += box(mx - 0.04, my, ds['h'], mx + 0.04, my + 0.06, ds['h'] + 0.08, {'side': C['monitor_back']})
            f += box(mx + 0.38, yc - 0.12, ds['h'], mx + 0.62, yc + 0.1, ds['h'] + 0.1, {'side': C['folder'], 'top': C['folder']})  # 文件夹
            cy = r['chair_y']
            f += box(mx - 0.27, cy - 0.25, 0.42, mx + 0.27, cy + 0.25, 0.5, {'side': C['seat'], 'top': C['seat']})
            f += box(mx - 0.27, cy - 0.25, 0.5, mx + 0.27, cy - 0.17, 1.05, {'side': C['backrest'], 'top': C['backrest'], 's': REAR or C['backrest']})   # 椅背背面（朝南）深灰
            f += box(mx - 0.03, cy - 0.03, 0, mx + 0.03, cy + 0.03, 0.42, {'side': C['monitor_back']})
    f += build_items(M, view=skip_wall)
    for fx in M.get('fixtures', []):
        if fx['id'] == 'LED' and ceiling is not None:
            for gx in fx['grid']['cols_x']:
                for gy in fx['grid']['rows_y']:
                    f += box(gx - fx['w'] / 2, gy - fx['d'] / 2, R['h'] - 0.03, gx + fx['w'] / 2, gy + fx['d'] / 2, R['h'] - 0.01, {'side': C['led'], 'top': C['led']})
    return shell, f


def build_items(M, view=None):
    """通用家具：box / glass_counter / device / chair / dispenser / sign / ring_lamp。"""
    f = []
    for it in M.get('items', []):
        if view and view in it.get('hide_from', []): continue
        # 立面剖切（站位/审图 11-28：L07 左视图西墙花架挡住全屋）：拆掉的那面墙上贴墙放、沿墙通长（>40% 墙长）的高物件（≥1.2 m）跟墙一起剖掉；矮的（窗台、低台）照画
        if view and it.get('box') and not M.get('exterior'):
            R = M['room']; x0, y0, z0, x1, y1, z1 = it['box']; tol = 0.12
            touch = {'west': x0 <= R['x0'] + tol, 'east': x1 >= R['x1'] - tol, 'south': y0 <= R['y0'] + tol, 'north': y1 >= R['y1'] - tol}.get(view)
            along = (y1 - y0) / (R['y1'] - R['y0']) if view in ('west', 'east') else (x1 - x0) / (R['x1'] - R['x0'])
            if touch and z1 >= 1.2 and along > 0.4: continue   # 只剖沿墙通长的大件（花架、通长台）；角落柜子这类小件照画
        t = it.get('type', 'box')
        if t in ('box', 'glass_counter', 'device', 'sign'):
            x0, y0, z0, x1, y1, z1 = it['box']
            col = C.get(it.get('color', ''), None) or {'glass_counter': C['glass_counter'], 'device': C['device'], 'sign': C['gold']}.get(t, C['wood'])
            cols = {'side': col, 'top': col}
            if t == 'glass_counter':
                cols['top'] = C['wood']
            if t == 'device':
                cols[{'west': 'w', 'east': 'e', 'north': 'n', 'south': 's'}[it.get('screen_side', 'west')]] = C['screen']
            f += box(x0, y0, z0, x1, y1, z1, cols)
        elif t == 'chair':
            cx, cy = it['center']; sx, sy = (it['size'], it['size']) if not isinstance(it['size'], list) else it['size']; hx, hy = sx / 2, sy / 2; sz, tz = it['seat_z'], it['top_z']; z0 = it.get('base_z', 0)
            seat = C['seat']; back = C['backrest']
            if MATERIAL and it.get('color') in C: seat = C[it['color']]; back = tuple(max(0, v - 25) for v in C[it['color']])
            f += box(cx - hx, cy - hy, sz - 0.06, cx + hx, cy + hy, sz, {'side': seat, 'top': seat})
            yaw = it['yaw'] % 360; bt = 0.07
            # 椅背在人背后：面朝 yaw，椅背在反方向那一边
            if yaw == 0: bb = (cx - hx, cy - hy, cx + hx, cy - hy + bt)
            elif yaw == 180: bb = (cx - hx, cy + hy - bt, cx + hx, cy + hy)
            elif yaw == 90: bb = (cx - hx, cy - hy, cx - hx + bt, cy + hy)
            else: bb = (cx + hx - bt, cy - hy, cx + hx, cy + hy)
            rear = {0: 's', 180: 'n', 90: 'w'}.get(yaw, 'e')            # 椅背朝外那一面（人背后）涂深灰，后视图里一眼看出是椅背背面
            f += box(bb[0], bb[1], sz, bb[2], bb[3], tz, {'side': back, 'top': back, rear: REAR or back})
            f += box(cx - 0.03, cy - 0.03, z0, cx + 0.03, cy + 0.03, sz - 0.06, {'side': C['monitor_back']})
        elif t == 'dispenser':
            x0, y0, z0, x1, y1, z1 = it['box']
            cols = {'side': C['black'], 'top': C['black']}
            cols[{270: 'w', 90: 'e', 0: 'n', 180: 's'}[it.get('front_yaw', 270) % 360]] = (150, 150, 155)
            f += box(x0, y0, z0, x1, y1, z1, cols)
            m = 0.04; f += box(x0 + m, y0 + m, z1, x1 - m, y1 - m, it.get('bottle_top', z1 + 0.45), {'side': C['bottle'], 'top': C['bottle']})
        elif t == 'tree':
            cx, cy = it['center']; r = it.get('trunk', 0.35) / 2; cr = it.get('crown', 5.0) / 2
            f += box(cx - r, cy - r, -0.15, cx + r, cy + r, it.get('fork', 2.2) + 1.0, {'side': C['trunk'], 'top': C['trunk']})
            z0, z1 = it.get('crown_z0', 3.6), it.get('height', 9.0); zh = (z1 - z0) / 4; fo = {'side': C['foliage'], 'top': C['foliage']}
            f += box(cx - cr * 0.7, cy - cr * 0.7, z0, cx + cr * 0.7, cy + cr * 0.7, z0 + zh, fo)          # 树冠做成上下收窄的阶梯形，像自然树冠，不像修剪方块
            f += box(cx - cr, cy - cr * 0.8, z0 + zh, cx + cr, cy + cr * 0.8, z1 - zh, fo)
            f += box(cx - cr * 0.8, cy - cr, z0 + zh, cx + cr * 0.8, cy + cr, z1 - zh, fo)
            f += box(cx - cr * 0.6, cy - cr * 0.6, z1 - zh, cx + cr * 0.6, cy + cr * 0.6, z1, fo)
        elif t == 'ring_lamp':
            r = it['d'] / 2; w = 0.05; z = it['z']
            for cx, cy in it['centers']:
                for bx in ((cx - r, cy - r, cx + r, cy - r + w), (cx - r, cy + r - w, cx + r, cy + r), (cx - r, cy - r, cx - r + w, cy + r), (cx + r - w, cy - r, cx + r, cy + r)):
                    f += box(bx[0], bx[1], z - 0.03, bx[2], bx[3], z, {'side': C['lamp'], 'top': C['lamp']})
    return f


def plan_walls(M, t=0.2):
    """平面图用：墙画成有厚度的实心条（墙外侧 t 米），门窗处留洞并填门 / 玻璃色（总导 11-28：平面图要有墙线、门洞、窗）。"""
    if M.get('exterior'): return []
    R = M['room']; X0, Y0, X1, Y1, HH = R['x0'], R['y0'], R['x1'], R['y1'], R['h']
    wall = {'side': (70, 70, 70), 'top': (70, 70, 70)}
    f = []
    sides = {'south': (X0 - t, X1 + t), 'north': (X0 - t, X1 + t), 'west': (Y0, Y1), 'east': (Y0, Y1)}
    for side, (a0, a1) in sides.items():
        ops = sorted([(max(o['from'], a0), min(o['to'], a1), o) for o in M.get('openings', []) if o['side'] == side], key=lambda x: x[0])
        cur = a0; segs = []
        for o0, o1, o in ops:
            if o0 > cur: segs.append((cur, o0, None))
            segs.append((o0, o1, o)); cur = max(cur, o1)
        if cur < a1: segs.append((cur, a1, None))
        for s0, s1, o in segs:
            if o is None: col = wall; z1 = HH
            else:
                col = {'window': C['window'], 'glass_door': C['glass'], 'door': C['door']}.get(o['kind'], C['door']); col = {'side': col, 'top': col}; z1 = HH
            inset = 0.06 if o is not None else 0.0     # 门窗画成墙中间一条（比墙薄），一眼分得出
            if side == 'south': f += box(s0, Y0 - t + inset, 0, s1, Y0 - inset, z1, col)
            elif side == 'north': f += box(s0, Y1 + inset, 0, s1, Y1 + t - inset, z1, col)
            elif side == 'west': f += box(X0 - t + inset, s0, 0, X0 - inset, s1, z1, col)
            else: f += box(X1 + inset, s0, 0, X1 + t - inset, s1, z1, col)
    return f


def cam_for(M, view):
    R = dict(M['room']); R.update(M.get('frame') or {}); X0, Y0, X1, Y1, HH = R['x0'], R['y0'], R['x1'], R['y1'], R['h']
    m = MARGIN
    if view == '平面图':
        W, H = int((X1 - X0 + 2 * m) * S_PX), int((Y1 - Y0 + 2 * m) * S_PX)
        return Cam(((X0 + X1) / 2, (Y0 + Y1) / 2, 50), 'north', -90, W, H, ortho_scale=S_PX)
    H = int((HH + 2 * m) * S_PX)
    if view == '正视图': return Cam(((X0 + X1) / 2, Y0 - 50, HH / 2), 'north', 0, int((X1 - X0 + 2 * m) * S_PX), H, ortho_scale=S_PX)
    if view == '左视图': return Cam((X0 - 50, (Y0 + Y1) / 2, HH / 2), 'east', 0, int((Y1 - Y0 + 2 * m) * S_PX), H, ortho_scale=S_PX)
    if view == '右视图': return Cam((X1 + 50, (Y0 + Y1) / 2, HH / 2), 'west', 0, int((Y1 - Y0 + 2 * m) * S_PX), H, ortho_scale=S_PX)


SKIP = {'平面图': None, '正视图': 'south', '左视图': 'west', '右视图': 'east'}
DIR = {'平面图': '垂直俯视（上北下南、左西右东）', '正视图': '从南向北看（画面左西右东）', '左视图': '从西向东看（画面左北右南）', '右视图': '从东向西看（画面左南右北）'}


def annotate(M, view, cam, img):
    d = ImageDraw.Draw(img); R = M['room']; ws = M.get('workstations') or {'rows': [], 'cols': [], 'desk': {}}; ds = ws['desk']
    label(d, (14, 14), view + '：' + DIR[view] + '　比例 1 米＝' + str(S_PX) + ' 像素', 18, anchor='lt')
    if view == '平面图':
        for r in ws['rows']:
            for c in ws['cols']:
                label(d, cam.pt((c['x'], r['y'], 3)), 'WS-%s-%s' % (r['id'], c['id']), 12)
            label(d, cam.pt((0.55, r['y'], 3)), r['id'], 14, (90, 90, 90))
        for c in ws['cols']:
            label(d, cam.pt((c['x'], R['y1'] - 0.35, 3)), c['id'] + '  x=' + str(c['x']), 12, (90, 90, 90))
        if M.get('office'): label(d, cam.pt((10.0, 1.9, 3)), 'F-OFF 主管办公室', 15)
        for it in M.get('items', []):
            if 'box' in it: x = (it['box'][0] + it['box'][3]) / 2; y = (it['box'][1] + it['box'][4]) / 2
            elif 'center' in it: x, y = it['center']
            else: continue
            label(d, cam.pt((x, y, 3)), it['id'], 12, (120, 40, 40))
        for o in M['openings']:
            mid = (o['from'] + o['to']) / 2
            pos = {'north': (mid, R['y1'] + 0.3), 'south': (mid, R['y0'] - 0.3), 'east': (R['x1'] + 0.3, mid), 'west': (R['x0'] - 0.3, mid)}[o['side']]
            label(d, cam.pt((pos[0], pos[1], 0)), o['id'] + ' ' + o['name'], 13, (30, 80, 140))
        for z in M['zones']:
            label(d, cam.pt(((z['x0'] + z['x1']) / 2, (z['y0'] + z['y1']) / 2 if z['id'] != 'Z2' else 2.3, 3)), z['id'] + ' ' + z['name'], 11, (110, 110, 110))
        if M.get('workstations'): label(d, cam.pt((9.0, 9.6, 3)), '所有工位：人坐南、面朝北；屏幕朝南', 13, (90, 90, 90))
        W = cam.W; arrow(d, (W - 30, 70), (W - 30, 25), (0, 0, 0), 3); label(d, (W - 30, 82), '北', 15)
        p0, p1 = cam.pt((0, -0.35, 0)), cam.pt((2, -0.35, 0)); d.line([p0, p1], fill=(0, 0, 0), width=3); label(d, ((p0[0] + p1[0]) / 2, p0[1] + 12), '2 米', 12)
        for o in M['openings']:   # 门窗在顶视没有面积，按墙段画粗线
            a, b = o['from'], o['to']
            seg = {'north': ((a, R['y1']), (b, R['y1'])), 'south': ((a, R['y0']), (b, R['y0'])), 'east': ((R['x1'], a), (R['x1'], b)), 'west': ((R['x0'], a), (R['x0'], b))}[o['side']]
            col = C['window'] if o['kind'] == 'window' else C['glass'] if o['kind'] == 'glass_door' else C['door']
            pass
    else:
        g0, g1 = cam.pt((R['x0'] - 0.5, R['y0'] - 0.5, 0)), cam.pt((R['x1'] + 0.5, R['y1'] + 0.5, 0))
        gy = cam.pt(((R['x0'] + R['x1']) / 2, (R['y0'] + R['y1']) / 2, 0))[1]
        d.line([(0, gy), (cam.W, gy)], fill=(0, 0, 0), width=2); label(d, (cam.W - 60, gy + 12), '地面 z=0', 12)
        for o in M['openings']:
            if o['side'] == SKIP[view]: continue
            mid = (o['from'] + o['to']) / 2
            pos = {'north': (mid, R['y1'], o.get('head', 2.1) + 0.12), 'south': (mid, R['y0'], o.get('head', 2.1) + 0.12), 'east': (R['x1'], mid, o.get('head', 2.1) + 0.12), 'west': (R['x0'], mid, o.get('head', 2.1) + 0.12)}[o['side']]
            label(d, cam.pt(pos), o['id'] + ' ' + o['name'], 12, (30, 80, 140))
        # 175cm 比例人（只画在标注图上，基础资产不放人）
        px, py = M.get('scale_person', (0.9, 0.8))
        b0, b1 = cam.pt((px, py, 0)), cam.pt((px, py, 1.75))
        d.rectangle([b1[0] - 9, b1[1], b1[0] + 9, b0[1]], outline=(60, 120, 60), width=2); label(d, (b1[0], b1[1] - 10), '175cm', 11, (60, 120, 60))
        # 竖向刻度
        for z in (0, 1, 2, R['h']):
            p = cam.pt((R['x0'] - 0.3 if view != '右视图' else R['x1'] + 0.3, R['y0'] - 0.3 if view == '左视图' else R['y1'] + 0.3 if view == '右视图' else R['y0'], z))
            label(d, (14, p[1]), ('%.1f' % z) + 'm', 11, (90, 90, 90), anchor='lm')


def export(M, out):
    global S_PX
    S_PX = M.get('scale_px', 110)
    os.makedirs(out, exist_ok=True)
    for view in ('平面图', '正视图', '左视图', '右视图'):
        cam = cam_for(M, view)
        sh, fc = build(M, skip_wall=SKIP[view], ceiling=False if view == '平面图' else False)
        if view == '平面图': fc = [x for x in fc if x[1] not in (C['lamp'], C['led'])]   # 平面只去掉吊灯、天花灯；树冠、雨棚照画（站位 11-28：平面图要画出树冠）
        if view == '平面图': fc = fc + plan_walls(M)
        GL = {C['glass'], C['office_glass'], C['acrylic'], C['glass_counter']}
        img = raster(cam, sh, fc) if view == '平面图' else raster(cam, sh, [x for x in fc if x[1] not in GL], transparent=[x for x in fc if x[1] in GL])   # 立面里玻璃透明（看得见后面的门），平面里玻璃隔断照实画
        img.save(os.path.join(out, view + '.png'))                                # 无标注无边框，给 am 当底图
        ann = img.copy(); annotate(M, view, cam, ann); ann.save(os.path.join(out, view + '_标注.png'))
    print('ok', out)


if __name__ == '__main__':
    export(json.load(open(sys.argv[1], encoding='utf8')), sys.argv[2])

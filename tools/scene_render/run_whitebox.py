# Blender 白模批量渲染：一个场景母本 + 一张机位表 → 每个机位一组 白模 / 深度 / 线稿，另出平面图和正、左、右正交视图。
# 用法：python run_whitebox.py 母本.json 机位表.json 输出目录 [--blender 路径] [--no-ortho]
# 机位表：[{ id, name, pos:[x,y], eye, yaw（罗盘角）, pitch, roll, lens_mm }]
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DEFAULT = os.environ.get('IC_BLENDER', r'C:\tmp_infinite_creation\blender-5.2.5-windows-x64\blender.exe')


def geom(master, out, skip=None, ceiling=True):
    args = [sys.executable, '-X', 'utf8', os.path.join(HERE, 'export_geometry.py'), master, out]
    if skip: args += ['--skip-wall', skip]
    if not ceiling: args += ['--no-ceiling']
    subprocess.run(args, check=True, capture_output=True)
    return out


def render(blender, geo, cam, outdir):
    os.makedirs(outdir, exist_ok=True)
    cj = os.path.join(outdir, '机位.json'); json.dump(cam, open(cj, 'w', encoding='utf8'), ensure_ascii=False)
    r = subprocess.run([blender, '-b', '--factory-startup', '--python', os.path.join(HERE, 'blender_whitebox.py'), '--', geo, cj, outdir], capture_output=True, text=True, encoding='utf8', errors='replace')
    if r.returncode or not os.path.exists(os.path.join(outdir, '线稿.png')):
        raise RuntimeError('Blender 渲染失败：' + cam.get('id', '') + '\n' + (r.stdout + r.stderr)[-1500:])


def main(argv):
    master, cams_path, out = argv[0], argv[1], argv[2]
    blender = argv[argv.index('--blender') + 1] if '--blender' in argv else BLENDER_DEFAULT
    M = json.load(open(master, encoding='utf-8-sig')); R = M['room']
    os.makedirs(out, exist_ok=True)
    g_full = geom(master, os.path.join(out, '_geo_full.json'))
    for c in json.load(open(cams_path, encoding='utf8')):
        cam = {k: c[k] for k in ('pos', 'eye', 'yaw', 'pitch', 'lens_mm') if k in c}; cam['roll'] = c.get('roll', 0); cam['W'] = 1280; cam['H'] = 720
        render(blender, g_full, cam, os.path.join(out, c['id']))
        print('ok', c['id'], flush=True)
    if '--no-ortho' in argv: return
    cx, cy = (R['x0'] + R['x1']) / 2, (R['y0'] + R['y1']) / 2; w, d, h = R['x1'] - R['x0'], R['y1'] - R['y0'], R.get('h', 3.0)
    asp = 16 / 9
    views = [
        ('平面图', None, False, {'pos': [cx, cy], 'eye': h + 20, 'yaw': 0, 'pitch': -90, 'ortho': {'scale': max(w, d * asp) * 1.08, 'view': 'plan'}}),
        ('正视图', 'south', True, {'pos': [cx, R['y0'] - 30], 'eye': h / 2, 'yaw': 0, 'pitch': 0, 'ortho': {'scale': max(w, h * asp) * 1.08, 'view': 'front'}}),
        ('左视图', 'west', True, {'pos': [R['x0'] - 30, cy], 'eye': h / 2, 'yaw': 90, 'pitch': 0, 'ortho': {'scale': max(d, h * asp) * 1.08, 'view': 'left'}}),
        ('右视图', 'east', True, {'pos': [R['x1'] + 30, cy], 'eye': h / 2, 'yaw': 270, 'pitch': 0, 'ortho': {'scale': max(d, h * asp) * 1.08, 'view': 'right'}}),
    ]
    for name, skip, ceil, cam in views:
        g = geom(master, os.path.join(out, '_geo_%s.json' % name), skip=skip, ceiling=ceil and False)
        cam.update(roll=0, W=1280, H=720)
        render(blender, g, cam, os.path.join(out, name))
        print('ok', name, flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])

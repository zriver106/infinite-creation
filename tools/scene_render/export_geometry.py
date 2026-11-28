# 场景母本 → 多边形几何 JSON（Blender 白模和 Python 灰模共用同一份建模逻辑：scene_master.build）。
# 用法：python export_geometry.py 母本.json 输出.json [--skip-wall north|south|east|west] [--no-ceiling]
# 输出：{ "room": {...}, "polys": [{ "v": [[x,y,z],...], "c": [r,g,b], "glass": bool }] }，坐标：米，X 东、Y 北、Z 上。
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_master as SM


def main(argv):
    mp, out = argv[0], argv[1]
    skip = None; ceiling = True
    if '--skip-wall' in argv: skip = argv[argv.index('--skip-wall') + 1]
    if '--no-ceiling' in argv: ceiling = False
    M = json.load(open(mp, encoding='utf-8-sig'))
    GL = {SM.C['glass'], SM.C['office_glass'], SM.C['acrylic'], SM.C['glass_counter']}
    sh, fc = SM.build(M, skip_wall=skip, ceiling=ceiling)
    polys = []
    for poly, col in list(sh) + list(fc):
        polys.append({'v': [[round(float(a), 4) for a in p] for p in poly], 'c': [int(x) for x in col], 'glass': col in GL})
    json.dump({'room': M.get('room'), 'exterior': bool(M.get('exterior')), 'polys': polys}, open(out, 'w', encoding='utf8'))
    print(json.dumps({'ok': True, 'polys': len(polys), 'skip_wall': skip}))


if __name__ == '__main__':
    main(sys.argv[1:])

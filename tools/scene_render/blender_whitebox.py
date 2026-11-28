# Blender 白模渲染（Andy 11-28：「使用 Blender Python 自动创建墙壁、门窗、家具方块……从不同摄像机位置渲染白模」）。
# 只建墙、门窗、家具方块，不追求材质和灯光；空间结构只以白模为准。
# 用法（无界面）：blender -b --factory-startup --python blender_whitebox.py -- 几何.json 机位.json 输出目录
#   几何.json：export_geometry.py 的输出。
#   机位.json：{ "pos":[x,y], "eye":1.5, "yaw":0（罗盘角，0=北、90=东）, "pitch":-5（向下为负）, "roll":0, "lens_mm":28,
#               "ortho": null | { "scale": 米, "view": "plan|front|left|right" }, "W":1280, "H":720 }
# 输出：白模.png（Workbench 白模，带描边和腔体阴影）、深度.png（近白远黑）、线稿.png（黑底白线，Freestyle）。
import bpy, bmesh, json, math, os, sys
from mathutils import Matrix, Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:]
geo = json.load(open(argv[0], encoding='utf8'))
cam_spec = json.load(open(argv[1], encoding='utf8'))
out = argv[2]; os.makedirs(out, exist_ok=True)
W, H = int(cam_spec.get('W', 1280)), int(cam_spec.get('H', 720))

# —— 清场 ——
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# —— 建模：同色多边形合成一个网格，各一个材质（视口色 = 母本颜色；玻璃半透明）——
groups = {}
for p in geo['polys']:
    key = (tuple(p['c']), bool(p.get('glass')))
    groups.setdefault(key, []).append(p['v'])
all_pts = []
for (col, glass), polys in groups.items():
    me = bpy.data.meshes.new('m'); bm = bmesh.new()
    for poly in polys:
        vs = [bm.verts.new(Vector(v)) for v in poly]
        all_pts.extend(poly)
        try: bm.faces.new(vs)
        except ValueError: pass
    bm.to_mesh(me); bm.free()
    mat = bpy.data.materials.new('c%02x%02x%02x%s' % (col[0], col[1], col[2], 'g' if glass else ''))
    mat.diffuse_color = (col[0] / 255, col[1] / 255, col[2] / 255, 0.35 if glass else 1.0)
    me.materials.append(mat)
    ob = bpy.data.objects.new('o', me); scene.collection.objects.link(ob)
    ob['glass'] = glass

# —— 相机 ——
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam_data.sensor_fit = 'HORIZONTAL'; cam_data.sensor_width = 36.0
cam_data.clip_start = 0.05; cam_data.clip_end = 500.0
ortho = cam_spec.get('ortho')
if ortho:
    cam_data.type = 'ORTHO'; cam_data.ortho_scale = float(ortho['scale'])
else:
    cam_data.lens = float(cam_spec.get('lens_mm', 28))
pos = cam_spec['pos']; eye = float(cam_spec.get('eye', 1.5))
yaw = float(cam_spec.get('yaw', 0)); pitch = float(cam_spec.get('pitch', 0)); roll = float(cam_spec.get('roll', 0) or 0)
# Blender 相机默认看 -Z：绕 X 转 90°+pitch 变成看 +Y（北），再绕 Z 转 -yaw（罗盘角顺时针）；roll 绕镜头光轴
rot = Euler((math.radians(90 + pitch), 0.0, math.radians(-yaw)), 'XYZ').to_matrix() @ Matrix.Rotation(math.radians(-roll), 3, 'Z')
cam.matrix_world = Matrix.Translation(Vector((pos[0], pos[1], eye))) @ rot.to_4x4()

scene.render.resolution_x = W; scene.render.resolution_y = H; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGB'
try: scene.view_settings.view_transform = 'Standard'
except Exception: pass

def eng(*names):
    for n in names:
        try:
            scene.render.engine = n; return n
        except Exception: continue
    raise RuntimeError('没有可用的渲染引擎：' + ','.join(names))

# —— ① 白模：Workbench，材质色 + 腔体阴影 + 描边 ——
eng('BLENDER_WORKBENCH')
sh = scene.display.shading
sh.light = 'FLAT'; sh.color_type = 'MATERIAL'   # 平光：白模只看结构，不要灯光把天花板压黑
sh.show_cavity = True; sh.cavity_type = 'WORLD'; sh.show_object_outline = True; sh.object_outline_color = (0.15, 0.15, 0.15)
try: sh.show_backface_culling = False
except Exception: pass
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('w'); scene.world.color = (1, 1, 1)
scene.render.filepath = os.path.join(out, '白模.png'); bpy.ops.render.render(write_still=True)

# —— ② 深度：EEVEE + 覆盖材质（相机 Z 深度 → 近白远黑，按场景包围盒到相机的距离归一）——
cp = Vector((pos[0], pos[1], eye)); fwd = (rot @ Vector((0, 0, -1))).normalized()
ds = [max(0.0, (Vector(p) - cp).dot(fwd)) for p in all_pts[::3]] or [1.0, 10.0]
sd = sorted(ds); near = max(0.05, sd[int(len(sd) * 0.01)] if len(sd) > 100 else sd[0]); far = max(near + 0.5, sd[int(len(sd) * 0.99) - 1] if len(sd) > 10 else sd[-1])
dm = bpy.data.materials.new('depth'); dm.use_nodes = True; nt = dm.node_tree; nt.nodes.clear()
camd = nt.nodes.new('ShaderNodeCameraData'); mr = nt.nodes.new('ShaderNodeMapRange'); em = nt.nodes.new('ShaderNodeEmission'); outn = nt.nodes.new('ShaderNodeOutputMaterial')
mr.inputs['From Min'].default_value = near; mr.inputs['From Max'].default_value = far
mr.inputs['To Min'].default_value = 1.0; mr.inputs['To Max'].default_value = 0.0; mr.clamp = True
nt.links.new(camd.outputs['View Z Depth'], mr.inputs['Value']); nt.links.new(mr.outputs['Result'], em.inputs['Color']); nt.links.new(em.outputs['Emission'], outn.inputs['Surface'])
eng('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT')
scene.world.color = (0, 0, 0)
vl = scene.view_layers[0]; vl.material_override = dm
for o in scene.objects:   # 深度图里玻璃按实面算
    pass
scene.render.filepath = os.path.join(out, '深度.png'); bpy.ops.render.render(write_still=True)

# —— ③ 线稿：EEVEE 全黑覆盖材质 + Freestyle 白线 ——
bm_ = bpy.data.materials.new('black'); bm_.use_nodes = True; n2 = bm_.node_tree; n2.nodes.clear()
e2 = n2.nodes.new('ShaderNodeEmission'); e2.inputs['Color'].default_value = (0, 0, 0, 1); o2 = n2.nodes.new('ShaderNodeOutputMaterial'); n2.links.new(e2.outputs['Emission'], o2.inputs['Surface'])
vl.material_override = bm_
scene.render.use_freestyle = True
fs = vl.freestyle_settings; fs.crease_angle = math.radians(140)
ls = fs.linesets[0] if len(fs.linesets) else fs.linesets.new('lines')
ls.select_by_visibility = True; ls.visibility = 'VISIBLE'
ls.select_silhouette = True; ls.select_border = True; ls.select_crease = True
lstyle = ls.linestyle or bpy.data.linestyles.new('white')
ls.linestyle = lstyle; lstyle.color = (1, 1, 1); lstyle.thickness = 1.5
scene.render.filepath = os.path.join(out, '线稿.png'); bpy.ops.render.render(write_still=True)
print(json.dumps({'ok': True, 'out': out, 'near': round(near, 2), 'far': round(far, 2)}))

# 局部修补羽化贴回：局部重画（遮罩比要修的地方大一圈）之后，只把中间那块贴回原图，边缘羽化，不留接缝线。
# 用法：python feather_patch.py 原图.png 重画图.png 输出.png x0,y0,x1,y1 [羽化像素=24]
#   x0..y1：要换掉的区域（0–1 画面比例），通常就是原来的窗口外框再大一点点；重画时用的遮罩应比它再大一圈。
import sys
from PIL import Image, ImageDraw, ImageFilter

src, fix, out, box = sys.argv[1:5]
feather = int(sys.argv[5]) if len(sys.argv) > 5 else 24
a = Image.open(src).convert('RGB'); b = Image.open(fix).convert('RGB').resize(a.size, Image.LANCZOS)
W, H = a.size; x0, y0, x1, y1 = [float(v) for v in box.split(',')]
m = Image.new('L', (W, H), 0)
ImageDraw.Draw(m).rectangle([x0 * W, y0 * H, x1 * W, y1 * H], fill=255)
m = m.filter(ImageFilter.GaussianBlur(feather))
Image.composite(b, a, m).save(out)
print('ok', out)

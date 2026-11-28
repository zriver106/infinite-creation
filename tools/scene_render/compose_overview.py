# 场景多视角总图（Andy 11-28「做多视角然后合并为一张」）：四角俯视总览 4 张 + 平面图（标东南西北）合成一张，3+2 版式、细白缝、角上小号机位名。
# 送 H3 时只占一个参考位。用法：python compose_overview.py 输出.png 平面图.png O1.png O2.png O3.png O4.png
import sys
from PIL import Image, ImageDraw, ImageFont, ImageChops

out, plan, *views = sys.argv[1:]
G = 8; TW, TH = 960, 540
f = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 18); fb = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 26)
W = 3 * TW + 2 * G; H = 2 * TH + G
cv = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(cv)
pos = [(0, 0), (TW + G, 0), (2 * (TW + G), 0), (0, TH + G)]
for i, (p, (x, y)) in enumerate(zip(views, pos)):
    im = Image.open(p).convert('RGB').resize((TW, TH), Image.LANCZOS); cv.paste(im, (x, y))
    d.rectangle([x + 6, y + 6, x + 44, y + 30], fill=(255, 255, 255)); d.text((x + 10, y + 7), 'O%d' % (i + 1), fill=(60, 60, 60), font=f)
pl = Image.open(plan).convert('RGB')
bg = Image.new('RGB', pl.size, (255, 255, 255)); bb = ImageChops.difference(pl, bg).convert('L').point(lambda v: 255 if v > 12 else 0).getbbox()
if bb: pl = pl.crop((max(0, bb[0] - 10), max(0, bb[1] - 10), bb[2] + 10, bb[3] + 10))
pw, ph = 2 * TW + G, TH
cell = Image.new('RGB', (pw, ph), 'white'); s = min((pw - 140) / pl.width, (ph - 100) / pl.height)
pi = pl.resize((int(pl.width * s), int(pl.height * s)), Image.LANCZOS)
ox, oy = (pw - pi.width) // 2, (ph - pi.height) // 2; cell.paste(pi, (ox, oy)); dc = ImageDraw.Draw(cell)
for t, (tx, ty) in {'北': (pw // 2 - 13, oy - 40), '南': (pw // 2 - 13, oy + pi.height + 6), '西': (ox - 46, ph // 2 - 16), '东': (ox + pi.width + 16, ph // 2 - 16)}.items():
    dc.text((tx, ty), t, fill=(40, 40, 40), font=fb)
dc.rectangle([6, 6, 62, 30], fill=(255, 255, 255)); dc.text((10, 7), '平面', fill=(60, 60, 60), font=f)
cv.paste(cell, (TW + G, TH + G))
cv.save(out); cv.resize((W // 2, H // 2)).save(out.rsplit('.', 1)[0] + '_preview.jpg', quality=88)
print('ok', out, cv.size)

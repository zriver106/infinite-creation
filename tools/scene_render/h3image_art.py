# H3-Image 美术加工（Andy 11-28：「H3-Image 负责美术加工，而不是负责推算三维空间」）：
# 白模当 <Picture 1>（要编辑的图），可选材质参考当 <Picture 2>，只加材质和光影，不改结构。直接交本机 ComfyUI。
# 用法：python h3image_art.py 白模.png 输出.png 提示词.txt [--ref 材质参考.png] [--seed N] [--mp 2.0] [--comfy http://127.0.0.1:8189]
import json, os, sys, time, uuid, urllib.request

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

src, out, ptxt = sys.argv[1:4]
ref = arg('--ref'); seed = int(arg('--seed', 7)); mp = float(arg('--mp', 2.0)); CU = arg('--comfy', 'http://127.0.0.1:8189')
prompt = open(ptxt, encoding='utf8').read().strip()


def upload(path):
    name = 'ic_h3img_' + uuid.uuid4().hex[:8] + os.path.splitext(path)[1].lower()
    b = '----icb' + uuid.uuid4().hex
    body = (('--%s\r\nContent-Disposition: form-data; name="image"; filename="%s"\r\nContent-Type: image/png\r\n\r\n' % (b, name)).encode()
            + open(path, 'rb').read() + ('\r\n--%s\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--%s--\r\n' % (b, b)).encode())
    urllib.request.urlopen(urllib.request.Request(CU + '/upload/image', body, {'Content-Type': 'multipart/form-data; boundary=' + b})).read()
    return name


def scaled(nid_load, base):
    return {
        str(base): {'class_type': 'ResizeImageMaskNode', 'inputs': {'input': [nid_load, 0], 'resize_type': 'scale total pixels', 'resize_type.megapixels': mp, 'scale_method': 'area'}},
        str(base + 1): {'class_type': 'ResizeImageMaskNode', 'inputs': {'input': [str(base), 0], 'resize_type': 'scale to multiple', 'resize_type.multiple': 32, 'scale_method': 'area'}},
    }


wf = {
    '29': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_h3_image_pruned_w4a8.safetensors', 'weight_dtype': 'default'}},
    '30': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'type': 'minimax', 'device': 'default'}},
    '31': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_image_vae_fp16.safetensors'}},
    '45': {'class_type': 'LoadImage', 'inputs': {'image': upload(src)}},
    '50': {'class_type': 'GetImageSize', 'inputs': {'image': ['57', 0]}},
    '32': {'class_type': 'MiniMaxH3ImageConditioning', 'inputs': {'prompt': prompt, 'width': ['50', 0], 'height': ['50', 1], 'clip': ['30', 0], 'vae': ['31', 0], 'images.image_1': ['57', 0]}},
    '33': {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['32', 0]}},
    '38': {'class_type': 'KSampler', 'inputs': {'seed': seed, 'steps': 6, 'cfg': 1, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1, 'model': ['29', 0], 'positive': ['32', 0], 'negative': ['33', 0], 'latent_image': ['32', 1]}},
    '42': {'class_type': 'VAEDecode', 'inputs': {'samples': ['38', 0], 'vae': ['31', 0]}},
    '9': {'class_type': 'SaveImage', 'inputs': {'images': ['42', 0], 'filename_prefix': 'ic_h3img_art'}},
}
wf.update(scaled('45', 56))
if ref:
    wf['70'] = {'class_type': 'LoadImage', 'inputs': {'image': upload(ref)}}
    wf.update(scaled('70', 71))
    wf['32']['inputs']['images.image_2'] = ['72', 0]
r = json.loads(urllib.request.urlopen(urllib.request.Request(CU + '/prompt', json.dumps({'prompt': wf, 'client_id': 'ic-h3img-art'}).encode(), {'Content-Type': 'application/json'})).read())
if r.get('node_errors'): print('node_errors', json.dumps(r['node_errors'], ensure_ascii=False)[:1500]); sys.exit(1)
pid = r['prompt_id']; print('submitted', pid, flush=True)
t0 = time.time()
while time.time() - t0 < 1800:
    time.sleep(4)
    h = json.loads(urllib.request.urlopen(CU + '/history/' + pid).read())
    if pid in h:
        st = h[pid].get('status', {})
        if st.get('status_str') == 'error': print('error', json.dumps(st, ensure_ascii=False)[:1500]); sys.exit(1)
        for o in h[pid].get('outputs', {}).values():
            for img in o.get('images', []):
                q = 'filename=%s&subfolder=%s&type=%s' % (img['filename'], img.get('subfolder', ''), img['type'])
                open(out, 'wb').write(urllib.request.urlopen(CU + '/view?' + q).read()); print('got', out, round(time.time() - t0), 's'); sys.exit(0)
print('timeout; task', pid, 'not resubmitted')

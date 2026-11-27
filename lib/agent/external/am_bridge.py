# -*- coding: utf-8 -*-
"""IC 调 am（Muse）工作区的桥：用 muse-cli 自带的 python 跑（%APPDATA%\\uv\\tools\\muse-cli\\Scripts\\python.exe）。
从站位会话的 工具\\am_v3_sync.py / 记忆里的 fs.write 用法搬来（总导 11-26：资产出图收回 IC）。
用法：python am_bridge.py <put|list|get>，参数是 stdin 里的一个 JSON，结果打一行 JSON 到 stdout。
  put  {"local": 本机文件, "remote": "workspace/…"}   分块（40000 字节）写进 am 工作区，写完 fs.stat 核大小
  list {"dir": "workspace/…"}                        列目录（只列文件：name、size、modifiedAt）
  get  {"remote": "workspace/…", "local": 本机文件}  读回本机（48000 字节一块），核大小
只读写 am 的工作区和这里给的本机文件，不发消息（发消息走 muse-cli send）。
"""
import base64
import json
import os
import sys

from muse_cli.cli import connect, load_config

CHUNK_PUT = 40000
CHUNK_GET = 48000


def put(gw, a):
    data = open(a['local'], 'rb').read()
    remote = a['remote']
    for i in range(0, max(len(data), 1), CHUNK_PUT):
        part = data[i:i + CHUNK_PUT]
        body = {'path': remote, 'data_base64': base64.b64encode(part).decode('ascii'), 'create_parent': True}
        if i == 0:
            body['overwrite'] = True
        else:
            body['append'] = True
        gw.call_json('fs.write', body=body)
    st = gw.call_json('fs.stat', body={'path': remote})
    size = int(st.get('size', -1))
    return {'ok': size == len(data), 'remote': remote, 'size': size, 'expected': len(data)}


def lst(gw, a):
    r = gw.call_json('fs.list', body={'path': a['dir']})
    out = []
    for e in r.get('entries', []):
        if e.get('type') == 'file':
            out.append({'name': e['name'], 'size': e.get('size'), 'modifiedAt': e.get('modifiedAt')})
    return {'ok': True, 'files': out}


def get(gw, a):
    buf, off = b'', 0
    while True:
        r = gw.call_json('fs.read', body={'path': a['remote'], 'offset': off, 'len': CHUNK_GET})
        b = base64.b64decode(r['data_base64'])
        buf += b
        off += len(b)
        if r.get('eof') in (True, 'True') or not b:
            break
    d = os.path.dirname(a['local'])
    if d:
        os.makedirs(d, exist_ok=True)
    open(a['local'], 'wb').write(buf)
    return {'ok': True, 'local': a['local'], 'size': len(buf)}


def main():
    cmd = sys.argv[1]
    a = json.loads(sys.stdin.read() or '{}')
    gw = connect(load_config())
    fn = {'put': put, 'list': lst, 'get': get}[cmd]
    print(json.dumps(fn(gw, a), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as ex:  # 错误也打成一行 JSON，调用方据此判断
        print(json.dumps({'ok': False, 'error': str(ex)[:500]}, ensure_ascii=False))
        sys.exit(1)

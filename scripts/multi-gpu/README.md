# 多显卡：每卡一个 ComfyUI 实例（ic29）

## 架构
- IC「设置 → ComfyUI 服务」里配置多个本地端点（地址 + 显卡编号 + 启用开关 + 测试连接）。
- 有效渲染并发 = 启用的端点数；每次渲染派给**空闲**端点，一个端点同一时刻只跑 IC 的一个任务。
- 端点在**提交前**连不上 / 超时 → 冷却 60 s，本次渲染改派其它端点；提交后的失败不改派（避免同一镜在两张卡上各出一份）。
- 参考图/音频：先传到一个端点，渲染派到别的端点时提交前自动补传（按文件内容签名，同名换图会重传）。
- 产物从产出它的端点下载（各实例 output 目录独立）。
- 旧配置（只有 `comfyui.baseUrl`）读时自动迁移成 1 个端点，行为与改动前一致。

## 新实例怎么起（插第二张卡之后）
```
# 1) 先 dry-run：只做检查、打印命令，不启动
powershell -NoProfile -ExecutionPolicy Bypass -File start-comfyui-gpu.ps1 -Gpu 1 -Port 8190 -DryRun
# 2) 检查通过再正式启动（分离进程，日志在 C:\tmp_infinite_creation\ComfyUI_instances\gpu1_8190\logs）
powershell -NoProfile -ExecutionPolicy Bypass -File start-comfyui-gpu.ps1 -Gpu 1 -Port 8190
# 3) IC 设置页「添加端点」：http://127.0.0.1:8190，显卡 1 → 测试连接 → 打开启用 → 保存
# 停止：powershell -NoProfile -ExecutionPolicy Bypass -File stop-comfyui-gpu.ps1 -Port 8190
```
- 代码 / venv / `models`(148 GB) / `custom_nodes` 与 8189 共用 `C:\tmp_infinite_creation\ComfyUI`，**不复制模型**。
- 每个实例独立 `input / output / temp / user`（`C:\tmp_infinite_creation\ComfyUI_instances\gpu<N>_<port>\`）：
  ComfyUI 启动时会删除自己的 temp 目录（`app/assets/lifecycle.py cleanup_temp_filesystem`），共用 temp 会删掉 8189 正在用的临时文件。
- 绑卡：`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `--cuda-device N`（编号与 nvidia-smi 一致；进程内只看得到这一张卡）。
- 脚本拒绝：端口 8189 / 已占用端口；nvidia-smi 看不到的卡（本机现在只有 1 张，`-Gpu 1` 会被拒）；GPU 0（8189 所在）；目标卡已用显存 > 4 GB。

## 注意
- 8189 启动时没带 `--cuda-device`，Windows 下 ComfyUI 会强制 `CUDA_VISIBLE_DEVICES=0`，且用 CUDA 默认的 FASTEST_FIRST 顺序。
  两张卡**型号不同**时，8189 的「0」不一定是 nvidia-smi 的 0 号。新实例起来后用 `nvidia-smi` 核对两张卡各自的显存占用；
  稳妥做法是在总导安排的停机窗口给 8189 也加上 `CUDA_DEVICE_ORDER=PCI_BUS_ID` 与 `--cuda-device 0`（本次未改 8189）。
- 内存：H3 单任务 staged 约 38 GB（DiT 20.0 GB + TE 15.0 GB + VAE 2.7 GB + Audio VAE 0.6 GB，dynamic VRAM），本机内存 62 GB。
  两个实例同时跑 H3 时主机内存可能吃紧（safetensors 默认 mmap，同一文件的只读页理论上可被两个进程共享，需实测确认）。

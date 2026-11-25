@echo off
rem ic29 multi-GPU: run one extra ComfyUI instance bound to one GPU.
rem Launched detached by start-comfyui-gpu.ps1 (WMI). Do not double-click; use the .ps1 (it runs the safety checks).
rem Usage: run-comfyui-gpu.cmd <GPU index, nvidia-smi order> <port>
rem  - Code / venv / models / custom_nodes are shared with 8189 (C:\tmp_infinite_creation\ComfyUI): no model copy.
rem  - input / output / temp / user are per instance. ComfyUI rmtree's its temp dir on startup, so a shared
rem    temp dir would wipe files 8189 is using. Separate output avoids filename collisions; separate user = separate comfyui.db.
rem  - CUDA_DEVICE_ORDER=PCI_BUS_ID makes the index match nvidia-smi; --cuda-device exposes only that GPU (cuda:0 inside).
setlocal
set "GPU=%~1"
set "PORT=%~2"
if "%GPU%"=="" goto usage
if "%PORT%"=="" goto usage
if "%PORT%"=="8189" (
  echo [refuse] 8189 belongs to the existing instance
  exit /b 2
)
if exist "C:\tmp_infinite_creation\ic-env.cmd" call "C:\tmp_infinite_creation\ic-env.cmd"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8:backslashreplace"
set "CUDA_DEVICE_ORDER=PCI_BUS_ID"
set "COMFY_ROOT=C:\tmp_infinite_creation\ComfyUI"
set "INST=C:\tmp_infinite_creation\ComfyUI_instances\gpu%GPU%_%PORT%"
for %%D in (input output temp user logs) do if not exist "%INST%\%%D" mkdir "%INST%\%%D"
cd /d "%COMFY_ROOT%"
"%COMFY_ROOT%\.venv\Scripts\python.exe" -X utf8 -u -s main.py --listen 127.0.0.1 --port %PORT% --cuda-device %GPU% --disable-auto-launch --reserve-vram 2 --input-directory "%INST%\input" --output-directory "%INST%\output" --temp-directory "%INST%\temp" --user-directory "%INST%\user" >> "%INST%\logs\comfyui-%PORT%.log" 2>&1
exit /b %errorlevel%
:usage
echo Usage: run-comfyui-gpu.cmd GPU_INDEX PORT
exit /b 1

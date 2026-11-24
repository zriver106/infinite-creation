@echo off
rem Studio + command entry: same launch as run-frontend.cmd, only config and dist dir differ
call "C:\tmp_infinite_creation\ic-env.cmd"
cd /d "%IC_ROOT%\studio"
if not defined IC_CMD_STUDIO_PORT set "IC_CMD_STUDIO_PORT=4710"
if not defined IC_CMD_STUDIO_LOG set "IC_CMD_STUDIO_LOG=%IC_ROOT%\studio\logs\studio-preview.log"
set "STUDIO_HOST=127.0.0.1"
set "STUDIO_BACKEND=http://127.0.0.1:4610"
set "STUDIO_COMMAND_BACKEND=http://127.0.0.1:4620"
node node_modules\vite\bin\vite.js preview --config "C:\tmp_infinite_creation\studio_4710_command_20261123\vite.command.config.mjs" >> "%IC_CMD_STUDIO_LOG%" 2>&1

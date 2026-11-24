// 正式 Studio + 指挥 的 preview 配置（2026-11-23 Claude）
// 与 studio/vite.config.js 的 preview 部分一致，只多三条：/api/command、/api/chat、/api/issues 走指挥系统预览 4620。
// 其余 /api /files /samples /ws 照旧走正式后端 4610（STUDIO_BACKEND）。
// 指挥系统那边的写接口仍是 403（只有 /api/issues、/api/chat 写在预览目录里）。
// 不 import 任何包，方便放在 studio 目录之外。
const BACKEND = process.env.STUDIO_BACKEND || 'http://127.0.0.1:4610';
const COMMAND = process.env.STUDIO_COMMAND_BACKEND || 'http://127.0.0.1:4620';
const HOST = process.env.STUDIO_HOST || '0.0.0.0';
const PORT = Number(process.env.IC_CMD_STUDIO_PORT) || 4710;
const DIST = process.env.IC_CMD_STUDIO_DIST || 'C:/tmp_infinite_creation/studio_4710_command_20261123/dist';
const proxy = {
  '/api/command': { target: COMMAND, changeOrigin: false },
  '/api/chat': { target: COMMAND, changeOrigin: false },
  '/api/issues': { target: COMMAND, changeOrigin: false },
  '/api': { target: BACKEND, changeOrigin: false },
  '/files': { target: BACKEND, changeOrigin: false },
  '/samples': { target: BACKEND, changeOrigin: false },
  '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
};
export default {
  build: { outDir: DIST },
  preview: { port: PORT, host: HOST, strictPort: true, allowedHosts: true, proxy },
};

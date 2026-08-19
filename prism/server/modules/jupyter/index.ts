// JupyterLab 集成:进程管理 + /jupyter 反代 + /api/jupyter 控制面。
export { default as jupyterRoutes } from './jupyter.routes.js';
export {
  createJupyterProxyHandler,
  handleJupyterUpgrade,
} from './services/jupyter-proxy.service.js';
export { stopJupyter, getJupyterStatus, JUPYTER_BASE_PATH } from './services/jupyter-manager.service.js';
export type { JupyterStatus } from './services/jupyter-manager.service.js';

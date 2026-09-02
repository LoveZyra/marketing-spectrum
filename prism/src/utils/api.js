import { IS_PLATFORM } from "../constants/config";
import { emitToast } from "../shared/view/ui/toastBus";

import { hasJwtShape, installRefreshedToken } from "./tokenRefresh";

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
// dj 起实现挪进 tokenRefresh.ts(落盘还要求 userId 与当前令牌一致);这里保留
// 同名导出给既有调用方(改密响应体校验、两处上传)继续用作形状检查。
/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidRefreshedToken = (token) => hasJwtShape(token);

// Optional API-key gate: when the deployment sets PRISM_API_KEY on the server,
// the frontend must send the matching key with every /api request. Bake the
// build-time VITE_PRISM_API_KEY into an extra header when configured.
const PRISM_API_KEY = import.meta.env.VITE_PRISM_API_KEY;

/** Headers required by the server's optional PRISM_API_KEY gate (empty when unset). */
export const apiKeyHeaders = () =>
  PRISM_API_KEY ? { 'x-prism-api-key': PRISM_API_KEY } : {};

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {
    ...apiKeyHeaders(),
  };

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    // dj:经共享闸门落盘 —— 续期令牌必须与当前存储令牌同属一个 userId 才接受,
    // 否则丢弃。挡住两件事:HTTP 缓存 304 合并复活的旧账号续期头(no-store 之前
    // 的历史缓存),以及切换账号瞬间旧账号在途响应晚到的覆盖竞态。
    installRefreshedToken(response.headers.get('X-Refreshed-Token'));
    // 全局 401 兜底:令牌过期/被撤销后,原先各面板表现为"点了没反应"(只有文件树
    // 单独分辨过 401)。这里集中处理一次 —— 登录态下拿到 401,弹一条提示并派发
    // session-expired 事件,由 AuthProvider 清会话跳回登录。用去抖避免一次并发风暴
    // 弹一堆重复提示。auth 端点自己走裸 fetch,不经这里,所以这里的 401 一定是
    // "会话失效"而非"密码错"。
    if (response.status === 401 && !IS_PLATFORM && token) {
      handleSessionExpired();
    }
    return response;
  });
};

let sessionExpiredNotifiedAt = 0;
function handleSessionExpired() {
  const now = Date.now();
  // 5s 去抖:并发请求同时 401 时只提示一次。
  if (now - sessionExpiredNotifiedAt < 5000) return;
  sessionExpiredNotifiedAt = now;
  try {
    emitToast({
      message: '登录已过期,请重新登录。',
      variant: 'error',
    });
  } catch { /* toast 不可用不阻断 */ }
  try {
    window.dispatchEvent(new CustomEvent('prism:session-expired'));
  } catch { /* 环境无 window(测试)时忽略 */ }
}

// API endpoints
export const api = {
  // Auth endpoints (no token required, but the optional API-key gate still applies)
  auth: {
    status: () => fetch('/api/auth/status', { headers: apiKeyHeaders() }),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiKeyHeaders() },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiKeyHeaders() },
      body: JSON.stringify({ username, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    // options.all = true → 服务端 bump token_version,撤销该账号所有设备的旧令牌。
    // options.token:AuthContext.logout 先清本地再调这里,localStorage 已经空了;
    // 不带上捕获的旧令牌,这一枪永远 401,审计日志里就永远记不上 logout(dj 修)。
    logout: ({ all, token } = {}) => authenticatedFetch('/api/auth/logout', {
      method: 'POST',
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      body: JSON.stringify(all ? { all: true } : {}),
    }),
    // 改密成功服务端会吊销其他设备令牌并返回本会话的新令牌(调用方负责落 localStorage)。
    changePassword: (currentPassword, newPassword) => authenticatedFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
    // root 读全量,普通用户只回自己的行(服务端裁剪)。
    auditLog: ({ limit = 50, offset = 0 } = {}) =>
      authenticatedFetch(`/api/auth/audit-log?limit=${limit}&offset=${offset}`),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  // E10:归档会话服务端分页(默认 200/页)。不传参数 = 第一页。
  getArchivedSessions: ({ limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (Number.isFinite(limit)) params.set('limit', String(limit));
    if (Number.isFinite(offset) && offset > 0) params.set('offset', String(offset));
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/archived${qs ? `?${qs}` : ''}`);
  },
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  // F8:批量归档 / 恢复 / 删除。逐条鉴权在服务端做,看不见的静默跳过。
  bulkSessions: (action, sessionIds) =>
    authenticatedFetch('/api/providers/sessions/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, sessionIds }),
    }),
  // F8:清空回收站(永久删除当前用户看得见的归档会话)。
  emptyArchivedSessions: ({ olderThanDays } = {}) => {
    const params = new URLSearchParams();
    if (Number.isFinite(olderThanDays) && olderThanDays > 0) params.set('olderThanDays', String(olderThanDays));
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/archived${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  // EventSource 没法带 Authorization 头。过去这里把完整 JWT 拼进 `?token=` ——
  // 而 URL 会进反代日志和浏览器历史。改成:先用带 Bearer 头的 POST 换一张短命
  // 票据,再拿票据连 SSE,JWT 不进 URL。
  issueSearchTicket: async () => {
    const res = await authenticatedFetch('/api/providers/search/ticket', { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to obtain search ticket (${res.status})`);
    const data = await res.json();
    return data.ticket;
  },
  searchConversationsUrl: (query, ticket, limit = 50) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (ticket) params.set('ticket', ticket);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  projectPermissions: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/permissions`),
  updateProjectPermissions: (projectId, payload) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/permissions`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  jupyterStatus: () => authenticatedFetch('/api/jupyter/status'),
  // path 可选:传了就深链到 JupyterLab 里的那个文件。
  jupyterSession: (path) =>
    authenticatedFetch('/api/jupyter/session', {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  // baseMtimeMs:保存冲突检测基线(加载时拿到的 mtime)。传了它,服务端会在磁盘
  // 版本更新过时回 409(FILE_MODIFIED),避免静默覆盖别人的改动。
  saveFile: (projectId, filePath, content, baseMtimeMs) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify(
        typeof baseMtimeMs === 'number'
          ? { filePath, content, baseMtimeMs }
          : { filePath, content },
      ),
    }),
  // `dirPath` lists a directory other than the project root (the file tree's
  // "up one level"). Omit it for the project's own tree — the server bounds
  // any explicit path to WORKSPACES_ROOT and answers 403 outside it.
  getFiles: (projectId, options = {}, dirPath) =>
    authenticatedFetch(
      dirPath
        ? `/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}`
        : `/api/projects/${projectId}/files`,
      options,
    ),

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};

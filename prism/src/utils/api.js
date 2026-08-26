import { IS_PLATFORM } from "../constants/config";
import { emitToast } from "../shared/view/ui/toastBus";

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidRefreshedToken = (token) =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

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
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (isValidRefreshedToken(refreshedToken)) {
      localStorage.setItem('auth-token', refreshedToken);
    }
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
    logout: (options) => authenticatedFetch('/api/auth/logout', {
      method: 'POST',
      ...(options ? { body: JSON.stringify(options) } : {}),
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
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
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

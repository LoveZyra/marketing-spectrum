import { IS_PLATFORM } from "../constants/config";
import { emitToast } from "../shared/view/ui/toastBus";

import { hasJwtShape, installRefreshedToken } from "./tokenRefresh";

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
// 实现在 tokenRefresh.ts(落盘还要求 userId 与当前令牌一致);这个导出只做形状检查,
// 供改密响应体校验与两处上传使用。
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

/**
 * 方法隧道:PATCH / PUT / DELETE 一律改成 POST + `X-HTTP-Method-Override` 发出。
 *
 * 只放行 GET / POST 的企业代理会把 PATCH 等请求拦在半路(明文 HTTP 部署时代理看得见每个请求),
 * 表现为同一个开关在某些机器上点了毫无反应。服务端 `shared/method-override.ts` 在路由之前
 * 把 req.method 改回真实方法,路由、代理转发、审计都不用改。集合与服务端同一份,必须一起改。
 */
const TUNNELED_METHODS = new Set(['PATCH', 'PUT', 'DELETE']);

/**
 * 给 URL 追加 `_method=<真实方法>`。
 *
 * 安全型代理 / WAF 会剥掉 `X-HTTP-Method-Override` 头(它是已知的方法限制绕过手法,
 * 专门有规则盯它),查询串则不会被剥。两样都带,服务端两样都认。
 *
 * @param {string} url
 * @param {string} method
 * @returns {string}
 */
export const withMethodQuery = (url, method) => {
  const separator = url.includes('?') ? '&' : '?';
  const hash = url.indexOf('#');
  return hash === -1
    ? `${url}${separator}_method=${method}`
    : `${url.slice(0, hash)}${separator}_method=${method}${url.slice(hash)}`;
};

/**
 * @param {string} url
 * @param {RequestInit} options
 * @returns {{ url: string, method?: string, headers: Record<string, string>, tunneled: boolean }}
 *   改写后的 URL / 方法 / 要追加的头;tunneled 为真表示这条请求走了隧道
 */
export const tunnelMethod = (url, options = {}) => {
  const method = typeof options.method === 'string' ? options.method.toUpperCase() : undefined;
  if (!method || !TUNNELED_METHODS.has(method)) {
    return { url, method: options.method, headers: {}, tunneled: false };
  }
  return {
    url: withMethodQuery(url, method),
    method: 'POST',
    headers: { 'X-HTTP-Method-Override': method },
    tunneled: true,
  };
};

let tunnelFailureNotifiedAt = 0;
/**
 * 隧道请求拿到一个非 JSON 的 404,说明 POST 到了服务端却没被改写回真实方法
 * (Express 默认的 "Cannot POST …" 页)。只有两种解释,都不是页面本身的错:
 * 服务端还在跑不带方法改写中间件的旧进程,或者代理把头和查询串都剥了。
 * 把这句说出来,别让用户对着「HTTP 404」猜。5s 去抖。
 * @param {Response} response
 */
const maybeExplainTunnelFailure = (response) => {
  if (response.status !== 404) return;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return;
  const now = Date.now();
  if (now - tunnelFailureNotifiedAt < 5000) return;
  tunnelFailureNotifiedAt = now;
  try {
    emitToast({
      message: '服务端没有识别到方法隧道(HTTP 404)',
      description: '请确认 Prism 服务已重启到 ea 或更新的版本;若已重启,说明网络代理把改写标记也拦掉了,请把这条提示发给维护者。',
      variant: 'error',
      durationMs: 12000,
    });
  } catch { /* toast 不可用不阻断 */ }
};

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

  const tunneled = tunnelMethod(url, options);

  return fetch(tunneled.url, {
    ...options,
    ...(tunneled.method !== undefined ? { method: tunneled.method } : {}),
    headers: {
      ...defaultHeaders,
      ...options.headers,
      ...tunneled.headers,
    },
  }).then((response) => {
    if (tunneled.tunneled) maybeExplainTunnelFailure(response);
    // 经共享闸门落盘:续期令牌必须与当前存储令牌同属一个 userId 才接受,否则丢弃。
    // 挡住两件事:HTTP 缓存 304 合并复活的旧账号续期头,以及切换账号瞬间旧账号在途响应晚到的覆盖竞态。
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
/**
 * 导出给 XHR 上传路径复用(见 uploadWithProgress):401 的处置必须
 * 只有一份,去抖也才共用得上。
 */
export function handleSessionExpired() {
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
    // 不带上捕获的旧令牌,这一枪永远 401,审计日志里就永远记不上 logout。
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
    /**
     * @param {{limit?: number, offset?: number, events?: string[], outcome?: string, username?: string}} [options]
     */
    auditLog: (options = {}) => {
      const { limit = 50, offset = 0, events = [], outcome = '', username = '' } = options;
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      // 三个筛选参数都只在有值时才带上 —— 空参数会让 URL 变长且不好读,
      // 而服务端对空值的处理本来就是"不筛"。
      if (events.length > 0) query.set('events', events.join(','));
      if (outcome) query.set('outcome', outcome);
      if (username.trim()) query.set('username', username.trim());
      return authenticatedFetch(`/api/auth/audit-log?${query.toString()}`);
    },
  },

  // Protected endpoints
  // The path/query identifier is the DB-assigned `projectId`.
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
  // 技能优化(SkillWhet)。整层可能没挂载(404),调用方按 useSkillWhetStatus 判断。
  skillWhet: {
    status: () => authenticatedFetch('/api/skillwhet/status'),
    skills: () => authenticatedFetch('/api/skillwhet/skills'),
    skill: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}`),
    gate: (name, rerun = false) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/gate`, rerun ? { method: 'POST', body: '{}' } : undefined),
    facts: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/facts`),
    contract: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/contract`),
    wiki: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/wiki`),
    feedbackStats: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/feedback-stats`),
    importSkill: (name, replace = false) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/import`, { method: 'POST', body: JSON.stringify({ replace }) }),
    bootstrap: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/bootstrap`, { method: 'POST', body: '{}' }),
    removeSkill: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    uploadSkill: (name, files) => authenticatedFetch('/api/skillwhet/skills/upload', { method: 'POST', body: JSON.stringify({ name, files }) }),
    tasksValidate: (skill, format, content) => authenticatedFetch('/api/skillwhet/tasks/validate', { method: 'POST', body: JSON.stringify({ skill, format, content }) }),
    tasksAdd: (skill, format, content, keepPassing = false) => authenticatedFetch('/api/skillwhet/tasks', { method: 'POST', body: JSON.stringify({ skill, format, content, keep_passing: keepPassing }) }),
    tasks: (skill) => authenticatedFetch(`/api/skillwhet/tasks${skill ? `?skill=${encodeURIComponent(skill)}` : ''}`),
    // 训练作业 / staging / 发布 / 反馈收件箱
    tasksDerive: (skill, testDir = 'tests/unit') => authenticatedFetch('/api/skillwhet/tasks/derive', { method: 'POST', body: JSON.stringify({ skill, test_dir: testDir }) }),
    jobs: (skill, limit) => authenticatedFetch(`/api/skillwhet/jobs?${[skill ? `skill=${encodeURIComponent(skill)}` : '', limit ? `limit=${limit}` : ''].filter(Boolean).join('&')}`),
    job: (id) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}`),
    jobProgress: (id, after = 0) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/progress?after=${after}`),
    jobLog: (id, tail = 200) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/log?tail=${tail}`),
    jobCreate: (skill, args) => authenticatedFetch('/api/skillwhet/jobs', { method: 'POST', body: JSON.stringify({ skill, kind: 'train', args }) }),
    jobCancel: (id) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
    jobBudget: () => authenticatedFetch('/api/skillwhet/jobs/budget'),
    staging: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/staging`),
    stagingDetail: (name, sid) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/staging/${encodeURIComponent(sid)}`),
    // force 与 skip_release 各是各的开关(没被接受 ≠ 没做留出集评估)
    stagingAdopt: (name, sid, { force = false, skipRelease = false } = {}) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/staging/${encodeURIComponent(sid)}/adopt`, { method: 'POST', body: JSON.stringify({ force, skip_release: skipRelease }) }),
    stagingExport: (name, sid) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/staging/${encodeURIComponent(sid)}/export`),
    publish: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/publish`, { method: 'POST', body: '{}' }),
    publishAsNew: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/publish-as-new`, { method: 'POST', body: '{}' }),
    rollbacks: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/rollbacks`),
    publishHistory: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/publishes`),
    rollback: (name, to) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/rollback`, { method: 'POST', body: JSON.stringify({ to }) }),
    feedbackInbox: (skill) => authenticatedFetch(`/api/skillwhet/feedback/inbox${skill ? `?skill=${encodeURIComponent(skill)}` : ''}`),
    feedbackInboxAccept: (ids) => authenticatedFetch('/api/skillwhet/feedback/inbox/accept', { method: 'POST', body: JSON.stringify({ ids }) }),
    // 从会话挖任务 / 留出集评估(release-once)
    harvestProjects: () => authenticatedFetch('/api/skillwhet/harvest/projects'),
    harvestStart: (payload) => authenticatedFetch('/api/skillwhet/harvest', { method: 'POST', body: JSON.stringify(payload) }),
    jobResult: (id) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/result`),
    jobImport: (id, taskIds) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify(taskIds ? { task_ids: taskIds } : {}) }),
    releaseEval: (name, sid) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/staging/${encodeURIComponent(sid)}/release-eval`, { method: 'POST', body: '{}' }),
    // 夜训计划 / 从中断处续跑
    nightly: () => authenticatedFetch('/api/skillwhet/nightly'),
    nightlySave: (name, plan) => authenticatedFetch(`/api/skillwhet/nightly/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(plan) }),
    checkpoint: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/checkpoint`),
    jobResume: (id) => authenticatedFetch(`/api/skillwhet/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' }),
    provenance: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/provenance`),
    ledger: (name) => authenticatedFetch(`/api/skillwhet/skills/${encodeURIComponent(name)}/ledger`),
  },
  // 对话里的反馈(点赞 / 点踩与效果调查卡)。
  sessionFeedback: {
    list: (sessionId) => authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/feedback`),
    set: (sessionId, messageId, payload) => authenticatedFetch(
      `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/feedback`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
    remove: (sessionId, messageId) => authenticatedFetch(
      `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/feedback`,
      { method: 'DELETE' },
    ),
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
  // 归档会话服务端分页(默认 200/页)。不传参数 = 第一页。
  getArchivedSessions: ({ limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (Number.isFinite(limit)) params.set('limit', String(limit));
    if (Number.isFinite(offset) && offset > 0) params.set('offset', String(offset));
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/archived${qs ? `?${qs}` : ''}`);
  },
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  // 批量归档 / 恢复 / 删除。逐条鉴权在服务端做,看不见的静默跳过。
  bulkSessions: (action, sessionIds) =>
    authenticatedFetch('/api/providers/sessions/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, sessionIds }),
    }),
  // 清空归档:永久删除当前用户看得见的归档会话(进「最近删除」,保留期内可恢复)。
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
  // 最近删除(会话回收站)。永久删除的会话在保留期内可从这里恢复。
  trashedSessions: ({ limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (Number.isFinite(limit)) params.set('limit', String(limit));
    if (Number.isFinite(offset) && offset > 0) params.set('offset', String(offset));
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/trash${qs ? `?${qs}` : ''}`);
  },
  restoreTrashedSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/trash/${encodeURIComponent(sessionId)}/restore`, {
      method: 'POST',
    }),
  purgeTrashedSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/trash/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  /**
   * 会话产出文件。产出不一定落在项目目录里(计划文件在 ~/.claude/plans、
   * 临时脚本在 /tmp),项目文件接口只服务项目根以内,点开就是 403。这条路由按
   * "这段会话自己写出来的文件"放行,所以产出区列出来的东西都能看、能下。
   */
  sessionOutputText: (sessionId, filePath) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/output?mode=text&path=${encodeURIComponent(filePath)}`),
  sessionOutputBlob: (sessionId, filePath) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/output?path=${encodeURIComponent(filePath)}`),

  // 常驻运行时的真实状态与释放(顶栏「常驻会话」开关)。打开走 prewarm。
  sessionRuntime: (sessionId) =>
    authenticatedFetch(`/api/providers/claude/sessions/${encodeURIComponent(sessionId)}/runtime`),
  releaseSessionRuntime: (sessionId) =>
    authenticatedFetch(`/api/providers/claude/sessions/${encodeURIComponent(sessionId)}/runtime/release`, {
      method: 'POST',
    }),
  prewarmSession: (sessionId, body = {}) =>
    authenticatedFetch(`/api/providers/claude/sessions/${encodeURIComponent(sessionId)}/prewarm`, {
      method: 'POST',
      body: JSON.stringify(body),
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
  // 项目批量操作。action = archive | delete | star | unstar | permissions | owner。
  // 服务端逐条鉴权,看不见 / 管不了的会被跳过并在结果里计数,调用方要如实报账。
  bulkProjects: (action, projectIds, extra = {}) =>
    authenticatedFetch('/api/projects/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, projectIds, ...extra }),
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  /**
   * 换一张下载票,拿回一个能直接交给浏览器的 URL。
   *
   * 传一个路径且是文件 → `kind:'file'`(有 Content-Length,浏览器画得出百分比);
   * 传目录或多个路径 → `kind:'zip'`(服务端边压边发,没有百分比,只有已下载多少)。
   *
   * 权限、路径越界、文件不存在全在这一步挡掉 —— 必须如此:后面那步是浏览器导航,
   * 失败了只会在下载栏里留一行"失败",弹不出应用内的提示。
   */
  issueDownloadTicket: (projectId, paths) =>
    authenticatedFetch(`/api/projects/${projectId}/files/download-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }),
  /** 会话产出的下载票。同上,失败必须挡在这一步。 */
  issueSessionOutputDownloadTicket: (sessionId, filePath) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/output-download-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }),
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

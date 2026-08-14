/**
 * 谁能看到哪个项目 —— 列表接口与实时广播共用的同一条判定。
 *
 * 存在的理由是一次真实的串台:HTTP 列表按 owner 过滤了,`session_upserted`
 * 广播却没有。于是 A 在自己项目里发消息时,B 的侧边栏会突然冒出 A 的项目,
 * 刷新一下(重新走 HTTP)又消失。两条路必须用同一个判定,否则永远会漂移。
 *
 * 规则和 projectsDb.getProjectPaths(visibleTo) 一致:
 *   - owner 为空 = 公共项目,所有人可见;
 *   - root 看全部;
 *   - 其余人只看自己的。
 *
 * 原先这里写着"这是界面隔离,不是越权防护 —— 知道 projectId 的人照样能调各个
 * project 级接口"。那条取舍已经作废:一次全局扫描发现归档会话接口会把所有人的
 * projectId 直接发出来,"你得先知道 id"这个前提根本不成立。现在同一条判定被
 * 下推到了会话、checkpoint、发布、终端各条读写路径上,见各处的 assert。
 */
import { isRootUser } from './root-users.js';

/**
 * @param {{ ownerUserId: number|string|null|undefined,
 *           viewerUserId: number|string|null|undefined,
 *           viewerUsername: string|null|undefined }} input
 * @returns {boolean}
 */
export function canViewerSeeProject({ ownerUserId, viewerUserId, viewerUsername }) {
  // 公共项目
  if (ownerUserId === null || ownerUserId === undefined) return true;

  if (isRootUser(viewerUsername ?? undefined)) return true;

  if (viewerUserId === null || viewerUserId === undefined) return false;

  // 广播路径上 id 的来源不止一处(JWT、ticket、平台模式),类型不保证一致,
  // 按字符串比更稳:数字 7 与字符串 "7" 是同一个人。
  return String(ownerUserId) === String(viewerUserId);
}

/**
 * 一个"访问者"的最小身份。判定只需要这两样,多带字段只会让调用点各自发明格式。
 * @typedef {{ userId: number|string|null, username: string|null }} Viewer
 */

/**
 * 从 Express 请求上取访问者身份。
 *
 * `authenticateToken` 挂的是 `req.user`;平台模式下可能整个缺失。缺失时返回
 * 两个 null —— 对非公共项目即"看不见",这是安全的方向:宁可多挡,不可漏放。
 *
 * @param {{ user?: { id?: number|string|null, username?: string|null } }} request
 * @returns {Viewer}
 */
export function readRequestViewer(request) {
  const user = request?.user;
  return {
    userId: user?.id ?? null,
    username: typeof user?.username === 'string' ? user.username : null,
  };
}

/**
 * 把访问者身份盖在 WebSocket 上。
 *
 * 广播和订阅都只拿得到裸 socket,拿不到当初的 HTTP 请求,所以身份必须在连接
 * 建立时就盖上去。**chat 和 shell 两条连接都要盖** —— 只盖 chat 那半,是
 * `claimForShell` 记录的持有者恒为 null 的原因。
 *
 * @param {object} ws
 * @param {{ user?: { id?: number|string|null, username?: string|null } }} request
 */
export function stampSocketViewer(ws, request) {
  const viewer = readRequestViewer(request);
  ws.prismUserId = viewer.userId;
  ws.prismUsername = viewer.username;
}

/**
 * 读回 `stampSocketViewer` 盖上的身份。
 * @param {object} ws
 * @returns {Viewer}
 */
export function readSocketViewer(ws) {
  return {
    userId: ws?.prismUserId ?? null,
    username: typeof ws?.prismUsername === 'string' ? ws.prismUsername : null,
  };
}

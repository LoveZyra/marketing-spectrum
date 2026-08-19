/**
 * 谁能看到哪个项目 —— 列表接口与实时广播共用的同一条判定。
 *
 * 存在的理由是一次真实的串台:HTTP 列表按 owner 过滤了,`session_upserted`
 * 广播却没有。于是 A 在自己项目里发消息时,B 的侧边栏会突然冒出 A 的项目,
 * 刷新一下(重新走 HTTP)又消失。两条路必须用同一个判定,否则永远会漂移。
 *
 * 规则(2026-08-14 改)—— 无主项目**不再默认公开**:
 *   - root 看全部;
 *   - 有主项目:owner 本人 + root;
 *   - **无主项目:只有落在公共目录(PRISM_PUBLIC_WORKSPACE)之下才对所有人可见**,
 *     否则仅 root。以前无主 = 全公开,是个默认就漏的口子:任何在工作区根下被
 *     扫描进来、还没被认领的目录,都会自动对全体登录用户可见。
 *
 * 因此判定现在**需要项目路径**:无主 + 在公共目录下 = 公开,无主 + 不在 = 仅 root。
 * 不传 projectPath 时按"不在公共目录"处理(更安全的方向:宁可多挡)。
 *
 * SQL 侧 `projectsDb.getProjectPaths(visibleTo)` 编码的是同一条规则,
 * `project-visibility-parity` 测试在同一组样本上交叉验证两者不漂移。
 */
import path from 'node:path';

import { isRootUser } from './root-users.js';

/**
 * 一个项目路径算不算"公共目录下"。
 *
 * 公共目录由 PRISM_PUBLIC_WORKSPACE 指定(一个绝对路径)。不配 = 没有任何公共
 * 项目,所有无主项目都只有 root 看得到 —— 这正是用户要的默认。
 *
 * 词法包含判定(不 realpath):项目路径来自 DB,建项目时已 resolve 过;而这里
 * 是可见性判定不是文件读写边界,词法足够,也不想为一次判定去戳磁盘。
 *
 * @param {string|null|undefined} projectPath
 * @returns {boolean}
 */
export function isPublicWorkspacePath(projectPath) {
  const configured = process.env.PRISM_PUBLIC_WORKSPACE;
  if (!configured || !configured.trim()) return false;
  if (typeof projectPath !== 'string' || !projectPath.trim()) return false;

  const root = path.resolve(configured.trim());
  const candidate = path.resolve(projectPath.trim());
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * 规则(2026-08-18 扩展,创建项目的权限三选落地):
 *   1. root → 全可见;
 *   2. `visibility === 'public'`(创建时选「公共」)→ 所有登录用户可见;
 *   3. 无主项目 → 仅当落在公共目录(PRISM_PUBLIC_WORKSPACE)下才对非 root 可见;
 *   4. owner 本人 → 可见;
 *   5. 在 `sharedUserIds`(创建时选「指定用户」,存 project_shares 表)里 → 可见;
 *   6. 其余 → 不可见。
 *
 * SQL 侧 `projectsDb.getProjectPaths(visibleTo)` 编码同一条规则,parity 测试交叉验证。
 *
 * @param {{ ownerUserId: number|string|null|undefined,
 *           viewerUserId: number|string|null|undefined,
 *           viewerUsername: string|null|undefined,
 *           projectPath?: string|null,
 *           visibility?: string|null,
 *           sharedUserIds?: Array<number|string>|null }} input
 * @returns {boolean}
 */
export function canViewerSeeProject({ ownerUserId, viewerUserId, viewerUsername, projectPath, visibility, sharedUserIds }) {
  // root 看全部 —— 提到最前,其余规则它都该越过。
  if (isRootUser(viewerUsername ?? undefined)) return true;

  // 显式公共(创建时选的),不依赖路径、不依赖 owner。
  if (visibility === 'public') return true;

  const unowned = ownerUserId === null || ownerUserId === undefined;
  if (unowned) {
    // 无主项目:只有在公共目录下才对非 root 可见。
    return isPublicWorkspacePath(projectPath);
  }

  if (viewerUserId === null || viewerUserId === undefined) return false;

  // 广播路径上 id 的来源不止一处(JWT、ticket、平台模式),类型不保证一致,
  // 按字符串比更稳:数字 7 与字符串 "7" 是同一个人。
  if (String(ownerUserId) === String(viewerUserId)) return true;

  // 指定用户授权(project_shares)。
  if (Array.isArray(sharedUserIds)
    && sharedUserIds.some((sharedId) => String(sharedId) === String(viewerUserId))) {
    return true;
  }

  return false;
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

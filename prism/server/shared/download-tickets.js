import { createTicketStore } from './ticket-store.js';

/**
 * 「交给浏览器自己下」用的短命票据。
 *
 * ## 为什么需要它
 *
 * 想要浏览器**原生的下载进度条**,就必须让浏览器自己去导航那个 URL —— 而
 * **一次普通导航设不了 `Authorization` 头**。这和 EventSource(sse-tickets.js)、
 * 沙箱 iframe(preview-tickets.js)撞的是同一堵墙,JupyterLab 当年也是这么解的
 * (它把 `?token=` 拼进 `/files/<path>`)。
 *
 * 页面自己 `fetch` 再拼 blob 那套没有这个问题,但代价是**整份文件先进内存**:
 * 没有进度、切页就断、大文件直接把标签页撑崩。下载这件事本来就该归浏览器管。
 *
 * ## 为什么不复用 SSE 票
 *
 * `issueSseTicket(userId)` 的载荷只有 userId —— 拼进 URL 就等于一把
 * **"60 秒内能读这个账号任意文件"** 的钥匙,而 URL 会进反代 access log。
 * 下载不需要这么宽:**签票的那一刻我们已经知道要下哪一个东西**。所以载荷
 * 限定到具体目标,票泄了也只泄那一个目标,而不是那个账号。
 *
 * 顺带:目标路径放在票里、不放在查询串上,路径本身也就不进日志了。
 *
 * ## 三个决定
 *
 * - **TTL 5 分钟**:票只在**请求发起的那一刻**校验一次,校验过就开始传字节 ——
 *   所以一个文件下两小时也不会中断,5 分钟管的是"多久之内必须**开始**"。
 *   唯一受影响的是"暂停/断线后接着下":浏览器会拿同一个 URL 重发一次请求,
 *   距签票超过 5 分钟就会被拒,得重新点一次下载。这是明确选择的保守值。
 * - **`singleUse: false`**:浏览器重定向、续传、某些扩展的预检都可能重发同一个
 *   URL。一次性票会让第二次请求直接 401 —— 预览票据当年就是栽在这一条上。
 * - **载荷带 `kind`**:项目单文件 / 项目打包 / 会话产出三种目标共用一个票据池,
 *   但**消费方必须自己核对 kind 和归属**。一张"会话产出"的票打不了项目文件口。
 *
 * ## 票不是授权,只是身份
 *
 * 载荷里带的是**签票时那个 viewer**(userId + username),不是一句"已授权"。
 * 下载口会拿它**把可见性和路径校验重跑一遍** —— 这 5 分钟里用户可能被停用、
 * 项目可能被移走。一张票能证明"是谁在下",不能证明"现在还能下"。
 */
/**
 * @typedef {import('./project-visibility.js').Viewer} TicketViewer
 * @typedef {{ absPath: string, entryName: string, isDirectory: boolean }} ZipEntry
 * @typedef {{ kind: 'project-file', viewer: TicketViewer, projectId: string, filePath: string }} ProjectFileTicket
 * @typedef {{ kind: 'project-zip', viewer: TicketViewer, projectId: string, entries: ZipEntry[], zipName: string }} ProjectZipTicket
 * @typedef {{ kind: 'session-output', viewer: TicketViewer, sessionId: string, filePath: string }} SessionOutputTicket
 */

export const DOWNLOAD_TICKET_TTL_MS = 5 * 60_000;

const store = createTicketStore({ ttlMs: DOWNLOAD_TICKET_TTL_MS, singleUse: false });

/**
 * 项目里的一个文件。`viewer` 是 `readRequestViewer(req)` 的返回值。
 * @param {{ viewer: TicketViewer, projectId: string, filePath: string }} input
 * @returns {string}
 */
export function issueProjectFileTicket({ viewer, projectId, filePath }) {
  return store.issue({
    kind: 'project-file',
    viewer: normalizeViewer(viewer),
    projectId: String(projectId),
    filePath: String(filePath),
  });
}

/**
 * 项目里的一组路径,打成一个 zip。
 *
 * `entries` 的每一项是 `{ absPath, entryName, isDirectory }`:`entryName` 是它在
 * 压缩包里的名字(相对项目根,保留层级 —— 否则多选到两个同名文件会在包里撞车)。
 */
/**
 * @param {{ viewer: TicketViewer, projectId: string, entries: ZipEntry[], zipName: string }} input
 * @returns {string}
 */
export function issueProjectZipTicket({ viewer, projectId, entries, zipName }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('issueProjectZipTicket requires a non-empty entries array');
  }
  return store.issue({
    kind: 'project-zip',
    viewer: normalizeViewer(viewer),
    projectId: String(projectId),
    entries: entries.map((e) => ({
      absPath: String(e.absPath),
      entryName: String(e.entryName),
      isDirectory: Boolean(e.isDirectory),
    })),
    zipName: String(zipName),
  });
}

/**
 * 一次会话写出来的产出文件。
 * @param {{ viewer: TicketViewer, sessionId: string, filePath: string }} input
 * @returns {string}
 */
export function issueSessionOutputTicket({ viewer, sessionId, filePath }) {
  return store.issue({
    kind: 'session-output',
    viewer: normalizeViewer(viewer),
    sessionId: String(sessionId),
    filePath: String(filePath),
  });
}

/**
 * 解析一张票。未知 / 已过期 / **kind 不符**都返回 null —— 对调用方不可区分。
 *
 * `expectedKind` 不是可选的礼貌参数:不核对 kind,一张"会话产出"的票就能拿去打
 * 项目文件口,那两条路由的归属校验是各自独立的。
 *
 * @template {'project-file' | 'project-zip' | 'session-output'} K
 * @param {unknown} ticket
 * @param {K} expectedKind
 * @returns {(K extends 'project-file' ? ProjectFileTicket
 *   : K extends 'project-zip' ? ProjectZipTicket
 *   : SessionOutputTicket) | null}
 */
export function readDownloadTicket(ticket, expectedKind) {
  if (!expectedKind) throw new Error('readDownloadTicket requires an expectedKind');
  const payload = store.consume(ticket, (p) => p.kind === expectedKind);
  return payload ?? null;
}

/** 仅供测试。 */
export function resetDownloadTickets() {
  store.reset();
}

/**
 * 记下签票时的 viewer。
 *
 * **匿名签不出票**:`userId` 为空时直接抛,而不是签一张"谁都不是"的票 ——
 * 下载口拿它重跑可见性时,空身份在某些项目形态下反而会被放行。
 */
/**
 * @param {TicketViewer | undefined} viewer
 * @returns {TicketViewer}
 */
function normalizeViewer(viewer) {
  const userId = viewer?.userId;
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('download ticket requires an identified viewer');
  }
  return {
    userId,
    username: typeof viewer?.username === 'string' ? viewer.username : null,
  };
}

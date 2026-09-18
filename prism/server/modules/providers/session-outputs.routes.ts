import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';
import mime from 'mime-types';

import { canViewerSeeSession, sessionMessagesDb } from '@/modules/database/index.js';
import { isInlineSafeContentType } from '@/modules/files/index.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { setDownloadHeaders } from '@/shared/download-headers.js';
import { issueSessionOutputTicket, readDownloadTicket } from '@/shared/download-tickets.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('providers');

/**
 * 会话产出文件的读取通道(ei)。
 *
 * ## 为什么需要它
 *
 * 对话产出的文件**不一定落在项目目录里** —— agent 用的是这台机器上的真实文件系统,
 * 计划文件写进 `~/.claude/plans/`、临时脚本写进 `/tmp`,都很常见。而项目文件接口
 * (`/api/projects/:id/files/content`)只服务项目根以内的路径,于是"产出"列表里点开
 * 这类文件就是一句 `403 Forbidden`(用户截图)。列出来却打不开,是最差的一种状态。
 *
 * ## 为什么这样开放是安全的
 *
 * 这条路由**不接受任意路径**。它把请求路径和**这段会话自己的写入记录**对账:
 * 只有在该会话的显示日志里出现过、且执行成功的 `Write` 目标,才允许读。这不是
 * 放宽权限,而是把已经发生的事读回来 —— 那个文件正是这位用户的这段对话写出来的,
 * 内容本来就来自他自己;真想看,让 agent `cat` 一遍同样能拿到。所以这里给的不是
 * 新能力,只是省掉"再问一遍 agent"。
 *
 * 三道闸依次是:登录态(authenticateToken,挂在装配处)→ 这段会话对当前视角可见
 * (canViewerSeeSession,和导出 / 删除同一套)→ 路径在该会话的写入集合里(下面)。
 * 出参沿用项目文件接口那套加固:类型照实报、`nosniff`、非内联安全类型一律
 * `Content-Disposition: attachment`(防止同源内联渲染一份 agent 写出来的 HTML)。
 */

/** 单次读取的上限:产出多是文档 / 脚本,超过这个数就只让下载,不进编辑器。 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

type WriteRecord = { toolId: string; filePath: string };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * 这段会话**成功写出**的文件集合(绝对路径,已 resolve)。
 *
 * 判据与前端的产出列表同源:`Write` 工具 + 结果帧存在且非错。子代理里的写入
 * (`subagentTools` / `childTools`)一并计入 —— 它们同样是这段对话的产出。
 * 注意这里读的是**服务端自己的显示日志**,不看客户端传了什么。
 */
export function collectSessionWritePaths(messages: readonly unknown[]): Set<string> {
  const writes: WriteRecord[] = [];
  const okResults = new Set<string>();

  const noteWrite = (toolName: unknown, toolInput: unknown, toolId: unknown) => {
    if (toolName !== 'Write') return;
    const input = asRecord(toolInput);
    const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : '';
    if (!filePath) return;
    writes.push({ toolId: String(toolId ?? ''), filePath });
  };

  for (const raw of messages) {
    const message = asRecord(raw);

    if (message.kind === 'tool_use') {
      noteWrite(message.toolName, message.toolInput, message.toolId);
    }

    if (message.kind === 'tool_result' && !message.isError) {
      okResults.add(String(message.toolId ?? ''));
    }

    // 子代理:写入与结果打包在父帧上,没有独立的 tool_result 行。
    for (const key of ['subagentTools', 'childTools']) {
      const children = (message as Record<string, unknown>)[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        const record = asRecord(child);
        const result = asRecord(record.toolResult);
        if (record.toolName !== 'Write') continue;
        if (!record.toolResult || result.isError) continue;
        const input = asRecord(record.toolInput);
        const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : '';
        if (filePath) writes.push({ toolId: `child:${String(record.toolId ?? filePath)}`, filePath });
        okResults.add(`child:${String(record.toolId ?? filePath)}`);
      }
    }
  }

  const allowed = new Set<string>();
  for (const write of writes) {
    if (!okResults.has(write.toolId)) continue;
    allowed.add(path.resolve(write.filePath));
  }
  return allowed;
}

/**
 * 会话产出的三道闸:会话可见 → 路径在这段会话的写入集合里 → 是个真文件。
 *
 * 抽出来是因为**签票和直传要各跑一遍同一套判定**。两边各抄一份的结果必然是漂移,
 * 而漂移的那一半正好是不带登录态的那条路由 —— 这个仓已经这么破过一次
 * (`usage.routes.ts` 迁出来时漏挂 `canViewerSeeSession`,邻居都有就它没有)。
 */
async function checkSessionOutputAccess(
  sessionId: string,
  viewer: ReturnType<typeof readRequestViewer>,
  requestedPath: string,
): Promise<{ resolved: string; size: number } | { status: number; error: string }> {
  if (!canViewerSeeSession(sessionId, viewer)) {
    return { status: 404, error: 'Session not found' };
  }

  let allowed: Set<string>;
  try {
    allowed = collectSessionWritePaths(sessionMessagesDb.listForSession(sessionId));
  } catch (error) {
    log.warn('[SessionOutput] failed to read display log:', (error as Error)?.message || error);
    return { status: 500, error: 'Failed to resolve session outputs' };
  }

  const resolved = path.resolve(requestedPath);
  if (!allowed.has(resolved)) {
    // 不区分"没写过"和"写过但已删" —— 对调用方都是一句"这不是本会话的产出"。
    return { status: 403, error: 'Not an output of this session' };
  }

  try {
    const stat = await fsPromises.stat(resolved);
    if (!stat.isFile()) return { status: 404, error: 'File not found' };
    return { resolved, size: stat.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 404, error: 'File not found' };
    if (code === 'EACCES') return { status: 403, error: 'Permission denied' };
    return { status: 500, error: (error as Error).message };
  }
}

type Deps = { authenticateToken: RequestHandler };

export function createSessionOutputsRouter({ authenticateToken }: Deps): Router {
  const router = express.Router();

  /**
   * GET /api/providers/sessions/:sessionId/output?path=<绝对路径>[&mode=text]
   *
   * `mode=text` 回 JSON(编辑器只读预览用),否则按字节流下发(下载 / 媒体预览)。
   */
  router.get('/sessions/:sessionId/output', authenticateToken, async (req, res) => {
    const sessionId = String(req.params.sessionId || '');
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    if (!sessionId || !requested) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    if (!canViewerSeeSession(sessionId, readRequestViewer(req))) {
      return res.status(404).json({ error: 'Session not found' });
    }

    let allowed: Set<string>;
    try {
      allowed = collectSessionWritePaths(sessionMessagesDb.listForSession(sessionId));
    } catch (error) {
      log.warn('[SessionOutput] failed to read display log:', (error as Error)?.message || error);
      return res.status(500).json({ error: 'Failed to resolve session outputs' });
    }

    const resolved = path.resolve(requested);
    if (!allowed.has(resolved)) {
      // 不区分"没写过"和"写过但已删" —— 对调用方都是一句"这不是本会话的产出"。
      return res.status(403).json({ error: 'Not an output of this session' });
    }

    try {
      const stat = await fsPromises.stat(resolved);
      if (!stat.isFile()) return res.status(404).json({ error: 'File not found' });

      const mimeType = mime.lookup(resolved) || 'application/octet-stream';

      if (req.query.mode === 'text') {
        if (stat.size > MAX_TEXT_BYTES) {
          return res.status(413).json({ error: 'File too large to preview', size: stat.size });
        }
        const content = await fsPromises.readFile(resolved, 'utf8');
        return res.json({ content, mtimeMs: stat.mtimeMs, size: stat.size, path: resolved });
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // 与项目文件接口同一条规矩:只有媒体类允许内联,其余一律当附件下发 ——
      // 否则 agent 写出来的一份 HTML 会在应用同源下被渲染。
      if (!isInlineSafeContentType(mimeType)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
      /**
       * **必须给 source 挂 error**。`pipe()` 只给 dest 挂,ReadStream 自己的
       * 'error' 无监听就是 EventEmitter 抛 → uncaughtException → **整个进程退出**,
       * 外层这圈 try/catch 抓不到异步流事件。
       *
       * 触发不需要攻击:`stat()` 成功之后、流 open 之前文件消失就够 —— agent 在
       * 回合里重写产出文件、checkpoint 回滚、EIO,都会命中。一个用户点一次下载,
       * 所有人的会话、终端、定时任务一起没。
       *
       * 写法与 assets.routes.ts / files.routes.ts 的下载口一致。
       */
      const fileStream = fs.createReadStream(resolved);
      fileStream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      return fileStream.pipe(res);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
      return res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * ## 交给浏览器自己下:签票 + 直传
   *
   * 上面那条 `output` 是页面自己 fetch 用的:整份字节先进内存拼成 blob,没有进度条、
   * 切页就断。想让浏览器自己下就得让它**导航**过去,而一次普通导航设不了
   * `Authorization` 头 —— 于是走短命票据。与项目文件那对完全同形,理由见
   * `server/shared/download-tickets.js`。
   *
   * 关键一条:**票不是授权,只是身份**。直传口拿票里的 viewer 把上面那三道闸
   * (可见性 → 写入集合 → 文件存在)**原样重跑一遍**。会话可能在这 5 分钟里被删,
   * 产出文件可能被 agent 重写掉。
   */

  /** POST /api/providers/sessions/:sessionId/output-download-ticket  body: { path } */
  router.post('/sessions/:sessionId/output-download-ticket', authenticateToken, async (req, res) => {
    const sessionId = String(req.params.sessionId || '');
    const requested = typeof (req.body as { path?: unknown })?.path === 'string'
      ? String((req.body as { path: string }).path)
      : '';
    if (!sessionId || !requested) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const viewer = readRequestViewer(req);
    const gate = await checkSessionOutputAccess(sessionId, viewer, requested);
    if ('status' in gate) {
      return res.status(gate.status).json({ error: gate.error });
    }

    const ticket = issueSessionOutputTicket({ viewer, sessionId, filePath: gate.resolved });
    return res.json({
      kind: 'file',
      name: path.basename(gate.resolved),
      size: gate.size,
      url: `/api/downloads/session-output?ticket=${ticket}`,
    });
  });

  return router;
}

/**
 * 会话产出的**直传**路由:`/api/downloads/session-output`。
 *
 * 与项目文件那对同形,单独成一个**不接受 `authenticateToken`** 的工厂 ——
 * 不带登录态的接口面全部收在 `/api/downloads` 这一个前缀下,审计时一眼能数清。
 */
export function createSessionOutputDownloadRouter(): Router {
  const router = express.Router();

  /** GET /api/downloads/session-output?ticket=… */
  router.get('/session-output', async (req, res) => {
    const payload = readDownloadTicket(req.query.ticket as string, 'session-output');
    if (!payload) {
      return res.status(401).json({ error: '下载链接已过期,请重新点一次下载。' });
    }

    const gate = await checkSessionOutputAccess(payload.sessionId, payload.viewer, payload.filePath);
    if ('status' in gate) {
      return res.status(gate.status).json({ error: gate.error });
    }

    // 这条口**永远是附件** —— 上面那条口要服务媒体预览所以有 inline 白名单,
    // 这条口的存在理由就是"存到硬盘"。
    setDownloadHeaders(res, {
      fileName: path.basename(gate.resolved),
      size: gate.size,
      mimeType: mime.lookup(gate.resolved) || 'application/octet-stream',
    });

    const fileStream = fs.createReadStream(gate.resolved);
    fileStream.on('error', (error) => {
      log.error('[SessionOutput] 直传失败:', error);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    return fileStream.pipe(res);
  });

  return router;
}

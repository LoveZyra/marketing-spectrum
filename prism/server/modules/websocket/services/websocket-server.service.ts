import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';
import { userDb } from '@/modules/database/index.js';
const log = createLogger('ws');

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[2];
  /**
   * /jupyter/* 的升级请求整个让给 jupyter 反代(cookie 鉴权 + TCP 隧道),
   * 不走下面的 Prism 票据/JWT 校验。不注入时该前缀的升级一律拒绝。
   */
  jupyterUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
};

/**
 * Creates and wires the server-wide websocket gateway: `/ws` (chat) and `/shell`,
 * with `/jupyter/*` upgrades handed to the injected tunnel.
 *
 * 用 noServer 模式 + 自己的 upgrade 路由:ws 的 {server} 模式会接管 HTTP 服务器上
 * 所有的升级请求,/jupyter 的 kernel WebSocket 会先被它的 verifyClient 拒掉。
 * /jupyter 前缀交给注入的隧道,其余路径走 verifyClient → handleUpgrade,
 * 行为与 {server} 模式一致。
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  // maxPayload:ws 库默认单帧上限是 100MiB —— 任何一个已登录 socket 发一帧就能
  // 造成 JSON.parse 的内存/CPU 尖峰。聊天入站帧(文本+图片引用+审批应答)远小于
  // 4MiB;真正的大文件走 HTTP 分片上传通道,不走 WS。超限帧由 ws 以 1009 关闭。
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/jupyter' || pathname.startsWith('/jupyter/')) {
      if (dependencies.jupyterUpgrade) {
        dependencies.jupyterUpgrade(request, socket, head);
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    const info = {
      origin: String(request.headers.origin ?? ''),
      secure: false,
      req: request as AuthenticatedWebSocketRequest,
    };
    if (!verifyWebSocketClient(info, dependencies.verifyClient)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    // Keep WebSocket alive across reverse-proxy idle timeouts (Cloudflare ~100s,
    // AWS ALB 60s, nginx 60s, etc.) and detect half-open / zombie sockets where
    // TCP still appears up but the peer has stopped responding. Uses the ws
    // library standard heartbeat: mark alive on each pong, and terminate any
    // connection that did not pong since the previous ping. Terminating forces
    // the frontend to reconnect instead of silently sending prompts into a dead
    // socket.
    const heartbeatState = { isAlive: true };
    ws.on('pong', () => {
      heartbeatState.isAlive = true;
    });
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      if (heartbeatState.isAlive === false) {
        ws.terminate();
        return;
      }
      /**
       * 顺带复检身份:吊销 / 停用 / 删除要真的把人踢下线。
       *
       * 握手时盖在 socket 上的 `prismUserId` 之后一直有效,而 `canViewerSeeSession` 只按它比对
       * 项目 owner,用户行没了也照样匹配;不复检的话,账号被停用后只要标签页没关,连接就一直能发指令。
       *
       * 放在心跳 interval 里:30 秒一次、每连接一次主键查询,成本可忽略。
       */
      const viewerId = (ws as { prismUserId?: string | number | null }).prismUserId;
      if (viewerId !== null && viewerId !== undefined) {
        const stillValid = userDb.getUserById(Number(viewerId));
        if (!stillValid) {
          log.info('[ws] 账号已不存在/已停用,断开这条连接');
          ws.close(4401, 'account revoked');
          return;
        }
        /**
         * 还要比对 `token_version`:「退出所有设备」/ 改密码是旋转 token_version,
         * 用户行一直都在,只查用户行挡不住这类最常见的撤销。
         *
         * 握手时盖的版本号(prismTokenVersion)与当前值不一致 = 这条连接背后的
         * 凭据已经被吊销,断开它,让前端拿新票据重连(拿不到就是真的登出了)。
         */
        const stampedVersion = (ws as { prismTokenVersion?: number | null }).prismTokenVersion;
        if (
          stampedVersion !== null && stampedVersion !== undefined
          && Number(stillValid.token_version ?? 0) !== Number(stampedVersion)
        ) {
          log.info('[ws] 凭据已被吊销(token_version 已旋转),断开这条连接');
          ws.close(4401, 'credentials revoked');
          return;
        }
      }
      heartbeatState.isAlive = false;
      try {
        ws.ping();
      } catch {
        // socket may have been closed concurrently — interval will be cleared below
      }
    }, HEARTBEAT_INTERVAL_MS);
    const stopHeartbeat = () => clearInterval(heartbeat);
    ws.on('close', stopHeartbeat);
    ws.on('error', stopHeartbeat);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, incomingRequest, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    log.warn('Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}

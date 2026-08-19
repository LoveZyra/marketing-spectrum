import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

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
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 *
 * noServer 模式 + 自己的 upgrade 路由:ws 的 {server} 模式会接管 HTTP 服务器上
 * 【所有】升级请求,/jupyter 的 kernel WebSocket 会被它的 verifyClient 先拒掉。
 * 改为手动分发:/jupyter 前缀交给注入的隧道,其余路径保持原有的
 * verifyClient → handleUpgrade 语义,行为与 {server} 模式一致。
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

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
    // the frontend to reconnect, so messages no longer vanish into a dead
    // socket — the prior ping-only heartbeat left such zombies lingering, which
    // caused prompts to be silently dropped with no backend activity.
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

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}

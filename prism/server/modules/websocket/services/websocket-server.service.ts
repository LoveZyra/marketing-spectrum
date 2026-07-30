import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
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
      handleShellConnection(ws, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}

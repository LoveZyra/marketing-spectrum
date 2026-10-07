import { buildAuthenticatedWebSocketUrl } from '../../../utils/ws-auth';
import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';

/**
 * URL for the terminal websocket, or `null` when it cannot be built right now.
 *
 * Async because the credential is a single-use ticket fetched per attempt —
 * see `buildAuthenticatedWebSocketUrl`, which documents why the old
 * `?token=<jwt>` form is gone and why the result must not be cached.
 */
export function getShellWebSocketUrl(): Promise<string | null> {
  return buildAuthenticatedWebSocketUrl('/shell');
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * 主动关掉一条终端 socket,关之前先摘掉它的回调。
 *
 * close() 只是发起关闭握手,onclose 要一个往返之后才到。那时下一次连接往往已经开始,
 * 旧回调再来复位「连接中」标志,自动连接就会再开一条,前一条成了没人持有的孤儿。
 * 回调摘掉之后,连接状态由调用方自己同步复位。
 */
export function detachAndCloseSocket(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
}
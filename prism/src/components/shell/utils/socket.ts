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
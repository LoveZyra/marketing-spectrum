import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { buildAuthenticatedWebSocketUrl } from '../utils/ws-auth';

import {
  HEARTBEAT_PING_AFTER_MS,
  HEARTBEAT_RECONNECT_AFTER_MS,
  HEARTBEAT_TICK_MS,
  heartbeatAction,
  monotonicNow,
  nextReconnectDelay,
} from './websocket-lifecycle';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  /**
   * Sends a frame, reporting whether it actually went out.
   *
   * The return value is the whole point: this used to return void and log a
   * warning when the socket was closed, so a message composed during a
   * reconnect vanished with no trace anywhere the user could see. Callers are
   * expected to branch on it and keep the draft.
   */
  sendMessage: (message: unknown) => boolean;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

/**
 * The connection itself. Its value changes only when the socket opens or
 * closes — `sendMessage` and `subscribe` are stable for the provider's whole
 * life.
 */
const WebSocketContext = createContext<WebSocketContextType | null>(null);

/**
 * The most recent frame, in a context of its own.
 *
 * Separate because it changes on *every* frame. While these lived in one
 * context value, a streaming assistant response re-rendered every consumer of
 * `useWebSocket()` — including the ones that only ever call `sendMessage` —
 * hundreds of times per response. Splitting the contexts means a component
 * that does not read the latest frame does not re-render for it.
 */
const LatestServerEventContext = createContext<ServerEvent | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/**
 * Subscribes a component to the most recent websocket frame.
 *
 * Only for low-frequency consumers (TaskMaster broadcasts). High-rate chat
 * streams must use `subscribe` from `useWebSocket`: React batches state
 * updates, so consecutive frames can overwrite each other here before anything
 * renders, which makes this API lossy under load by construction.
 */
export const useLatestServerEvent = () => useContext(LatestServerEventContext);


const useWebSocketProviderState = () => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Consecutive failed attempts; reset on a successful open. */
  const reconnectAttemptsRef = useRef(0);
  /**
   * Monotonic timestamp of the last inbound frame — the only evidence a socket
   * is alive. Read with `monotonicNow`, never `Date.now`: the wall clock steps
   * backwards on resume-from-suspend, which is precisely the moment this
   * measurement has to be trustworthy.
   */
  const lastFrameAtRef = useRef(monotonicNow());
  /**
   * Generation counter for connection attempts.
   *
   * Obtaining a websocket ticket is an async round-trip, so between requesting
   * one and calling `new WebSocket(...)` the effect can re-run (a token
   * refresh) or the provider can unmount. An attempt whose generation is no
   * longer current must abandon itself rather than publish its socket, or a
   * superseded attempt overwrites the live one and leaves an orphan nothing
   * will ever close.
   */
  const attemptRef = useRef(0);
  const { token } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  /**
   * Held in a ref so the reconnect timer and the heartbeat can call the current
   * `connect` without either of them being a dependency of it — a cycle that
   * would otherwise force the effect to re-run, and so tear down and rebuild a
   * healthy socket, on every render.
   */
  const connectRef = useRef<() => Promise<void>>(async () => {});

  /**
   * Queues the next attempt on the shared backoff.
   *
   * Every failure path routes through here — a refused ticket, a constructor
   * throw, a closed socket — so the attempt counter advances once per failure
   * regardless of which one it was.
   */
  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    const delay = nextReconnectDelay(reconnectAttemptsRef.current);
    reconnectAttemptsRef.current += 1;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    reconnectTimeoutRef.current = setTimeout(() => {
      if (unmountedRef.current) return;
      void connectRef.current();
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    // Read here rather than only inside the URL builder so this callback truly
    // depends on the token: logging in or refreshing must rebuild the socket,
    // and the dependency list below is what drives that. Bailing out early also
    // avoids a pointless ticket request on every render before login.
    if (!token) return console.warn('No authentication token yet; deferring WebSocket connection');

    const generation = ++attemptRef.current;
    try {
      // A *fresh* ticket per attempt: they are single-use and expire in 60s, so
      // reusing one across reconnects is a guaranteed rejected upgrade.
      const wsUrl = await buildAuthenticatedWebSocketUrl('/ws');

      // Superseded or unmounted while the ticket request was in flight. The
      // ticket simply goes unredeemed and expires.
      if (unmountedRef.current || generation !== attemptRef.current) return;

      if (!wsUrl) {
        // "Not now", not "never" — the ticket endpoint can fail transiently.
        // Without this retry one blip would strand the client offline until a
        // manual reload, which is exactly how the old code behaved.
        scheduleReconnect();
        return;
      }

      const websocket = new WebSocket(wsUrl);
      // Published while still CONNECTING, not in onopen: unmount closes
      // whatever is in this ref, and a socket that was mid-handshake used to
      // be invisible to that cleanup. It would then open against an unmounted
      // provider, leaving a live socket nothing would ever close. Every reader
      // of the ref already checks `readyState === OPEN`.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        lastFrameAtRef.current = monotonicNow();
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages.
          // Wall clock here on purpose: this one is displayed, not measured against.
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        // Recorded before parsing: a frame we could not parse is still proof
        // the peer is alive, and treating it as silence would tear down a
        // working socket over one malformed message.
        lastFrameAtRef.current = monotonicNow();
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          // The heartbeat reply carries no information beyond having arrived,
          // which onmessage has already recorded.
          if (data?.type === 'pong') return;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        setIsConnected(false);
        // Only clear the shared ref if this socket is still the current one. A
        // stale socket closing after the heartbeat replaced it would otherwise
        // null out its live successor and make sendMessage report failure.
        if (wsRef.current === websocket) {
          wsRef.current = null;
        }

        scheduleReconnect();
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
      // Without this the socket constructor throwing (a malformed URL, a
      // blocked mixed-content upgrade) would leave no socket and no pending
      // retry, so the client would stay offline until a manual reload.
      scheduleReconnect();
    }
  }, [token, dispatch, scheduleReconnect]); // everytime token changes, we reconnect

  connectRef.current = connect;

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    reconnectAttemptsRef.current = 0;
    void connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  useEffect(() => {
    const timer = setInterval(() => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        // A socket that is closing or already closed has its own reconnect
        // scheduled by onclose; nothing to probe.
        return;
      }

      const action = heartbeatAction(monotonicNow(), lastFrameAtRef.current, {
        pingAfterMs: HEARTBEAT_PING_AFTER_MS,
        reconnectAfterMs: HEARTBEAT_RECONNECT_AFTER_MS,
      });

      if (action === 'ping') {
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Send failing on a socket that claims to be OPEN is itself proof it
          // is not; let the next tick reach the reconnect threshold.
        }
        return;
      }

      if (action === 'reconnect') {
        // close() rather than a direct reconnect: it runs the same onclose path
        // as a genuine drop, so the backoff, the `isConnected` flag and the
        // `websocket_reconnected` replay signal all stay in one place.
        wsRef.current = null;
        socket.close();
      }
    }, HEARTBEAT_TICK_MS);

    return () => clearInterval(timer);
  }, []);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected; message not sent');
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Failed to send WebSocket message:', error);
      return false;
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const connection: WebSocketContextType = useMemo(
    () => ({ sendMessage, subscribe, isConnected }),
    [sendMessage, subscribe, isConnected],
  );

  return { connection, latestMessage };
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const { connection, latestMessage } = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={connection}>
      <LatestServerEventContext.Provider value={latestMessage}>
        {children}
      </LatestServerEventContext.Provider>
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;

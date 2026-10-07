import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { readChatPermissionMode } from '../utils/permissionMode';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  takeoverRef: MutableRefObject<boolean>;
  /** 多标签时每个终端一个 id;不传就是单终端。 */
  terminalIdRef?: MutableRefObject<string | null>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  /** 由这里填入复位函数,closeSocket 关掉 socket 后同步调用(见 useShellRuntime)。 */
  resetConnectionRef?: MutableRefObject<(() => void) | null>;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  takeoverRef,
  terminalIdRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  resetConnectionRef,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  // 重连退避:连不上时(拿不到票据 / 建连抛错)自动重连不能零间隔,否则
  // autoConnect effect 会因 isConnecting 复位而立刻重跑,对票据接口形成紧密轮询
  // (ws-auth 要求调用方自带退避)。失败翻倍、成功清零,上限 30s。
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(0);
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

    },
    [handleProcessCompletion, onOutputRef, terminalRef],
  );

  /**
   * 组件是否已经卸载。
   *
   * `connectWebSocket` 在 `new WebSocket()` 之前有一次 await(取一次性票据,
   * 一个网络往返)。用户在这几百毫秒里切走页签的话:effect 的清理函数跑完了
   * (那时 `wsRef.current` 还是 null,没什么可关的),await 才落地,然后照样
   * `new WebSocket(...)` —— 开出来的这条连接没有任何人持有引用,清理函数
   * 已经错过了它,`closeSocket` 也找不到它。它会一直连着,直到服务端心跳判死。
   *
   * 取票期间连接作废(断开、重新发起)是同一族问题,由下面的 `attemptRef` 挡。
   *
   * 判据放 ref 而不是 state:清理函数要能立刻改它,而 state 更新是异步的。
   */
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  /**
   * 连接代号。每次发起连接加一,主动断开、主动关掉 socket 时也加一。
   *
   * 取票是一次网络往返,票回来时代号已经变了,说明这次连接已经作废(用户断开了,
   * 或者已经发起了新的一次),不能再拿它开连接,否则就多出一条没人持有的 socket。
   * 作废的那次也不碰「连接中」标志,那个标志归现在这一次管。
   */
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!resetConnectionRef) {
      return undefined;
    }

    resetConnectionRef.current = () => {
      attemptRef.current += 1;
      setIsConnected(false);
      setIsConnecting(false);
      connectingRef.current = false;
    };
    return () => {
      resetConnectionRef.current = null;
    };
  }, [resetConnectionRef]);

  const connectWebSocket = useCallback(
    async (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      // Claimed before the await, not after: obtaining the websocket ticket is
      // an async round-trip, and without the flag set up front a second call
      // arriving during it would see an idle hook and open a rival socket.
      connectingRef.current = true;
      attemptRef.current += 1;
      const attempt = attemptRef.current;

      try {
        // Fetched per attempt — the ticket is single-use and expires in 60s.
        const wsUrl = await getShellWebSocketUrl();
        // 取票期间卸载了:别开这条连接。开出来就没人持有它了(见 unmountedRef)。
        // 票据是一次性的,不用它自己会在 60 秒后过期,不需要额外归还。
        if (unmountedRef.current) {
          connectingRef.current = false;
          return;
        }
        // 取票期间这次连接已经作废(见 attemptRef),状态也不归它管。
        if (attempt !== attemptRef.current) {
          return;
        }
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          // 拿不到票据也是一次失败,抬高退避,别让 effect 立刻重扑上来。
          reconnectDelayRef.current = Math.min(
            reconnectDelayRef.current ? reconnectDelayRef.current * 2 : RECONNECT_BASE_MS,
            RECONNECT_MAX_MS,
          );
          return;
        }

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        // 每个回调先确认自己还是当前 socket:已被换下的 socket 晚到的回调不能动
        // 下一次连接的状态,也不能往终端里写东西。
        socket.onopen = () => {
          if (wsRef.current !== socket) {
            socket.close();
            return;
          }
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          // 连上了 → 退避清零。
          reconnectDelayRef.current = 0;

          // 断线时不再清屏(见 onclose),本地滚屏一直留着;真正重连成功、
          // 即将收到服务端回放的这一刻才清一次,让回放落在干净屏上、不与旧内容
          // 叠成重复的尾巴。
          clearTerminalScreen();

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              takeover: takeoverRef.current,
              // 接管时带上这段对话在 chat 里的权限档位(见 ShellInitMessage.permissionMode)。
              ...(takeoverRef.current
                ? { permissionMode: readChatPermissionMode(selectedSessionRef.current?.id) }
                : {}),
              // 多标签时每个终端一个 id,服务端据此各给一个 PTY。
              terminalId: terminalIdRef?.current ?? undefined,
              forceRestart,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (wsRef.current !== socket) {
            return;
          }
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (wsRef.current !== socket) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          // 断线不清屏:意外掉线时本地滚屏应该留在眼前(冻住),而不是瞬间
          // 被抹白只能等服务端回放捞回一小段。清屏改到重连成功的 onopen 里做。
          // 主动断开(disconnectFromShell)仍会清 —— 那是用户自己要走。
        };

        socket.onerror = () => {
          if (wsRef.current !== socket) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          // 建连失败按一次失败计:抬高下次退避。
          reconnectDelayRef.current = Math.min(
            reconnectDelayRef.current ? reconnectDelayRef.current * 2 : RECONNECT_BASE_MS,
            RECONNECT_MAX_MS,
          );
        };
      } catch {
        if (attempt !== attemptRef.current) {
          return;
        }
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current ? reconnectDelayRef.current * 2 : RECONNECT_BASE_MS,
          RECONNECT_MAX_MS,
        );
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      takeoverRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalIdRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    void connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectDelayRef.current = 0;
    // 还在取票的那次连接随之作废(socket 还没开出来,closeSocket 管不到它)。
    attemptRef.current += 1;

    closeSocket();
    // 主动断开才清屏(用户点了断开/切走)。
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected ||
      connectingRef.current ||
      reconnectTimerRef.current
    ) {
      return;
    }

    // 带退避地重连:首次(delay=0)立刻连,之后每次失败翻倍。timer 在手期间
    // effect 不再另起一个(上面的 reconnectTimerRef 守卫)。
    const delay = reconnectDelayRef.current;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectToShell();
    }, delay);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { UseShellRuntimeOptions, UseShellRuntimeResult } from '../types/types';

import { useShellConnection } from './useShellConnection';
import { useShellTerminal } from './useShellTerminal';

export function useShellRuntime({
  selectedProject,
  selectedSession,
  initialCommand,
  isPlainShell,
  minimal,
  autoConnect,
  isRestarting,
  onProcessComplete,
  onOutputRef,
  terminalId = null,
}: UseShellRuntimeOptions): UseShellRuntimeResult {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef(onProcessComplete);
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  /**
   * 是否在终端里接管当前会话。默认 false —— Shell 面板现在默认是普通终端。
   * 用 ref 而不是 state 传给 socket 处理器,和这里其它可变值的做法一致:处理器
   * 是长期存活的闭包,读 state 会读到建立连接那一刻的旧值。
   */
  const takeoverRef = useRef(false);
  /** F10:多标签时每个终端一个 id,服务端据此各给一个 PTY。 */
  const terminalIdRef = useRef<string | null>(terminalId);
  const [isTakenOver, setIsTakenOver] = useState(false);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    onProcessCompleteRef.current = onProcessComplete;
  }, [selectedProject, selectedSession, initialCommand, isPlainShell, onProcessComplete]);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    closeSocket,
  });

  const { isConnected, isConnecting, connectToShell, disconnectFromShell } = useShellConnection({
    wsRef,
    takeoverRef,
    terminalIdRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    isInitialized,
    autoConnect,
    closeSocket,
    clearTerminalScreen,
    onOutputRef,
  });

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, selectedProject]);

  useEffect(() => {
    const currentSessionId = selectedSession?.id ?? null;
    if (lastSessionIdRef.current !== currentSessionId && isInitialized) {
      disconnectFromShell();
    }

    lastSessionIdRef.current = currentSessionId;
  }, [disconnectFromShell, isInitialized, selectedSession?.id]);

  /**
   * 在终端里接管当前对话。
   *
   * 需要重连:接管与否是在 `init` 那一刻决定命令行的(普通 shell 还是
   * `claude --resume`),连上之后改不了。所以这里断开再连,让服务端按新标志
   * 重新起进程 —— 顺带它会先释放 chat 侧的常驻运行时。
   */
  const takeOverConversation = useCallback(() => {
    takeoverRef.current = true;
    setIsTakenOver(true);
    disconnectFromShell();
    // 让上面的断开先落定,再发起新连接。
    setTimeout(() => connectToShell(), 0);
  }, [connectToShell, disconnectFromShell]);

  return {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    connectToShell,
    disconnectFromShell,
    isTakenOver,
    takeOverConversation,
  };
}

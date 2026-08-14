import { RotateCcw, TerminalSquare, X } from 'lucide-react';

type ShellHeaderProps = {
  isConnected: boolean;
  isInitialized: boolean;
  isRestarting: boolean;
  hasSession: boolean;
  sessionDisplayNameShort: string | null;
  onDisconnect: () => void;
  onRestart: () => void;
  statusNewSessionText: string;
  statusInitializingText: string;
  statusRestartingText: string;
  disconnectLabel: string;
  disconnectTitle: string;
  restartLabel: string;
  restartTitle: string;
  disableRestart: boolean;
  /** 终端是否已接管当前对话。 */
  isTakenOver: boolean;
  /** 点击后在终端里接管当前对话;为 null 时不显示入口。 */
  onTakeOver: (() => void) | null;
  takeOverLabel: string;
  takeOverTitle: string;
  takenOverLabel: string;
};

export default function ShellHeader({
  isConnected,
  isInitialized,
  isRestarting,
  hasSession,
  sessionDisplayNameShort,
  onDisconnect,
  onRestart,
  statusNewSessionText,
  statusInitializingText,
  statusRestartingText,
  disconnectLabel,
  disconnectTitle,
  restartLabel,
  restartTitle,
  disableRestart,
  isTakenOver,
  onTakeOver,
  takeOverLabel,
  takeOverTitle,
  takenOverLabel,
}: ShellHeaderProps) {
  return (
    <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />

          {hasSession && sessionDisplayNameShort && (
            <span className="text-xs text-blue-300">({sessionDisplayNameShort}...)</span>
          )}

          {!hasSession && <span className="text-xs text-gray-400">{statusNewSessionText}</span>}

          {!isInitialized && <span className="text-xs text-yellow-400">{statusInitializingText}</span>}

          {isRestarting && <span className="text-xs text-blue-400">{statusRestartingText}</span>}

          {isTakenOver && <span className="text-xs text-emerald-400">{takenOverLabel}</span>}
        </div>

        <div className="flex items-center gap-2">
          {/* 接管入口。Shell 默认是普通终端 —— 想在这里继续对话是个明确的动作,
              因为它要把 chat 侧的运行时收走,两边不能同时持有同一段对话。 */}
          {hasSession && !isTakenOver && onTakeOver && (
            <button
              type="button"
              onClick={onTakeOver}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-600/80 bg-gray-700/70 px-3 text-xs font-medium text-gray-100 transition-colors hover:border-emerald-400/70 hover:bg-emerald-600/80 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400/70 focus:ring-offset-2 focus:ring-offset-gray-800"
              title={takeOverTitle}
            >
              <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{takeOverLabel}</span>
            </button>
          )}

          {isConnected && (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-400/70 focus:ring-offset-2 focus:ring-offset-gray-800"
              title={disconnectTitle}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{disconnectLabel}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRestart}
            disabled={disableRestart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-600/80 bg-gray-700/70 px-3 text-xs font-medium text-gray-100 transition-colors hover:border-blue-400/70 hover:bg-blue-600/80 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400/70 focus:ring-offset-2 focus:ring-offset-gray-800 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-gray-500 disabled:opacity-60"
            title={restartTitle}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${isRestarting ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{restartLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

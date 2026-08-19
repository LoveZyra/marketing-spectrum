import { useCallback, useEffect, useRef, useState } from 'react';
import { NotebookPen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../utils/api';

export type JupyterOpenTarget = {
  /** 要深链的绝对路径(null = 打开 lab 根)。 */
  path: string | null;
  /** 单调递增;变化才触发重新定位 —— 相同文件连点两次也要重新聚焦。 */
  nonce: number;
};

type JupyterPanelProps = {
  target: JupyterOpenTarget;
};

type PanelState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; url: string }
  | { phase: 'failed'; reason: string; detail: string };

type SessionPayload = {
  data?: { ready?: boolean; url?: string; reason?: string; detail?: string };
  error?: string;
};

/**
 * notebook 标签页 = Prism 托管的 JupyterLab,通过 /jupyter 反代装进 iframe。
 * 首次进入才拉起 lab(服务端惰性启动,冷启动可能要几十秒);之后 MainContent
 * 用 CSS 隐藏而不卸载,切标签页不重载 lab、kernel 不断。
 */
export default function JupyterPanel({ target }: JupyterPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PanelState>({ phase: 'idle' });
  const requestSeq = useRef(0);

  const openSession = useCallback(async (path: string | null) => {
    const seq = ++requestSeq.current;
    setState({ phase: 'starting' });
    try {
      const response = await api.jupyterSession(path ?? undefined);
      const payload = (await response.json()) as SessionPayload;
      if (requestSeq.current !== seq) return; // 已被更新的请求取代
      if (!response.ok) {
        setState({ phase: 'failed', reason: 'request_failed', detail: payload.error ?? `HTTP ${response.status}` });
        return;
      }
      if (payload.data?.ready && payload.data.url) {
        setState({ phase: 'ready', url: payload.data.url });
        return;
      }
      setState({
        phase: 'failed',
        reason: payload.data?.reason ?? 'start_failed',
        detail: payload.data?.detail ?? 'unknown',
      });
    } catch (error) {
      if (requestSeq.current !== seq) return;
      setState({ phase: 'failed', reason: 'request_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // 挂载时打开 lab;之后每次 target.nonce 变化(「在 JupyterLab 打开」)重新定位。
  useEffect(() => {
    void openSession(target.path);
    // nonce 是唯一有效的触发器 —— path 相同也要重新聚焦。
  }, [target.nonce, openSession]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.phase === 'ready') {
    return (
      <iframe
        src={state.url}
        title="JupyterLab"
        className="h-full w-full border-0 bg-background"
      />
    );
  }

  if (state.phase === 'failed') {
    const isNotInstalled = state.reason === 'not_installed';
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg space-y-3 text-center">
          <NotebookPen className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">
            {isNotInstalled
              ? t('jupyter.notInstalled', { defaultValue: '服务器上没有找到 JupyterLab' })
              : t('jupyter.startFailed', { defaultValue: 'JupyterLab 启动失败' })}
          </p>
          {isNotInstalled ? (
            <div className="space-y-2 text-left text-xs text-muted-foreground">
              <p>{t('jupyter.installHint', { defaultValue: '在服务器上安装后重试:' })}</p>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono">pip install jupyterlab</pre>
            </div>
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-left font-mono text-xs text-muted-foreground">
              {state.detail}
            </pre>
          )}
          <button
            type="button"
            onClick={() => void openSession(target.path)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('jupyter.retry', { defaultValue: '重试' })}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">
          {t('jupyter.starting', { defaultValue: '正在启动 JupyterLab…首次启动可能需要半分钟' })}
        </p>
      </div>
    </div>
  );
}

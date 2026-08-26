import * as React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

import { cn } from '../../../lib/utils';

import {
  emitToast,
  subscribeToast,
  TOAST_DEFAULT_DURATION,
  ToastContext,
  type ToastContextValue,
  type ToastRecord,
  type ToastVariant,
} from './toastBus';

/**
 * 轻量全站提示(toast)的视图层。内核(总线 / 类型 / context / useToast)在
 * `toastBus.ts` —— 分开是为了让本文件只导出组件(ToastProvider),满足
 * react-refresh。触发方设计见 toastBus.ts。
 *
 * 存在的理由:全站错误出口原先三分(window.alert / 各自 setError / 只 console),
 * 同类失败在不同页面体验割裂、很多"点了没反应"。这里给一个统一通道。
 */

const VARIANT_ICON: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

const VARIANT_ACCENT: Record<ToastVariant, string> = {
  default: 'text-foreground',
  success: 'text-primary',
  error: 'text-destructive',
};

function ToastCard({ record, onDismiss }: { record: ToastRecord; onDismiss: (id: number) => void }) {
  const variant = record.variant ?? 'default';
  const Icon = VARIANT_ICON[variant];

  React.useEffect(() => {
    const duration = record.durationMs ?? TOAST_DEFAULT_DURATION[variant];
    if (!duration || duration <= 0) return;
    const timer = window.setTimeout(() => onDismiss(record.id), duration);
    return () => window.clearTimeout(timer);
  }, [record.id, record.durationMs, variant, onDismiss]);

  return (
    <div
      role="status"
      className="prism-panel pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border border-border bg-popover px-3.5 py-3 shadow-lg"
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', VARIANT_ACCENT[variant])} />
      <div className="min-w-0 flex-1">
        <div className="break-words text-[13px] font-medium leading-5 text-foreground">{record.message}</div>
        {record.description ? (
          <div className="mt-0.5 break-words text-[12px] leading-5 text-muted-foreground">{record.description}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(record.id)}
        className="ml-1 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const MAX_VISIBLE_TOASTS = 4;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);

  const dismiss = React.useCallback((id: number) => {
    setToasts((previous) => previous.filter((t) => t.id !== id));
  }, []);

  const push = React.useCallback((record: ToastRecord) => {
    setToasts((previous) => {
      const next = [...previous, record];
      // 只保留最近 N 条,老的挤掉,避免堆屏。
      return next.length > MAX_VISIBLE_TOASTS ? next.slice(next.length - MAX_VISIBLE_TOASTS) : next;
    });
  }, []);

  React.useEffect(() => subscribeToast(push), [push]);

  const value = React.useMemo<ToastContextValue>(
    () => ({ toast: (options) => emitToast(options), dismiss }),
    [dismiss],
  );

  const viewport =
    typeof document !== 'undefined'
      ? createPortal(
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[10000] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end">
            <div className="flex w-full max-w-sm flex-col gap-2">
              {toasts.map((record) => (
                <ToastCard key={record.id} record={record} onDismiss={dismiss} />
              ))}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {viewport}
    </ToastContext.Provider>
  );
}

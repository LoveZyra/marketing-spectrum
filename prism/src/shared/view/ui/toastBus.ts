import * as React from 'react';

/**
 * Toast 的非组件内核:事件总线 + 类型 + context + useToast 钩子。
 *
 * 单独成一个 `.ts`(不含组件)是为了让 `Toast.tsx` 只导出 `ToastProvider` 一个组件,
 * 满足 react-refresh 的 only-export-components(组件文件里混着导出函数会触发它)。
 *
 * 总线的意义见 Toast.tsx 顶部注释:提示的触发方不都是 React 组件(如 api.js 的 401
 * 拦截),所以用 module 级 pub/sub,组件走 useToast,非组件直接 emitToast。
 */

export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastOptions {
  message: string;
  description?: string;
  variant?: ToastVariant;
  /** 毫秒;不传按 variant 取默认(error 更久)。0 = 不自动消失。 */
  durationMs?: number;
}

export interface ToastRecord extends ToastOptions {
  id: number;
}

type ToastListener = (toast: ToastRecord) => void;

let nextToastId = 1;
const listeners = new Set<ToastListener>();
// Provider 挂载前(极少数早期路径)攒着,挂载后立刻补发,避免"最早那条提示丢了"。
const pending: ToastRecord[] = [];

/** 从任意地方(含非 React 模块)弹一条提示。返回该条 id。 */
export function emitToast(options: ToastOptions): number {
  const record: ToastRecord = { id: nextToastId++, variant: 'default', ...options };
  if (listeners.size === 0) {
    pending.push(record);
  } else {
    for (const listener of listeners) listener(record);
  }
  return record.id;
}

export function subscribeToast(listener: ToastListener): () => void {
  listeners.add(listener);
  if (pending.length > 0) {
    const backlog = pending.splice(0, pending.length);
    for (const record of backlog) listener(record);
  }
  return () => {
    listeners.delete(listener);
  };
}

export const TOAST_DEFAULT_DURATION: Record<ToastVariant, number> = {
  default: 4000,
  success: 3000,
  error: 7000,
};

export interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

export const ToastContext = React.createContext<ToastContextValue | null>(null);

/**
 * 组件里用:`const { toast } = useToast(); toast({ message, variant })`。
 * Provider 不在时回退到总线(仍能弹),便于孤立测试/早期渲染。
 */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (ctx) return ctx;
  return {
    toast: (options) => emitToast(options),
    dismiss: () => {},
  };
}

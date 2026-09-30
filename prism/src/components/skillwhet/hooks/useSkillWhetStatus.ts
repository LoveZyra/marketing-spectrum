import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * gy:技能优化整层挂没挂上。
 *
 * 服务端 `PRISM_SKILLWHET_ENABLE` 不配 → 路由不存在 → `/api/skillwhet/status` 404;
 * 轨上那一格与移动端顶部标签都据此不画。答案在一次会话生命周期里不会变
 * (改 `.env` 要重启),所以模块级缓存一次,所有调用者共享同一次请求。
 */
export type SkillWhetStatus = {
  enabled: boolean;
  autostart?: boolean;
  target?: string;
  home?: string;
  checks?: Record<string, boolean>;
  serve?: Record<string, unknown> | null;
  survey?: { rate: number; cooldownMin: number };
};

type CacheState = { status: SkillWhetStatus | null; loaded: boolean; inflight: Promise<SkillWhetStatus> | null };

const cache: CacheState = { status: null, loaded: false, inflight: null };
const listeners = new Set<() => void>();

const notify = () => { for (const fn of listeners) fn(); };

async function fetchStatus(): Promise<SkillWhetStatus> {
  try {
    const response = await authenticatedFetch('/api/skillwhet/status');
    if (response.status === 404) return { enabled: false };
    if (!response.ok) return { enabled: false };
    const body = (await response.json().catch(() => null)) as { data?: SkillWhetStatus } | null;
    return body?.data && typeof body.data === 'object' ? { ...body.data, enabled: body.data.enabled !== false } : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function loadSkillWhetStatus(force = false): Promise<SkillWhetStatus> {
  if (!force && cache.loaded && cache.status) return Promise.resolve(cache.status);
  if (cache.inflight) return cache.inflight;
  cache.inflight = fetchStatus().then((status) => {
    cache.status = status;
    cache.loaded = true;
    cache.inflight = null;
    notify();
    return status;
  });
  return cache.inflight;
}

/** 测试用:清掉缓存。 */
export function resetSkillWhetStatusCache(): void {
  cache.status = null;
  cache.loaded = false;
  cache.inflight = null;
}

export function useSkillWhetStatus(): { status: SkillWhetStatus | null; loaded: boolean; reload: () => Promise<SkillWhetStatus> } {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    if (!cache.loaded) void loadSkillWhetStatus();
    return () => { listeners.delete(listener); };
  }, []);
  return { status: cache.status, loaded: cache.loaded, reload: () => loadSkillWhetStatus(true) };
}

/** 轨位 / 顶部标签用:未知(还没拉到)按"没有"处理,免得先画后消失。 */
export function useSkillWhetEnabled(): boolean {
  const { status } = useSkillWhetStatus();
  return status?.enabled === true;
}

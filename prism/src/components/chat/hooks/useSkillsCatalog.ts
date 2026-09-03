import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { SkillCatalogEntry } from '../utils/skillNaming';

/**
 * 轻量技能目录(do):给"显式技能调用徽标"和会话命名用的 name→description 表。
 *
 * 与命令菜单里那份(useSlashCommands 按 workspacePath 拉)分开:这里刻意
 * **只取系统级 + 插件技能**(不带 workspacePath),因为徽标要在任何项目的
 * 历史消息上都能认出 `/技能名`;模块级缓存 5 分钟,整个应用只打一次接口。
 */
export type { SkillCatalogEntry } from '../utils/skillNaming';
export { matchSkillInvocation } from '../utils/skillNaming';

const CATALOG_TTL_MS = 5 * 60_000;

let cachedCatalog: { at: number; entries: SkillCatalogEntry[] } | null = null;
let inflight: Promise<SkillCatalogEntry[]> | null = null;

/**
 * du:拉不到时**抛**,不再返回 `[]`。
 *
 * 原来失败也返回空数组,调用方无条件把它写进 5 分钟的模块级缓存 —— 一次
 * 瞬时 401/500 就让整个应用的技能徽标与会话命名哑掉五分钟,刷新才恢复。
 * 抛出去以后由 catch 分支静默吞掉(徽标本来就是锦上添花),缓存不被污染,
 * 下一个组件挂载即重试。
 */
async function fetchCatalog(): Promise<SkillCatalogEntry[]> {
  const response = await authenticatedFetch('/api/providers/claude/skills');
  if (!response.ok) throw new Error(`skills catalog HTTP ${response.status}`);
  const payload = (await response.json().catch(() => null)) as {
    data?: { skills?: Array<{ command?: unknown; name?: unknown; description?: unknown }> };
  } | null;
  const skills = payload?.data?.skills;
  // 形状不对当空目录(接口通了但没有技能)—— 这不是失败,可以缓存。
  if (!Array.isArray(skills)) return [];
  return skills
    .map((skill) => ({
      command: typeof skill.command === 'string' ? skill.command : '',
      name: typeof skill.name === 'string' ? skill.name : '',
      description: typeof skill.description === 'string' ? skill.description : '',
    }))
    .filter((skill) => skill.command.startsWith('/') && skill.name);
}

export function useSkillsCatalog(): SkillCatalogEntry[] {
  const [entries, setEntries] = useState<SkillCatalogEntry[]>(cachedCatalog?.entries ?? []);

  useEffect(() => {
    if (cachedCatalog && Date.now() - cachedCatalog.at < CATALOG_TTL_MS) {
      setEntries(cachedCatalog.entries);
      return;
    }
    let cancelled = false;
    (inflight ??= fetchCatalog().finally(() => { inflight = null; }))
      .then((list) => {
        cachedCatalog = { at: Date.now(), entries: list };
        if (!cancelled) setEntries(list);
      })
      .catch(() => { /* 目录拿不到就不出徽标,不该打扰聊天 */ });
    return () => { cancelled = true; };
  }, []);

  return entries;
}

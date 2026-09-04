import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { FancyOption } from '../shared/view/ui/FancySelect';
import { authenticatedFetch } from '../utils/api';

/**
 * 「项目 / 会话 / 模型」三个下拉的**数据源**(ep:从 TasksPage 抽出来)。
 *
 * 与 `FancySelect` 一起构成"定时任务那一套"的完整定义。抽出来是为了别处要用
 * 同一套交互时**用同一段代码**,而不是照着抄一遍 —— 抄出来的第二份会在下一次
 * 改动时悄悄漂开(模型的别名映射尤其容易漂,它有「配置层优先、实测兜底、
 * 过期就不用」三档优先级)。
 */

export type ProjectRow = { path: string; name: string };
export type SessionRow = { sessionId: string; name: string };

/** `/api/projects` → 下拉要的 {path, name}。拿不到就是空数组,不挡表单。 */
export function useProjectRows(): ProjectRow[] {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/projects');
        const payload = await response.json();
        if (cancelled) return;
        const rows = (Array.isArray(payload) ? payload : payload.projects ?? [])
          .map((project: { fullPath?: string; path?: string; displayName?: string; name?: string }) => ({
            path: project.fullPath || project.path || '',
            name: project.displayName || project.name || project.fullPath || project.path || '',
          }))
          .filter((project: ProjectRow) => project.path);
        setProjects(rows);
      } catch { /* 项目下拉缺席时表单里仍可手填/浏览目录 */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return projects;
}

/**
 * 项目下拉的选项。手填/历史留下的路径不在列表里时,插一行进去 ——
 * 否则那个已经选中的项目在下拉里"不存在",触发器上显示不出来。
 */
export function useProjectOptions(projects: ProjectRow[], currentPath: string): FancyOption[] {
  return useMemo(() => {
    const rows: FancyOption[] = projects.map((project) => ({
      value: project.path,
      label: project.name || project.path,
      sublabel: project.path,
    }));
    if (currentPath && !rows.some((row) => row.value === currentPath)) {
      rows.unshift({
        value: currentPath,
        label: currentPath.split('/').filter(Boolean).pop() || currentPath,
        sublabel: currentPath,
      });
    }
    return rows;
  }, [projects, currentPath]);
}

/** 目标会话的数据源:随项目变化拉取(服务端只回这个用户看得见的)。 */
export function useSessionRows(projectPath: string): SessionRow[] {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  useEffect(() => {
    if (!projectPath) { setSessions([]); return undefined; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/tasks/options/sessions?projectPath=${encodeURIComponent(projectPath)}`,
        );
        const payload = await response.json();
        if (!cancelled && response.ok) setSessions((payload.sessions ?? []) as SessionRow[]);
      } catch { /* 拿不到就只剩默认项,不挡保存 */ }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);
  return sessions;
}

/**
 * 会话下拉的选项。第一项由调用方给(定时任务是「自动新建一个并固定」)——
 * 各处语义可以不同,但下面那串会话是同一份。
 */
export function useSessionOptions(
  sessions: SessionRow[],
  currentSessionId: string,
  firstOptionLabel: string,
): FancyOption[] {
  return useMemo(() => {
    const rows: FancyOption[] = [{ value: '', label: firstOptionLabel }];
    if (currentSessionId && !sessions.some((session) => session.sessionId === currentSessionId)) {
      rows.push({ value: currentSessionId, label: currentSessionId.slice(0, 8), sublabel: currentSessionId });
    }
    return rows.concat(sessions.map((session) => ({
      value: session.sessionId, label: session.name, sublabel: session.sessionId,
    })));
  }, [sessions, currentSessionId, firstOptionLabel]);
}

/**
 * 模型目录与聊天输入框同源(`/api/providers/claude/models`),外加**别名→实际
 * 模型**的映射(`/model-mappings`)—— 与聊天的模型 chip 同一套口径:
 * 用户关心"现在到底是谁在答",所以**主行写实际模型名**(claude-sonnet-5、
 * deepseek-v4-flash…),别名(sonnet/opus…)与档位说明退到副行。
 * 映射优先级同 ChatInterface:配置层 > 新鲜实测 > 没有(退回显示别名)。
 * 两个接口任一缺席都不挡表单。
 */
export function useModelCatalog(): { models: FancyOption[]; defaultModelReal: string | null } {
  const [models, setModels] = useState<FancyOption[]>([]);
  const [defaultModelReal, setDefaultModelReal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalog, mappingData] = await Promise.all([
        authenticatedFetch('/api/providers/claude/models')
          .then((response) => response.json()).catch(() => null),
        authenticatedFetch('/api/providers/claude/model-mappings')
          .then((response) => response.json()).catch(() => null),
      ]);
      if (cancelled) return;

      const options = catalog?.data?.models?.OPTIONS;
      if (!Array.isArray(options)) return;

      const stale = mappingData?.data?.stale === true;
      const probed = (mappingData?.data?.mappings ?? {}) as Record<string, { actualModel?: string | null }>;
      const configured = (mappingData?.data?.configMappings ?? {}) as Record<string, { configuredModel?: string | null }>;
      const realOf = (alias: string): string | null =>
        configured[alias]?.configuredModel ?? (stale ? null : probed[alias]?.actualModel ?? null);

      setModels(options
        .map((option: { value?: unknown; label?: unknown }) => {
          const alias = String(option.value ?? '');
          const aliasLabel = String(option.label ?? alias);
          const real = alias ? realOf(alias) : null;
          return {
            value: alias,
            label: real ?? aliasLabel,
            sublabel: real
              ? [alias, aliasLabel !== alias ? aliasLabel : null].filter(Boolean).join(' · ')
              : undefined,
            mono: Boolean(real),
          };
        })
        .filter((option: { value: string }) => option.value && option.value !== 'default'));

      setDefaultModelReal(realOf('default'));
    })();
    return () => { cancelled = true; };
  }, []);

  return { models, defaultModelReal };
}

/** 模型下拉的选项:第一项是「默认模型」(副行写它实际指向谁)。 */
export function useModelOptions(
  models: FancyOption[],
  currentModel: string,
  defaultModelReal: string | null,
): FancyOption[] {
  const { t } = useTranslation('common');
  return useMemo(() => {
    const defaultLabel = t('tasksPage.form.defaultModel', { defaultValue: '默认模型' });
    const rows: FancyOption[] = [{
      value: '',
      label: defaultModelReal ?? defaultLabel,
      sublabel: defaultModelReal ? `default · ${defaultLabel}` : undefined,
      mono: Boolean(defaultModelReal),
    }];
    if (currentModel && !models.some((model) => model.value === currentModel)) {
      rows.push({ value: currentModel, label: currentModel });
    }
    return rows.concat(models);
  }, [models, currentModel, defaultModelReal, t]);
}

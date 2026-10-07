import { createElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAliasReal } from '../components/chat/utils/modelAliasReal';
import ModelVendorIcon from '../components/llm-logo-provider/ModelVendorIcon';
import type { FancyOption } from '../shared/view/ui/FancySelect';
import type { ProviderModelOption } from '../types/app';
import { authenticatedFetch } from '../utils/api';
import { formatContextWindow } from '../../shared/modelVendors';

/**
 * 「项目 / 会话 / 模型」三个下拉的数据源,与 `FancySelect` 一起构成定时任务那一套下拉的完整定义。
 *
 * 别处要用同一套交互时复用这里,不要照抄 —— 抄出来的第二份会在下一次改动时悄悄漂开。
 * 别名 → 实际模型的判据(新鲜实测 > 配置映射,实测过期就不用)与聊天输入框共用 `resolveAliasReal`。
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
 * 模型下拉的一行:`FancyOption` 加上它走哪个网关、是不是本人的私有模型。
 * FancySelect 只认 FancyOption 的字段;多出来的两个给调用方筛(SkillWhet 只要默认网关上、所有人可见的)。
 */
export type ModelRow = FancyOption & { gatewayId?: number; private?: boolean };

/**
 * 目录里有模型时别名不当选项(与对话输入框模型菜单的 splitModelMenu 同一口径)。
 * 返回可选的行与收起来的别名行;目录为空(官方 API、没建目录,或选项没有分组)时别名就是全部可选项。
 * 不能用的行(`disabled`)照样列出,排在能用的后面;两段各自保持服务端顺序(私有在前)。
 */
export function splitSelectableModels<T extends FancyOption>(
  rows: T[],
  options: Array<Partial<ProviderModelOption>>,
): { models: T[]; aliasModels: T[] } {
  const hasGroups = options.some((option) => option.group === 'catalog' || option.group === 'alias');
  const groupOf = new Map(options.map((option) => [String(option.value ?? ''), option.group]));
  const isAlias = (value: string): boolean => !hasGroups || groupOf.get(value) === 'alias';
  const availableFirst = (list: T[]): T[] => [...list.filter((row) => !row.disabled), ...list.filter((row) => row.disabled)];
  const catalogRows = availableFirst(rows.filter((row) => !isAlias(row.value)));
  const aliasRows = availableFirst(rows.filter((row) => isAlias(row.value)));
  return catalogRows.length > 0 ? { models: catalogRows, aliasModels: aliasRows } : { models: aliasRows, aliasModels: [] };
}

/**
 * `/models` 的 OPTIONS → 下拉行(纯函数,单测见 splitSelectableModels.test.ts)。
 *
 * - 目录条目(group=catalog):主行写显示名,副行写模型 id(与显示名不同时)、上下文窗口和网关名
 *   (只有不在默认网关上的条目才带),带厂商图标;
 * - 别名行:知道实际模型时主行写实际模型、副行写别名;
 * - 本人的私有模型带「私有」小标;此刻用不了的(`available: false`)置灰点不了,副行换成服务端给的原因;
 * - `default` 不在里面(调用方自己给「默认模型」那一行)。
 */
export function buildModelRows(
  options: Array<Partial<ProviderModelOption>>,
  realOf: (alias: string) => string | null,
  labels: { privateBadge: string; unavailable: string },
): ModelRow[] {
  const hasGroups = options.some((option) => option.group === 'catalog' || option.group === 'alias');
  return options
    .map((option): ModelRow => {
      const value = String(option.value ?? '');
      const label = String(option.label ?? value);
      if (hasGroups && option.group === 'catalog') {
        const windowBadge = formatContextWindow(typeof option.contextWindow === 'number' ? option.contextWindow : null);
        const unavailable = option.available === false;
        return {
          value,
          label,
          sublabel: unavailable
            ? (option.unavailableReason || labels.unavailable)
            : [label !== value ? value : null, windowBadge, option.gatewayName].filter(Boolean).join(' · ') || undefined,
          icon: createElement(ModelVendorIcon, { vendor: option.vendor, modelId: value, label, size: 14 }),
          ...(unavailable ? { disabled: true } : {}),
          ...(option.private ? { badge: labels.privateBadge, private: true } : {}),
          ...(typeof option.gatewayId === 'number' ? { gatewayId: option.gatewayId } : {}),
        };
      }
      const real = value ? realOf(value) : null;
      return {
        value,
        label: real ?? label,
        sublabel: real
          ? [value, label !== value ? label : null].filter(Boolean).join(' · ')
          : undefined,
        mono: Boolean(real),
        icon: real ? createElement(ModelVendorIcon, { modelId: real, label: real, size: 14 }) : undefined,
        ...(typeof option.gatewayId === 'number' ? { gatewayId: option.gatewayId } : {}),
      };
    })
    .filter((option) => option.value && option.value !== 'default');
}

type ModelCatalogSource = {
  options: Array<Partial<ProviderModelOption>>;
  stale: boolean;
  probed: Record<string, { actualModel?: string | null }>;
  configured: Record<string, { configuredModel?: string | null }>;
};

type ModelCatalog = {
  /**
   * 可选的模型。目录里有模型时只列目录条目:别名(sonnet / opus / haiku…)只是目录里某个模型换了个名字,
   * 与对话输入框的模型菜单同一口径不当选项;目录为空时别名就是全部可选项。
   * 此刻用不了的模型也在里面(`disabled`,排在后面);行上带 gatewayId / private 供调用方筛。
   */
  models: ModelRow[];
  /** 被收起来的别名行(主行实际模型、副行别名):只用来显示"存量任务 / 默认值恰好是别名"的当前值,不进选项。 */
  aliasModels: ModelRow[];
  defaultModelReal: string | null;
  /** 模型值 → 真实网关模型名(目录条目 = 自己;别名 = 配置映射到的,不用实测值;不知道就不在表里)。 */
  realModels: Record<string, string>;
};

const EMPTY_CATALOG: ModelCatalog = { models: [], aliasModels: [], defaultModelReal: null, realModels: {} };

/**
 * 模型目录与聊天输入框同源(`/api/providers/claude/models`),外加别名→实际模型的映射
 * (`/model-mappings`)。用户关心"现在到底是谁在答",所以主行写实际模型名(claude-sonnet-5、
 * deepseek-v4-flash…),别名(sonnet/opus…)与档位说明退到副行。
 * 映射优先级同聊天输入框(`resolveAliasReal`):新鲜实测 > 配置层 > 没有(退回显示别名)。
 * 两个接口任一缺席都不挡表单。
 *
 * 列表是看的人自己的(按人过滤 + 私有模型 + 能不能用)。定时任务运行时用任务主人的 key,
 * 所以 root 编辑别人的任务时看到的是 root 自己的可用性,可以接受。
 */
export function useModelCatalog(): ModelCatalog {
  const { t } = useTranslation('common');
  const [source, setSource] = useState<ModelCatalogSource | null>(null);

  // 设置里填 / 清了 key、改了目录或网关时会广播 prism:model-catalog-changed:重新拉,不用等页面重挂
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    const onChanged = () => setReloadTick((tick) => tick + 1);
    window.addEventListener('prism:model-catalog-changed', onChanged);
    return () => window.removeEventListener('prism:model-catalog-changed', onChanged);
  }, []);

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

      setSource({
        options: options as Array<Partial<ProviderModelOption>>,
        stale: mappingData?.data?.stale === true,
        probed: (mappingData?.data?.mappings ?? {}) as ModelCatalogSource['probed'],
        configured: (mappingData?.data?.configMappings ?? {}) as ModelCatalogSource['configured'],
      });
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  // 行在这里拼(不在请求回调里):「私有」/「暂不可用」这些字要跟着界面语言走
  return useMemo(() => {
    if (!source) return EMPTY_CATALOG;
    const { options, stale, probed, configured } = source;
    const realOf = (alias: string): string | null =>
      resolveAliasReal(alias, { probed, configured, stale });

    const rows = buildModelRows(options, realOf, {
      privateBadge: t('tasksPage.form.privateModel'),
      unavailable: t('tasksPage.form.modelUnavailable'),
    });
    const split = splitSelectableModels(rows, options);

    // 只用配置映射(与服务端 proposerEvaluatorConflict 同一口径);实测值只用于显示,不拿来判"同一个模型"
    const hasGroups = options.some((option) => option.group === 'catalog' || option.group === 'alias');
    const reals: Record<string, string> = {};
    for (const option of options) {
      const value = String(option.value ?? '');
      if (!value) continue;
      const real = hasGroups && option.group === 'catalog' ? value : (configured[value]?.configuredModel ?? null);
      if (real) reals[value] = real;
    }

    return { models: split.models, aliasModels: split.aliasModels, defaultModelReal: realOf('default'), realModels: reals };
  }, [source, t]);
}

/** 模型下拉的选项:第一项是「默认模型」(副行写它实际指向谁)。 */
export function useModelOptions(
  models: FancyOption[],
  currentModel: string,
  defaultModelReal: string | null,
  /** 收起来的别名行:当前值恰好是别名时拿它显示(实际模型 + 别名),不当选项列出。 */
  aliasModels: FancyOption[] = [],
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
      rows.push(aliasModels.find((model) => model.value === currentModel) ?? { value: currentModel, label: currentModel });
    }
    return rows.concat(models);
  }, [models, aliasModels, currentModel, defaultModelReal, t]);
}

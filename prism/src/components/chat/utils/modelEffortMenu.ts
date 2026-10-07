import type { ProviderModelOption } from '../../../types/app';

import { availableFirst, isModelAvailable } from './modelAvailability';

/**
 * 模型 + 档位两级菜单的纯函数(上面是常用模型,「档位 ›」「更多模型 ›」各一个子菜单;
 * 输入框上只显示「模型名 档位」)。拆出来单测。
 */

export const isAliasOption = (option: ProviderModelOption, hasGroups: boolean): boolean => !hasGroups || option.group === 'alias';

/** 档位值 → i18n 键(chat:modelMenu.effort.*)。认不出的原样显示。 */
export const EFFORT_LABEL_KEYS: Record<string, string> = {
  low: 'modelMenu.effort.low',
  medium: 'modelMenu.effort.medium',
  high: 'modelMenu.effort.high',
  xhigh: 'modelMenu.effort.xhigh',
  max: 'modelMenu.effort.max',
};

export const effortValues = (option: ProviderModelOption | null | undefined): string[] =>
  option?.effort?.values?.map((entry) => entry.value).filter(Boolean) ?? [];

/**
 * 这个模型此刻实际跑哪一档(与服务端 resolveClaudeEffort 同一口径):
 * 选的档它支持 → 那一档;选的是 default 或它不支持 → 它自己的默认档;没有档位 → null。
 */
export function effectiveEffort(option: ProviderModelOption | null | undefined, stored: string | null | undefined): string | null {
  const values = effortValues(option);
  if (values.length === 0) return null;
  if (stored && stored !== 'default' && values.includes(stored)) return stored;
  const fallback = option?.effort?.default;
  return fallback && values.includes(fallback) ? fallback : null;
}

/** 选中某一档时存什么:等于模型默认档就存 'default'(之后换模型也跟着各自的默认走),否则存这一档。 */
export function effortToStore(option: ProviderModelOption | null | undefined, chosen: string): string {
  return option?.effort?.default && option.effort.default === chosen ? 'default' : chosen;
}

/** 上面一节里「当前 + 推荐」最多几条(私有模型不占这个名额)。 */
const PRIMARY_RECOMMENDED_LIMIT = 5;

/**
 * 主菜单上面那一节:当前模型 + 本人的私有模型 + 目录里标了推荐的(当前 + 推荐最多 5 条)。当前是别名也放进来(放第一个)。
 * 其余目录模型进「更多模型」。
 *
 * 目录里有模型时别名不当选项:子代理默认跟随主模型(CLI 内置 Explore / Plan / general-purpose 都是
 * `model: "inherit"`),别名只在 Claude 派子代理时点名 sonnet/opus/haiku/fable、或 CLI 内部小活(网页摘要之类)
 * 时才用来路由 —— 那是 设置 → 模型 里映射的事;拿来当主模型选,只是目录里某个模型换了个名字。
 * 只有目录为空(官方 API、没建目录,或服务端没给分组)时别名才是全部可选项。
 * 当前恰好是别名(存量会话)仍放第一行,好看出现在是谁在答。
 *
 * - 私有模型放在上面一节(不收进「更多模型」),不占推荐的名额,顺序照服务端给的(私有在前);
 * - 不能用的模型(`available: false`)照样列出、置灰,但每一节里都排在能用的后面;推荐名额先给能用的,
 *   挤不下的不能用的推荐进「更多模型」;"至少给一个目录模型可点"优先挑能用的。
 */
export function splitModelMenu(options: ProviderModelOption[], currentValue: string | null | undefined): {
  primary: ProviderModelOption[];
  more: ProviderModelOption[];
  aliases: ProviderModelOption[];
} {
  const hasGroups = options.some((option) => option.group === 'catalog' || option.group === 'alias');
  const catalog = options.filter((option) => !isAliasOption(option, hasGroups));
  const aliases = options.filter((option) => isAliasOption(option, hasGroups));
  const current = options.find((option) => option.value === currentValue) ?? null;
  const others = catalog.filter((option) => option.value !== current?.value);
  const privateOptions = others.filter((option) => option.private);
  const recommendedBudget = PRIMARY_RECOMMENDED_LIMIT - (current ? 1 : 0);
  const recommended = availableFirst(others.filter((option) => option.recommended && !option.private)).slice(0, Math.max(0, recommendedBudget));
  const picked = [...privateOptions, ...recommended];
  // 目录里一条能用的私有 / 推荐都没有、当前又是别名(或没有当前)时,至少给一个能用的目录模型可点
  if (!picked.some((option) => isModelAvailable(option)) && (!current || isAliasOption(current, hasGroups))) {
    const fallback = others.find((option) => isModelAvailable(option) && !picked.includes(option))
      ?? (picked.length === 0 ? others[0] : undefined);
    if (fallback) picked.push(fallback);
  }
  const primary: ProviderModelOption[] = [...(current ? [current] : []), ...availableFirst(picked)];
  const inPrimary = new Set(primary.map((option) => option.value));
  return {
    primary,
    more: availableFirst(catalog.filter((option) => !inPrimary.has(option.value))),
    aliases: catalog.length > 0 ? [] : aliases.filter((option) => !inPrimary.has(option.value)),
  };
}

/**
 * ↑↓ 在菜单的这一层里走到下一项,跳过禁用的(不能用的模型、切换中的行)。
 * `disabled[i]` 是第 i 项禁没禁;`from` < 0(焦点不在这一层)时落到第一个能走的项。返回 -1 = 一项都走不到。
 */
export function nextEnabledIndex(disabled: boolean[], from: number, step: 1 | -1): number {
  const count = disabled.length;
  if (count === 0) return -1;
  if (from < 0 || from >= count) return disabled.findIndex((isDisabled) => !isDisabled);
  let index = from;
  for (let tries = 0; tries < count; tries += 1) {
    index = (index + step + count) % count;
    if (!disabled[index]) return index;
  }
  return -1;
}

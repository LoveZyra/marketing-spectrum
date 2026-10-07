import type { ProviderModelOption, ProviderModelsDefinition } from '../../../types/app';

/**
 * 模型「能不能用」的纯函数(拆出来单测):有网关和个人 key 时,同一份模型列表里可能有当前用户用不了的模型。
 *
 * 服务端按人标好:`available: false` + `unavailableReason`(中文一句);字段缺省按能用处理。
 * 不能用的模型照样列出来(置灰、点不了),让人知道它在、为什么用不了、去哪儿补 key。
 */

type AvailabilityFields = Pick<ProviderModelOption, 'available' | 'unavailableReason' | 'unavailableCode'>;

export const isModelAvailable = (option: AvailabilityFields | null | undefined): boolean => option?.available !== false;

/**
 * 「去填 key」只给填了 key 就能用的那几种(网关没有默认 key、自己也没填 / 私有网关还没 key)。
 * 网关停用、网关没了,填 key 也没用,不给这个入口。按服务端的原因码(`unavailableCode`)判;
 * 没有原因码时退回看原因里提没提 key;连原因都没有时照给 —— 设置页里看得到网关的状态。
 */
export const canFixWithKey = (option: AvailabilityFields | null | undefined): boolean => {
  if (isModelAvailable(option)) return false;
  if (option?.unavailableCode) return option.unavailableCode === 'no_key';
  return !option?.unavailableReason || /key/i.test(option.unavailableReason);
};

/** 能用的排前面、不能用的沉底;两段各自保持原顺序(服务端把私有模型排在最前,这个顺序不打乱)。 */
export function availableFirst<T extends AvailabilityFields>(options: T[]): T[] {
  return [...options.filter((option) => isModelAvailable(option)), ...options.filter((option) => !isModelAvailable(option))];
}

/**
 * 需要自动挑一个模型时挑谁:服务端的 DEFAULT(服务端已经避开了不可用的);
 * DEFAULT 恰好不可用(如竞态)→ 第一个可用的推荐目录模型 → 第一个可用的目录模型 → 第一个可用的;
 * 一个可用的都没有就原样给 DEFAULT(发送时服务端会说清楚)。只要还有可用的模型,就不会自动挑中不可用的。
 */
export function fallbackModel(definition: ProviderModelsDefinition): string {
  const options = definition.OPTIONS;
  const preferred = options.find((option) => option.value === definition.DEFAULT);
  if (!preferred || isModelAvailable(preferred)) return definition.DEFAULT;
  const pick = options.find((option) => option.group === 'catalog' && option.recommended && isModelAvailable(option))
    ?? options.find((option) => option.group === 'catalog' && isModelAvailable(option))
    ?? options.find((option) => isModelAvailable(option));
  return pick?.value ?? definition.DEFAULT;
}

/**
 * 新会话默认模型(存在 localStorage 的 `claude-model`)在列表变了之后用谁:
 * - 存着的还在列表里 → 用它。不可用也不换 —— 那是用户自己选的;发出去时服务端会回一句清楚的原因
 *   (GATEWAY_KEY_MISSING 之类),悄悄换成别的模型反而让人以为是它在答;
 * - 第一次打开(没存过)→ 服务端默认(见 fallbackModel);
 * - 存着的从列表里没了(下架 / 不再对他可见)→ 当前值还在就留着,否则退回默认(同样不挑不可用的)。
 */
export function pickStoredModel(stored: string | null, current: string, definition: ProviderModelsDefinition): string {
  const inList = (value: string) => definition.OPTIONS.some((option) => option.value === value);
  if (stored && inList(stored)) return stored;
  if (!stored) return fallbackModel(definition);
  if (current && inList(current)) return current;
  return fallbackModel(definition);
}

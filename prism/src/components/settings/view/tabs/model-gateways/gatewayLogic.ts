/**
 * 设置页「网关 / 模型网关」的纯逻辑,单测在 gatewayLogic.test.ts
 * (客户端测试跑 node 环境,挂不起组件,能抽出来的判断都放这里)。
 *
 * 校验与服务端 `claude-gateways.service.ts` 同一口径(key 的空白 / 长度,网关地址的协议 / 账号密码 / # / 末尾 /v1);
 * 前端先拦一道只是为了按钮能早点变灰、提示能贴在字段旁边,最终以服务端的报错为准。
 */

import type { GatewayView, KeySource } from './gatewaysApi';

/** 与服务端 `KEY_MAX` 一致。 */
export const KEY_MAX_LENGTH = 4096;
/** 与服务端 `validateGatewayInput` 一致。 */
export const GATEWAY_NAME_MAX_LENGTH = 60;
export const BASE_URL_MAX_LENGTH = 500;

/* ------------------------------ 表单校验 ------------------------------ */

/**
 * 表单问题的代码。界面文案在 `gateways.problem.<code>`(settings 命名空间),
 * 键名由单测对着 10 份 locale 核过 —— 加一个代码就得在每份 locale 里补一条。
 */
export const FORM_PROBLEMS = [
  'needName',
  'nameTooLong',
  'needBaseUrl',
  'baseUrlTooLong',
  'baseUrlInvalid',
  'baseUrlProtocol',
  'baseUrlCredentials',
  'baseUrlHash',
  'needKey',
  'keyTooLong',
  'keyWhitespace',
] as const;
export type FormProblem = (typeof FORM_PROBLEMS)[number];

export function formProblemKey(problem: FormProblem): string {
  return `gateways.problem.${problem}`;
}

/** 中文兜底(与 zh-CN 那份一致),给 `t(key, { defaultValue })` 用。 */
export const FORM_PROBLEM_FALLBACKS: Record<FormProblem, string> = {
  needName: '要填网关名',
  nameTooLong: '网关名不能超过 {{max}} 个字符',
  needBaseUrl: '要填网关地址',
  baseUrlTooLong: '网关地址不能超过 {{max}} 个字符',
  baseUrlInvalid: '网关地址不是合法的 URL(要以 http:// 或 https:// 开头)',
  baseUrlProtocol: '网关地址只能是 http:// 或 https://',
  baseUrlCredentials: '网关地址里不要带账号密码 —— key 单独填',
  baseUrlHash: '网关地址不能带 #',
  needKey: '要填 key',
  keyTooLong: 'key 不能超过 {{max}} 个字符',
  keyWhitespace: 'key 里有空格或换行 —— 多半是粘贴时带进来的,去掉再保存',
};

/** 插值参数(长度上限之类)。 */
export function formProblemVars(problem: FormProblem): Record<string, number> {
  if (problem === 'nameTooLong') return { max: GATEWAY_NAME_MAX_LENGTH };
  if (problem === 'baseUrlTooLong') return { max: BASE_URL_MAX_LENGTH };
  if (problem === 'keyTooLong') return { max: KEY_MAX_LENGTH };
  return {};
}

/** key:空 → needKey;过长;中间有空白 / 控制字符(粘贴带进来的换行最常见)。首尾空白会被裁掉,不算问题。 */
export function keyProblem(raw: string): FormProblem | null {
  const key = raw.trim();
  if (!key) return 'needKey';
  if (key.length > KEY_MAX_LENGTH) return 'keyTooLong';
  if (/[\s\x00-\x1f\x7f]/.test(key)) return 'keyWhitespace';
  return null;
}

export type BaseUrlCheck = { ok: true; normalized: string } | { ok: false; problem: FormProblem };

/**
 * 网关地址:http(s)、不带账号密码与 #;规范化 = 去掉末尾的 `/`,再去掉末尾的 `/v1`
 * (CLI 自己拼 /v1/messages,填成 …/v1 会变成 /v1/v1/messages)。
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, problem: 'needBaseUrl' };
  if (text.length > BASE_URL_MAX_LENGTH) return { ok: false, problem: 'baseUrlTooLong' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: 'baseUrlInvalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'baseUrlProtocol' };
  if (url.username || url.password) return { ok: false, problem: 'baseUrlCredentials' };
  if (url.hash) return { ok: false, problem: 'baseUrlHash' };
  let normalized = url.toString();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (/\/v1$/i.test(normalized)) normalized = normalized.slice(0, -3);
  return { ok: true, normalized };
}

export type GatewayFormValues = { name: string; baseUrl: string; key: string };

/**
 * 网关表单的第一个问题(按字段顺序)。`key`:
 * - `'optional'`:留空可以,填了就要合法(新建共享网关的默认 key、新建私有网关的 key);
 * - `'none'`:表单里没有 key(编辑网关)。
 */
export function gatewayFormProblem(values: GatewayFormValues, key: 'optional' | 'none'): FormProblem | null {
  const name = values.name.trim();
  if (!name) return 'needName';
  if (name.length > GATEWAY_NAME_MAX_LENGTH) return 'nameTooLong';
  const url = checkBaseUrl(values.baseUrl);
  if (!url.ok) return url.problem;
  if (key === 'optional' && values.key.trim()) return keyProblem(values.key);
  return null;
}

/** 「先测试」要什么:地址合法 + 有一把合法的 key(没保存的网关只能拿表单里的 key 测)。 */
export function unsavedTestProblem(values: { baseUrl: string; key: string }): FormProblem | null {
  const url = checkBaseUrl(values.baseUrl);
  if (!url.ok) return url.problem;
  return keyProblem(values.key);
}

/** 地址会被存成什么样 —— 与输入不同时在输入框下面提示一句(比如去掉了 /v1)。 */
export function baseUrlSavedAs(raw: string): string | null {
  const url = checkBaseUrl(raw);
  if (!url.ok) return null;
  return url.normalized !== raw.trim() ? url.normalized : null;
}

/* ------------------------------ key 的显示 ------------------------------ */

/** 末四位前面补点 —— 永远不显示完整 key。 */
export function maskKey(last4: string | null | undefined): string {
  return `····${last4 ?? ''}`;
}

export type KeySourceView =
  | { kind: 'personal'; last4: string | null; setByOther: string | null }
  | { kind: 'gatewayDefault' }
  | { kind: 'settings' }
  | { kind: 'none' };

/**
 * 「我的 key」卡片上那一句:我的回合在这个网关上用哪把 key。
 * `setByOther`:我的个人 key 是别人(root)代填的 —— 填的人就是我自己时为 null。
 */
export function describeKeySource(
  view: { source: KeySource; personalLast4: string | null; personalSetBy: string | null },
  me: string | null | undefined,
): KeySourceView {
  switch (view.source) {
    case 'personal': {
      const setBy = view.personalSetBy?.trim() || null;
      return { kind: 'personal', last4: view.personalLast4, setByOther: setBy && setBy !== (me ?? '') ? setBy : null };
    }
    case 'gateway_default':
      return { kind: 'gatewayDefault' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return { kind: 'none' };
  }
}

/** 共享网关(root 看)的默认 key 状态。 */
export type DefaultKeyView = { kind: 'set'; last4: string | null } | { kind: 'missing' };

export function describeDefaultKey(gateway: Pick<GatewayView, 'hasDefaultKey' | 'defaultKeyLast4'>): DefaultKeyView {
  return gateway.hasDefaultKey ? { kind: 'set', last4: gateway.defaultKeyLast4 } : { kind: 'missing' };
}

/** 行上的鉴权方式小标(技术名词,不翻译)。 */
export function authTypeBadge(authType: GatewayView['authType']): string {
  return authType === 'x-api-key' ? 'x-api-key' : 'Bearer';
}

/* ------------------------------ 我的网关页 ------------------------------ */

/** 「我的 key」只列默认网关与共享网关;私有网关单独一块(它的 key 是网关本身的)。 */
export function splitMyGateways<T extends { scope: GatewayView['scope'] }>(gateways: readonly T[]): { keyed: T[]; owned: T[] } {
  return {
    keyed: gateways.filter((gateway) => gateway.scope !== 'private'),
    owned: gateways.filter((gateway) => gateway.scope === 'private'),
  };
}

/**
 * 私有网关行上的「N 个模型」按手上的私有模型现算 —— 增删私有模型的接口只回模型列表,
 * 不现算的话网关行上的数字要等刷新才对得上(删网关时的确认文案也靠它)。
 */
export function withPrivateModelCounts<T extends { id: number; modelCount: number }>(
  owned: readonly T[],
  models: ReadonlyArray<{ gatewayId?: number }>,
): T[] {
  return owned.map((gateway) => ({ ...gateway, modelCount: models.filter((model) => (model.gatewayId ?? 0) === gateway.id).length }));
}

/**
 * 「我的私有网关 / 私有模型」两块怎么画:
 * - `active`:root 允许 → 能加、能改;
 * - `readonly`:root 关掉了,但我还有旧的 → 列出来,只能删;
 * - `hidden`:root 关掉了,我也没有 → 整块不画。
 */
export type PrivateSectionMode = 'active' | 'readonly' | 'hidden';

export function privateSectionMode(allowPrivate: boolean, ownedCount: number, modelCount = 0): PrivateSectionMode {
  if (allowPrivate) return 'active';
  return ownedCount > 0 || modelCount > 0 ? 'readonly' : 'hidden';
}

/* ------------------------------ 目录编辑器:网关 / 可用人员 ------------------------------ */

/** 编辑器下拉里的一项网关(0 = 默认网关,名字由界面按语言给)。 */
export type GatewayChoice = {
  id: number;
  name: string;
  host: string | null;
  enabled: boolean;
  hasDefaultKey: boolean;
  /** 条目挂着的网关不在列表里(被删了 / 列表没拉到):补一项占位,保存时原样带回,不会被悄悄改到默认网关 */
  missing?: boolean;
};

export function toGatewayChoice(gateway: Pick<GatewayView, 'id' | 'name' | 'host' | 'enabled' | 'hasDefaultKey'>): GatewayChoice {
  return { id: gateway.id, name: gateway.name, host: gateway.host, enabled: gateway.enabled, hasDefaultKey: gateway.hasDefaultKey };
}

/** 列表里补上当前值(不在列表里时)—— 否则下拉显示成第一项,一保存就把网关改掉了。 */
export function withCurrentChoice(choices: readonly GatewayChoice[], currentId: number | null | undefined): GatewayChoice[] {
  const list = [...choices];
  if (typeof currentId === 'number' && currentId > 0 && !list.some((choice) => choice.id === currentId)) {
    list.push({ id: currentId, name: `#${currentId}`, host: null, enabled: false, hasDefaultKey: false, missing: true });
  }
  return list;
}

export type AudienceView = { kind: 'everyone' } | { kind: 'some'; count: number };

/** 目录行上的「限 N 人」:null / 缺字段 = 所有人。空数组 = 只有 root。 */
export function describeAudience(allowedUsers: readonly number[] | null | undefined): AudienceView {
  return Array.isArray(allowedUsers) ? { kind: 'some', count: allowedUsers.length } : { kind: 'everyone' };
}

/** 用户 id → 用户名(找不到的写 `#id`,别让人以为那个人不存在)。 */
export function namesOf(ids: readonly number[], users: ReadonlyArray<{ id: number; username: string }> | null | undefined): string[] {
  const byId = new Map((users ?? []).map((user) => [user.id, user.username]));
  return ids.map((id) => byId.get(id) ?? `#${id}`);
}

/** 勾 / 取消一个人,结果按 id 升序(与服务端存法一致,脏检查不会因为顺序误报)。 */
export function toggleUserId(selected: readonly number[], id: number): number[] {
  const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  return [...new Set(next)].sort((a, b) => a - b);
}

/** 可用人员列表的搜索:按用户名包含(不分大小写);空查询全给。 */
export function filterUsers<T extends { username: string }>(users: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...users];
  return users.filter((user) => user.username.toLowerCase().includes(needle));
}

/* ------------------------------ 杂项 ------------------------------ */

/**
 * 库里的时间是 SQLite 的 `YYYY-MM-DD HH:MM:SS`(UTC、没有 T / Z)—— 直接 `new Date()`
 * 会被当成本地时间。认不出来就原样给。
 */
export function parseDbTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDbTime(value: string | null | undefined): string {
  const parsed = parseDbTime(value);
  if (parsed) return parsed.toLocaleString();
  return value ?? '';
}

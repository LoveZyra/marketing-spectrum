import { authenticatedFetch } from './api';
import { decodeJwtPayload } from './tokenRefresh';

/**
 * 账号级界面偏好同步。
 *
 * 权限清单、项目排序、编辑器偏好、文件树视图、提示音开关都住在 localStorage 里,
 * 换台电脑、换个浏览器、清一次缓存就全部归零,而它们是用户一条条调出来的。
 *
 * 做法刻意保守:localStorage 仍然是读的那一份(同步、无网络、不会让界面在启动时闪一下默认值),
 * 服务端只是它的备份与跨设备通道。登录后拉一次,改动后推一次。
 *
 * 冲突用时间戳解决:两边都带 `updatedAt`,新的赢。否则"在 A 电脑上改完打开 B 电脑"和
 * "在 B 电脑上改完打开 A 电脑"会得到相反的结果,用户无从预测哪一次生效。
 *
 * 本机那份记着主人是谁:同一浏览器换账号登录时,前一个人的设置(含 skipPermissions /
 * allowedTools)和草稿不能被当作"本机更新"推成后一个人的账号设置。
 *   - 本机记一个 `accountSettingsOwner`(userId)。拉取时主人 ≠ 当前用户 → 本机那份
 *     一律不推,先清掉再以服务端为准;
 *   - 登出时只清草稿 + 时间戳(`clearLocalAccountStateOnLogout`);同步键留着,
 *     换人由主人标记兜底;
 *   - 草稿(`draft_input_*`)不同步:草稿是正文,不是偏好;服务端记录里残留的草稿键
 *     在下一次推送时被整体覆盖掉。
 */

/** 参与同步的 localStorage 键。不在这张表里的一律只留在本机(比如 auth-token)。 */
const SYNCED_KEYS = [
  'claude-settings',        // 权限清单 + 项目排序
  'codeEditorFontSize',
  'codeEditorLineNumbers',
  'codeEditorShowMinimap',
  'codeEditorWordWrap',
  'file-tree-view-mode',
  'notificationSoundEnabled',
  'uiPreferences',          // 侧栏展开、主题外的界面开关
] as const;

/**
 * 登出 / 换账号时要清掉的本机私有前缀键:输入框草稿。
 * 它们不参与账号同步,只在本机;换人时清掉(它们是上一个人的正文)。
 */
const LOCAL_PRIVATE_KEY_PREFIXES = ['draft_input_'] as const;

const UPDATED_AT_KEY = 'accountSettingsUpdatedAt';
const OWNER_KEY = 'accountSettingsOwner';
const AUTH_TOKEN_KEY = 'auth-token';

type Payload = { values: Record<string, string>; updatedAt: string };

const safeGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSet = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下 localStorage 可能整个抛 —— 同步是增值功能,不该让它拖垮页面。
  }
};

const safeRemove = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上
  }
};

const listLocalPrivateKeys = (): string[] => {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && LOCAL_PRIVATE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
};

/** 当前登录的 userId(从本机令牌解),拿不到返回 null。 */
export const readCurrentAccountId = (): string | null => {
  const payload = decodeJwtPayload(safeGet(AUTH_TOKEN_KEY));
  const raw = payload?.userId;
  return raw === null || raw === undefined ? null : String(raw);
};

const readLocal = (): Payload => {
  const values: Record<string, string> = {};
  for (const key of SYNCED_KEYS) {
    const value = safeGet(key);
    if (value !== null && value !== '') values[key] = value;
  }
  return { values, updatedAt: safeGet(UPDATED_AT_KEY) ?? '' };
};

const writeLocal = (values: Record<string, unknown>, updatedAt: string): void => {
  for (const key of SYNCED_KEYS) {
    const value = values[key];
    if (typeof value === 'string') safeSet(key, value);
  }
  safeSet(UPDATED_AT_KEY, updatedAt);
};

/**
 * 清掉本机与账号相关的一切:同步键、草稿、时间戳、主人标记。
 * 登出时调;换账号登录(主人 ≠ 当前用户)时也在拉取前先调。
 * 不动 `auth-token`(登出流程自己管)与主题、语言这类与账号无关的键。
 */
export function clearLocalAccountState(): void {
  for (const key of SYNCED_KEYS) safeRemove(key);
  for (const key of listLocalPrivateKeys()) safeRemove(key);
  safeRemove(UPDATED_AT_KEY);
  safeRemove(OWNER_KEY);
}

/**
 * 登出只清本机私有的东西(草稿、时间戳),同步键与主人标记留着。
 *
 * 连同步键一起清的话,同一个人再登录时本机是空的、服务端那份必然"不一样",每次登录都会
 * 整页重载一次。换人的情况不靠登出清理:拉取时主人标记 ≠ 当前用户,
 * `pullAccountSettings` 会先整体清掉、且绝不推上去。
 */
export function clearLocalAccountStateOnLogout(): void {
  for (const key of listLocalPrivateKeys()) safeRemove(key);
  safeRemove(UPDATED_AT_KEY);
}

const isNewer = (left: string, right: string): boolean => {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
};

const hasLegacyDraftKeys = (values: Record<string, unknown>): boolean =>
  Object.keys(values).some((key) => LOCAL_PRIVATE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));

/**
 * 登录后拉一次。
 *
 * 服务端那份更新就落到本机并返回 true(调用方据此让界面重读)——
 * 本机更新则反向推上去,不覆盖用户刚在本机做的改动。
 *
 * 主人 ≠ 当前用户时本机那份绝不推:先清掉,再把服务端的落下来(服务端没有就从
 * 默认值开始,同样不推)。
 */
export async function pullAccountSettings(): Promise<boolean> {
  try {
    const accountId = readCurrentAccountId();
    const owner = safeGet(OWNER_KEY);
    const switchedAccount = accountId !== null && owner !== null && owner !== accountId;
    if (switchedAccount) clearLocalAccountState();
    if (accountId !== null) safeSet(OWNER_KEY, accountId);

    const response = await authenticatedFetch('/api/settings/ui');
    if (!response.ok) return false;
    const payload = (await response.json()) as {
      settings?: { values?: Record<string, unknown>; updatedAt?: string } | null;
      clientUpdatedAt?: string | null;
    };
    const remote = payload.settings;
    if (!remote || typeof remote !== 'object' || !remote.values) {
      // 服务端还没有这个账号的偏好:把本机这份作为初始值推上去 —— 但只在本机这份确实是
      // 他自己的(不是刚清掉的上一个人的)时。
      if (!switchedAccount) await pushAccountSettings();
      return false;
    }

    const local = readLocal();
    const remoteUpdatedAt = payload.clientUpdatedAt || remote.updatedAt || '';
    if (!switchedAccount && isNewer(local.updatedAt, remoteUpdatedAt)) {
      await pushAccountSettings();
      return false;
    }

    // 只有真的不一样才报"变了"。
    //
    // 调用方拿这个返回值去重载页面(散在十几个组件里的初始 state 没法逐个通知)。
    // 如果这里对"内容完全相同"也返回 true,就会变成:落盘 → 重载 → 又落盘 →
    // 又重载 —— 一个无限刷新的页面。时间戳相等并不代表内容相等(另一台设备可能
    // 推了一份一模一样的),所以判据必须是内容,不是时间戳。
    const changed = SYNCED_KEYS.some((key) => {
      const next = remote.values?.[key];
      return typeof next === 'string' && next !== local.values[key];
    });

    writeLocal(remote.values, remoteUpdatedAt || new Date().toISOString());
    // 老记录里还躺着草稿正文:推一次把它整体覆盖掉(值只含 SYNCED_KEYS)。
    if (hasLegacyDraftKeys(remote.values)) void pushAccountSettings();
    return changed;
  } catch {
    // 拉失败就用本机那份,什么都不做 —— 这条路径上没有任何值得打断用户的东西。
    return false;
  }
}

/** 改动后推一次。调用点自己决定时机(保存按钮、切换开关)。主人不是当前用户时不推。 */
export async function pushAccountSettings(): Promise<void> {
  const accountId = readCurrentAccountId();
  const owner = safeGet(OWNER_KEY);
  if (accountId !== null && owner !== null && owner !== accountId) return;
  if (accountId !== null && owner === null) safeSet(OWNER_KEY, accountId);

  const updatedAt = new Date().toISOString();
  const { values } = readLocal();
  safeSet(UPDATED_AT_KEY, updatedAt);

  try {
    await authenticatedFetch('/api/settings/ui', {
      method: 'PUT',
      body: JSON.stringify({ settings: { values, updatedAt }, clientUpdatedAt: updatedAt }),
    });
  } catch {
    // 推失败不影响本机:本机那份已经写好了,下次改动或下次登录会再试。
  }
}

/** 供测试与调用点复用的键清单。 */
export const ACCOUNT_SYNCED_KEYS: readonly string[] = SYNCED_KEYS;

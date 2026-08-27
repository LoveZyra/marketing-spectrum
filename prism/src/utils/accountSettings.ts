import { authenticatedFetch } from './api';

/**
 * 账号级界面偏好同步(F11)。
 *
 * 权限清单、项目排序、编辑器偏好、文件树视图、提示音开关 —— 这些全都住在
 * localStorage 里,于是换台电脑、换个浏览器、清一次缓存就全部归零,而它们是
 * 用户一条条调出来的。
 *
 * 做法刻意保守:**localStorage 仍然是读的那一份**(同步、无网络、不会让界面
 * 在启动时闪一下默认值),服务端只是它的备份与跨设备通道。登录后拉一次,
 * 改动后推一次。
 *
 * 冲突用时间戳解决:两边都带 `updatedAt`,新的赢。没有它的话,"在 A 电脑上改完
 * 打开 B 电脑"和"在 B 电脑上改完打开 A 电脑"会得到相反的结果,而用户完全无从
 * 预测哪一次生效。
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

const UPDATED_AT_KEY = 'accountSettingsUpdatedAt';

type Payload = { values: Record<string, string>; updatedAt: string };

const readLocal = (): Payload => {
  const values: Record<string, string> = {};
  for (const key of SYNCED_KEYS) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) values[key] = value;
    } catch {
      // 隐私模式下 localStorage 可能整个抛 —— 同步是增值功能,不该让它拖垮页面。
    }
  }
  let updatedAt = '';
  try {
    updatedAt = window.localStorage.getItem(UPDATED_AT_KEY) ?? '';
  } catch {
    updatedAt = '';
  }
  return { values, updatedAt };
};

const writeLocal = (values: Record<string, unknown>, updatedAt: string): void => {
  for (const key of SYNCED_KEYS) {
    const value = values[key];
    try {
      if (typeof value === 'string') window.localStorage.setItem(key, value);
    } catch {
      // 同上
    }
  }
  try {
    window.localStorage.setItem(UPDATED_AT_KEY, updatedAt);
  } catch {
    // 同上
  }
};

const isNewer = (left: string, right: string): boolean => {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
};

/**
 * 登录后拉一次。
 *
 * 服务端那份更新就落到本机并返回 true(调用方据此让界面重读)——
 * 本机更新则反向推上去,不覆盖用户刚在本机做的改动。
 */
export async function pullAccountSettings(): Promise<boolean> {
  try {
    const response = await authenticatedFetch('/api/settings/ui');
    if (!response.ok) return false;
    const payload = (await response.json()) as {
      settings?: { values?: Record<string, unknown>; updatedAt?: string } | null;
      clientUpdatedAt?: string | null;
    };
    const remote = payload.settings;
    if (!remote || typeof remote !== 'object' || !remote.values) {
      // 服务端还没有这个账号的偏好:把本机这份作为初始值推上去。
      await pushAccountSettings();
      return false;
    }

    const local = readLocal();
    const remoteUpdatedAt = payload.clientUpdatedAt || remote.updatedAt || '';
    if (isNewer(local.updatedAt, remoteUpdatedAt)) {
      await pushAccountSettings();
      return false;
    }

    // **只有真的不一样才报"变了"**。
    //
    // 调用方拿这个返回值去重载页面(散在十几个组件里的初始 state 没法逐个通知)。
    // 如果这里对"内容完全相同"也返回 true,就会变成:落盘 → 重载 → 又落盘 →
    // 又重载 —— 一个无限刷新的页面。时间戳相等并不代表内容相等(另一台设备可能
    // 推了一份一模一样的),所以判据必须是**内容**,不是时间戳。
    const changed = SYNCED_KEYS.some((key) => {
      const next = remote.values?.[key];
      return typeof next === 'string' && next !== local.values[key];
    });

    writeLocal(remote.values, remoteUpdatedAt || new Date().toISOString());
    return changed;
  } catch {
    // 拉失败就用本机那份,什么都不做 —— 这条路径上没有任何值得打断用户的东西。
    return false;
  }
}

/** 改动后推一次。调用点自己决定时机(保存按钮、切换开关)。 */
export async function pushAccountSettings(): Promise<void> {
  const updatedAt = new Date().toISOString();
  const { values } = readLocal();
  try {
    window.localStorage.setItem(UPDATED_AT_KEY, updatedAt);
  } catch {
    // 同上
  }

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

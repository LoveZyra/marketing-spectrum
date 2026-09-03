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

/**
 * dl:按前缀同步的动态键 —— 输入框草稿(`draft_input_*`)。
 *
 * 草稿此前只活在本机:换台电脑、清一次缓存,打了一半的话就没了。排队消息
 * (`queued_message_*`)刻意**不**同步:它和标签页互斥认领绑定,跨设备复制
 * 等于两台机器抢着替用户发同一条。
 *
 * 上限挡的是键数膨胀(每条会话一个键,聊过的会话只多不少):只带最新改动
 * 无从知晓,就按键名排序取前 N —— 排序只为两台设备取到**同一批**,
 * 保证收敛,不保证"最新的 N 条"。
 */
const SYNCED_KEY_PREFIXES = ['draft_input_'] as const;
const MAX_SYNCED_PREFIX_KEYS = 50;

const UPDATED_AT_KEY = 'accountSettingsUpdatedAt';

type Payload = { values: Record<string, string>; updatedAt: string };

const matchesSyncedPrefix = (key: string): boolean =>
  SYNCED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/** 本机所有命中前缀、值非空的键(排序取前 N,两台设备取同一批)。 */
const listLocalPrefixKeys = (): string[] => {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && matchesSyncedPrefix(key)) keys.push(key);
    }
    return keys.sort().slice(0, MAX_SYNCED_PREFIX_KEYS);
  } catch {
    return [];
  }
};

const readLocal = (): Payload => {
  const values: Record<string, string> = {};
  for (const key of [...SYNCED_KEYS, ...listLocalPrefixKeys()]) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null && value !== '') values[key] = value;
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
  // 前缀键:远端那份是权威(能走到这里 = 远端更新)。写入远端有的;
  // 删掉本机有、远端没有的 —— 否则"发出去后已清掉的草稿"会在旧设备上复活。
  try {
    const remotePrefixKeys = new Set(
      Object.keys(values).filter((key) => matchesSyncedPrefix(key) && typeof values[key] === 'string'),
    );
    for (const key of remotePrefixKeys) {
      window.localStorage.setItem(key, values[key] as string);
    }
    for (const localKey of listLocalPrefixKeys()) {
      if (!remotePrefixKeys.has(localKey)) window.localStorage.removeItem(localKey);
    }
  } catch {
    // 同上
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

/**
 * dl:草稿这类高频改动的**拖尾节流推送**。
 *
 * 设置页的开关本来就在保存动作里直接 push;草稿是每个键入都落一次 localStorage
 * 的东西,不能每敲一个字打一次接口 —— 停笔 8 秒后推一次。页面隐藏时立刻推:
 * "打了一半合上电脑,另一台接着打"正是这个功能存在的理由。
 */
const PUSH_DEBOUNCE_MS = 8_000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePushAccountSettings(delayMs: number = PUSH_DEBOUNCE_MS): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushAccountSettings();
  }, delayMs);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !pushTimer) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    void pushAccountSettings();
  });
}

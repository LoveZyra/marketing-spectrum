/**
 * 同一浏览器换账号,前一个人的设置与草稿不得推成后一个人的。
 * 不记主人、草稿参与同步、登出只清令牌,这几种写法都会让下面的用例变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ url: string; init?: RequestInit }> = [];
let remote: { settings: unknown; clientUpdatedAt: string | null } = { settings: null, clientUpdatedAt: null };

vi.mock('./api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { settings: unknown; clientUpdatedAt: string };
      remote = { settings: body.settings, clientUpdatedAt: body.clientUpdatedAt };
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ success: true, ...remote }) };
  }),
}));

const b64url = (value: string) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (userId: number) => `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ userId, username: `u${userId}` }))}.sig`;

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

const storage = new MemoryStorage();
const puts = () => calls.filter((c) => c.init?.method === 'PUT');

beforeEach(() => {
  storage.clear();
  calls.length = 0;
  remote = { settings: null, clientUpdatedAt: null };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  (globalThis as { atob?: (v: string) => string }).atob = (v: string) => Buffer.from(v, 'base64').toString('binary');
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const load = async () => import('./accountSettings');

describe('accountSettings · 换账号', () => {
  it('ann 的本机偏好与草稿不会被推成 ben 的;ben 以服务端为准,本机草稿被清掉', async () => {
    const { pullAccountSettings, pushAccountSettings } = await load();
    storage.setItem('auth-token', tokenFor(1));
    storage.setItem('claude-settings', '{"skipPermissions":true}');
    storage.setItem('draft_input_session_abc', '内部密码 hunter2');
    await pushAccountSettings();
    expect(storage.getItem('accountSettingsOwner')).toBe('1');
    const pushed = JSON.parse(String(puts()[0].init?.body)) as { settings: { values: Record<string, string> } };
    expect(pushed.settings.values['claude-settings']).toBe('{"skipPermissions":true}');
    expect(Object.keys(pushed.settings.values).some((k) => k.startsWith('draft_input_'))).toBe(false);

    // ann 的令牌过期、ben 直接登录(没走登出)—— 本机时间戳仍是 ann 的、比服务端新
    remote = { settings: { values: { 'claude-settings': '{"skipPermissions":false}' }, updatedAt: '2020-01-01T00:00:00.000Z' }, clientUpdatedAt: '2020-01-01T00:00:00.000Z' };
    calls.length = 0;
    storage.setItem('auth-token', tokenFor(2));
    const changed = await pullAccountSettings();
    expect(puts().length).toBe(0);
    expect(changed).toBe(true);
    expect(storage.getItem('claude-settings')).toBe('{"skipPermissions":false}');
    expect(storage.getItem('draft_input_session_abc')).toBeNull();
    expect(storage.getItem('accountSettingsOwner')).toBe('2');
  });

  it('服务端没有 ben 的记录时也不把 ann 的本机那份推上去', async () => {
    const { pullAccountSettings } = await load();
    storage.setItem('auth-token', tokenFor(1));
    storage.setItem('accountSettingsOwner', '1');
    storage.setItem('codeEditorFontSize', '22');
    storage.setItem('accountSettingsUpdatedAt', new Date().toISOString());
    storage.setItem('auth-token', tokenFor(2));
    await pullAccountSettings();
    expect(puts().length).toBe(0);
    expect(storage.getItem('codeEditorFontSize')).toBeNull();
  });

  it('同一个人:本机更新照旧推上去;远端老记录里的草稿键会被下一次推送整体覆盖', async () => {
    const { pullAccountSettings } = await load();
    storage.setItem('auth-token', tokenFor(1));
    storage.setItem('accountSettingsOwner', '1');
    storage.setItem('uiPreferences', '{"skillSurveyEnabled":false}');
    storage.setItem('accountSettingsUpdatedAt', '2030-01-01T00:00:00.000Z');
    remote = { settings: { values: { uiPreferences: '{}', draft_input_x: '秘密' }, updatedAt: '2020-01-01T00:00:00.000Z' }, clientUpdatedAt: '2020-01-01T00:00:00.000Z' };
    await pullAccountSettings();
    expect(puts().length).toBe(1);
    const values = (remote.settings as { values: Record<string, string> }).values;
    expect(values.uiPreferences).toBe('{"skillSurveyEnabled":false}');
    expect(values.draft_input_x).toBeUndefined();
  });

  it('clearLocalAccountState 清同步键、草稿、时间戳与主人标记,不动 auth-token', async () => {
    const { clearLocalAccountState, ACCOUNT_SYNCED_KEYS } = await load();
    storage.setItem('auth-token', 't');
    for (const key of ACCOUNT_SYNCED_KEYS) storage.setItem(key, 'v');
    storage.setItem('draft_input_p1', 'd');
    storage.setItem('accountSettingsUpdatedAt', 'x');
    storage.setItem('accountSettingsOwner', '1');
    storage.setItem('theme', 'dark');
    clearLocalAccountState();
    expect(storage.getItem('auth-token')).toBe('t');
    expect(storage.getItem('theme')).toBe('dark');
    for (const key of ACCOUNT_SYNCED_KEYS) expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem('draft_input_p1')).toBeNull();
    expect(storage.getItem('accountSettingsUpdatedAt')).toBeNull();
    expect(storage.getItem('accountSettingsOwner')).toBeNull();
  });

  it('登出只清草稿与时间戳;同一个人再登录内容一致 → 不报变化(不整页重载)', async () => {
    const { clearLocalAccountStateOnLogout, pullAccountSettings, pushAccountSettings } = await load();
    storage.setItem('auth-token', tokenFor(1));
    storage.setItem('codeEditorFontSize', '18');
    storage.setItem('draft_input_s1', '草稿');
    await pushAccountSettings();

    storage.removeItem('auth-token');
    clearLocalAccountStateOnLogout();
    expect(storage.getItem('draft_input_s1')).toBeNull();
    expect(storage.getItem('accountSettingsUpdatedAt')).toBeNull();
    expect(storage.getItem('codeEditorFontSize')).toBe('18');
    expect(storage.getItem('accountSettingsOwner')).toBe('1');

    storage.setItem('auth-token', tokenFor(1));
    calls.length = 0;
    // 基线(登出清同步键)这里会返回 true → AppContent 整页重载
    expect(await pullAccountSettings()).toBe(false);
    expect(puts().length).toBe(0);
  });

  it('登出后换人登录,上一个人的同步键仍被清掉且不会推上去', async () => {
    const { clearLocalAccountStateOnLogout, pullAccountSettings } = await load();
    storage.setItem('auth-token', tokenFor(1));
    storage.setItem('accountSettingsOwner', '1');
    storage.setItem('claude-settings', '{"skipPermissions":true}');
    storage.removeItem('auth-token');
    clearLocalAccountStateOnLogout();

    storage.setItem('auth-token', tokenFor(2));
    await pullAccountSettings();
    expect(puts().length).toBe(0);
    expect(storage.getItem('claude-settings')).toBeNull();
    expect(storage.getItem('accountSettingsOwner')).toBe('2');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fetchCredentialLists } from './useCredentialsSettings';

/**
 * API 与凭据页的两张列表:拉失败不能当成空列表。
 *
 * 当成空列表的话界面显示「没有任何 key / 凭据」,临时故障时用户会以为 key 丢了,
 * 去重建或找管理员。失败的一边返回 null(调用方保留旧列表并提示),另一边照常返回。
 */
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const ok = (payload: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => payload });
const fail = (status: number): FakeResponse => ({ ok: false, status, json: async () => ({ error: 'boom' }) });
const html = (): FakeResponse => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });

const apiKey = { id: 'k1', key_name: 'ci', api_key: 'ck_***', created_at: '2026-10-01', last_used: null, is_active: true };
const credential = { id: 'c1', credential_name: 'gh', description: null, created_at: '2026-10-01', is_active: true };

const fetchWith = (routes: Record<string, () => Promise<FakeResponse> | FakeResponse>) =>
  ((url: string) => {
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler();
  }) as unknown as Parameters<typeof fetchCredentialLists>[0];

describe('fetchCredentialLists', () => {
  it('两边都成功:原样返回', async () => {
    const lists = await fetchCredentialLists(fetchWith({
      '/api/settings/api-keys': () => ok({ apiKeys: [apiKey] }),
      '/api/settings/credentials': () => ok({ credentials: [credential] }),
    }));
    expect(lists).toEqual({ apiKeys: [apiKey], githubCredentials: [credential] });
  });

  it('非 2xx:那一边是 null,不是空列表;另一边不受连累', async () => {
    const lists = await fetchCredentialLists(fetchWith({
      '/api/settings/api-keys': () => fail(502),
      '/api/settings/credentials': () => ok({ credentials: [credential] }),
    }));
    expect(lists).toEqual({ apiKeys: null, githubCredentials: [credential] });
  });

  it('响应不是 JSON(反代错误页)也算失败', async () => {
    const lists = await fetchCredentialLists(fetchWith({
      '/api/settings/api-keys': () => ok({ apiKeys: [apiKey] }),
      '/api/settings/credentials': () => html(),
    }));
    expect(lists).toEqual({ apiKeys: [apiKey], githubCredentials: null });
  });

  it('请求抛错(断网;同步抛出也算)只影响自己那一边', async () => {
    const lists = await fetchCredentialLists(fetchWith({
      '/api/settings/api-keys': () => { throw new TypeError('Failed to fetch'); },
      '/api/settings/credentials': () => Promise.reject(new TypeError('Failed to fetch')),
    }));
    expect(lists).toEqual({ apiKeys: null, githubCredentials: null });
  });

  it('成功但真的没有:空列表', async () => {
    const lists = await fetchCredentialLists(fetchWith({
      '/api/settings/api-keys': () => ok({ apiKeys: [] }),
      '/api/settings/credentials': () => ok({ success: true }),
    }));
    expect(lists).toEqual({ apiKeys: [], githubCredentials: [] });
  });
});

/** 组件挂不起来(node 环境),读源码钉住「失败保留旧列表」与「失败不画空态」两根线。 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('API 与凭据页接线', () => {
  it('拉失败的一边保留旧列表,失败标记按 null 判', () => {
    const hook = read('./useCredentialsSettings.ts');
    expect(hook).toMatch(/if \(lists\.apiKeys\) \{\s*setApiKeys\(lists\.apiKeys\);\s*\}/);
    expect(hook).toMatch(/if \(lists\.githubCredentials\) \{\s*setGithubCredentials\(lists\.githubCredentials\);\s*\}/);
    expect(hook).toMatch(/setApiKeysLoadFailed\(lists\.apiKeys === null\);/);
    expect(hook).toMatch(/setGithubCredentialsLoadFailed\(lists\.githubCredentials === null\);/);
  });

  it('加载失败时不画「还没有」空态,改画失败提示和重试按钮', () => {
    const sections: Array<[string, string]> = [
      ['ApiKeysSection', 'apiKeys\\.empty'],
      ['GithubCredentialsSection', 'apiKeys\\.github\\.empty'],
    ];
    for (const [file, emptyKey] of sections) {
      const view = read(`../view/tabs/api-settings/sections/${file}.tsx`);
      expect(view).toMatch(new RegExp(`loadFailed \\? null : <p[^>]*>\\{t\\('${emptyKey}'\\)\\}`));
      expect(view).toMatch(/\{loadFailed && \(/);
      expect(view).toMatch(/onClick=\{onRetryLoad\}/);
    }
    const tab = read('../view/tabs/api-settings/CredentialsSettingsTab.tsx');
    expect(tab).toMatch(/loadFailed=\{apiKeysLoadFailed\}/);
    expect(tab).toMatch(/loadFailed=\{githubCredentialsLoadFailed\}/);
  });
});

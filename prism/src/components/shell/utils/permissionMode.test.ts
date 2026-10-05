import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { readChatPermissionMode } from './permissionMode';

const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

const withStorage = (entries: Record<string, string>) => {
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => (key in entries ? entries[key] : null) },
  };
};

test('hm(A3.3):会话自己的档位优先,其次 provider 最后一次选的,都没有给 default', () => {
  withStorage({ 'permissionMode-s1': 'plan', 'permissionMode-last-claude': 'acceptEdits' });
  assert.equal(readChatPermissionMode('s1'), 'plan');
  assert.equal(readChatPermissionMode('s2'), 'acceptEdits');
  withStorage({});
  assert.equal(readChatPermissionMode('s1'), 'default');
});

test('hm(A3.3):localStorage 不可用(隐私模式 / 服务端)→ default', () => {
  (globalThis as { window?: unknown }).window = undefined;
  assert.equal(readChatPermissionMode('s1'), 'default');
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, uiSettingsDb, userDb } from '@/modules/database/index.js';

/**
 * F11:账号级界面偏好。
 *
 * 权限清单、项目排序、编辑器偏好此前全在 localStorage —— 换台电脑、换个浏览器、
 * 清一次缓存就全部归零。服务端在这里只做**存取**,不解释内容:偏好的形状归前端
 * 管,服务端一旦开始校验字段,加一项偏好就要改两处。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<number> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'ui-settings-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
  return Number(userDb.createUser('alice', 'h').id);
}

describe('账号级界面偏好', () => {
  test('没存过时返回 null,而不是空对象 —— 调用方要能分辨"没设过"和"设成了空"', async () => {
    const alice = await freshDb();
    assert.equal(uiSettingsDb.get(alice), null);
  });

  test('存取往返;再存一次是覆盖不是追加', async () => {
    const alice = await freshDb();
    uiSettingsDb.put(alice, { values: { 'claude-settings': '{"skipPermissions":true}' }, updatedAt: 't1' }, 't1');

    const first = uiSettingsDb.get(alice);
    assert.deepEqual(first?.settings, { values: { 'claude-settings': '{"skipPermissions":true}' }, updatedAt: 't1' });
    assert.equal(first?.clientUpdatedAt, 't1');

    uiSettingsDb.put(alice, { values: { 'file-tree-view-mode': 'compact' }, updatedAt: 't2' }, 't2');
    const second = uiSettingsDb.get(alice);
    assert.deepEqual(second?.settings, { values: { 'file-tree-view-mode': 'compact' }, updatedAt: 't2' });
    assert.equal(second?.clientUpdatedAt, 't2');
  });

  test('两个账号互不干扰', async () => {
    const alice = await freshDb();
    const bob = Number(userDb.createUser('bob', 'h').id);

    uiSettingsDb.put(alice, { values: { a: '1' } }, 't1');
    uiSettingsDb.put(bob, { values: { b: '2' } }, 't1');

    assert.deepEqual(uiSettingsDb.get(alice)?.settings, { values: { a: '1' } });
    assert.deepEqual(uiSettingsDb.get(bob)?.settings, { values: { b: '2' } });
  });

  test('库里存的不是合法 JSON 时当作"没有偏好",而不是让设置页整个报错', async () => {
    const alice = await freshDb();
    const { getConnection } = await import('@/modules/database/index.js');
    getConnection()
      .prepare('INSERT INTO user_ui_settings (user_id, settings_json) VALUES (?, ?)')
      .run(alice, '{ 这不是 JSON');

    assert.equal(uiSettingsDb.get(alice), null);
  });
});

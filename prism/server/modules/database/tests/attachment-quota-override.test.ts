import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { getAttachmentQuotaBytes } from '@/shared/attachment-storage.js';

/**
 * F6:附件配额的每用户覆盖。
 *
 * 之前只有一个全局值(PRISM_ATTACHMENT_QUOTA_MB)。多数账号用不到 1 GB,个别人
 * 要传一堆设计稿 —— 为那一个人抬高全局值,等于给所有人都开了那么大的口子。
 *
 * 关键是**默认不变**:没设过覆盖的账号(以及所有存量账号,列是新加的、值为 NULL)
 * 必须与改动前拿到一模一样的数,否则这就不是加了个旋钮,而是悄悄改了所有人的配额。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
const previousQuota = process.env.PRISM_ATTACHMENT_QUOTA_MB;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousQuota === undefined) delete process.env.PRISM_ATTACHMENT_QUOTA_MB;
  else process.env.PRISM_ATTACHMENT_QUOTA_MB = previousQuota;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'quota-override-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

const MB = 1024 * 1024;

describe('附件配额的每用户覆盖', () => {
  test('没设覆盖时与全局默认逐字节相同(存量账号零影响)', async () => {
    process.env.PRISM_ATTACHMENT_QUOTA_MB = '2048';
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);

    assert.equal(userDb.getAttachmentQuotaMb(alice), null, '新账号不该带覆盖值');
    assert.equal(getAttachmentQuotaBytes(alice), 2048 * MB);
    assert.equal(getAttachmentQuotaBytes(null), 2048 * MB, '匿名调用只看全局值');
  });

  test('设了覆盖就以覆盖为准,清掉后回到全局默认', async () => {
    process.env.PRISM_ATTACHMENT_QUOTA_MB = '2048';
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);

    assert.equal(userDb.setAttachmentQuotaMb(alice, 100), true);
    assert.equal(getAttachmentQuotaBytes(alice), 100 * MB);
    assert.equal(getAttachmentQuotaBytes(bob), 2048 * MB, '覆盖只影响那一个账号');

    assert.equal(userDb.setAttachmentQuotaMb(alice, null), true);
    assert.equal(userDb.getAttachmentQuotaMb(alice), null);
    assert.equal(getAttachmentQuotaBytes(alice), 2048 * MB);
  });

  test('不存在的 id 返回 false —— 路由据此答 404 而不是对着错 id 报成功', async () => {
    await freshDb();
    assert.equal(userDb.setAttachmentQuotaMb(99_999, 100), false);
    assert.equal(userDb.getAttachmentQuotaMb(99_999), null);
  });

  test('0 与负数不被当成"覆盖成 0"(那会让人一个字节都传不了)', async () => {
    process.env.PRISM_ATTACHMENT_QUOTA_MB = '2048';
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);

    userDb.setAttachmentQuotaMb(alice, 0);
    assert.equal(userDb.getAttachmentQuotaMb(alice), null, '0 归一成"没设",回落全局');
    assert.equal(getAttachmentQuotaBytes(alice), 2048 * MB);

    userDb.setAttachmentQuotaMb(alice, -5);
    assert.equal(getAttachmentQuotaBytes(alice), 2048 * MB);
  });
});

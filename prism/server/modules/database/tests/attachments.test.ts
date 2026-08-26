import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  attachmentsDb,
  closeConnection,
  getConnection,
  initializeDatabase,
} from '@/modules/database/index.js';

async function withIsolatedDatabase(runTest: (dir: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'attachments-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** 造一个真实文件并记一笔台账,返回路径。 */
function seed(dir: string, name: string, bytes: number, userId: number | null): string {
  const absPath = path.join(dir, name);
  fs.writeFileSync(absPath, 'x'.repeat(bytes));
  attachmentsDb.record({
    userId, sessionId: 's1', projectPath: dir, kind: 'file', absPath, bytes,
  });
  return absPath;
}

function backdate(absPath: string, days: number): void {
  getConnection()
    .prepare("UPDATE attachments SET created_at = datetime('now', ?) WHERE abs_path = ?")
    .run(`-${days} days`, absPath);
}

describe('附件台账', () => {
  it('按用户汇总占用', async () => {
    await withIsolatedDatabase((dir) => {
      seed(dir, 'a.bin', 100, 1);
      seed(dir, 'b.bin', 250, 1);
      seed(dir, 'c.bin', 999, 2);
      expect(attachmentsDb.totalBytesForUser(1)).toBe(350);
      expect(attachmentsDb.totalBytesForUser(2)).toBe(999);
      expect(attachmentsDb.totalBytesForUser(3)).toBe(0);
      // 拿不到用户时回 0 —— 配额检查据此放行,不能因为身份缺失就把上传堵死
      expect(attachmentsDb.totalBytesForUser(null)).toBe(0);
    });
  });

  it('同一个路径重复记账不会长出第二行', async () => {
    await withIsolatedDatabase((dir) => {
      const p = seed(dir, 'dup.bin', 100, 1);
      attachmentsDb.record({ userId: 1, sessionId: 's2', projectPath: dir, kind: 'file', absPath: p, bytes: 400 });
      expect(attachmentsDb.totalBytesForUser(1)).toBe(400);
    });
  });

  it('只清过期的,没到期的不动', async () => {
    await withIsolatedDatabase((dir) => {
      const old = seed(dir, 'old.bin', 100, 1);
      const fresh = seed(dir, 'fresh.bin', 100, 1);
      backdate(old, 40);

      const result = attachmentsDb.sweepExpired(30);
      expect(result.removed).toBe(1);
      expect(result.bytes).toBe(100);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(attachmentsDb.totalBytesForUser(1)).toBe(100);
    });
  });

  /**
   * 这条是整个清理机制的安全底线。
   *
   * `attachments/` 在文件树里是**明放**的,用户自己也会往里放东西。清理必须
   * 只认台账 —— 扫目录做不到这个区分,会连人家的文件一起删。
   */
  it('用户自己放进目录的文件一个都不碰', async () => {
    await withIsolatedDatabase((dir) => {
      const mine = seed(dir, 'recorded.bin', 100, 1);
      backdate(mine, 40);
      const theirs = path.join(dir, '我自己放的.txt');
      fs.writeFileSync(theirs, 'user content');
      // 顺手把 .gitignore 也放进去,它同样不该被碰
      const ignore = path.join(dir, '.gitignore');
      fs.writeFileSync(ignore, '*\n');

      attachmentsDb.sweepExpired(30);

      expect(fs.existsSync(mine)).toBe(false);
      expect(fs.existsSync(theirs)).toBe(true);
      expect(fs.existsSync(ignore)).toBe(true);
    });
  });

  it('文件已经被用户删掉时,台账行也要收走 —— 否则它会一直占着配额', async () => {
    await withIsolatedDatabase((dir) => {
      const gone = seed(dir, 'gone.bin', 500, 1);
      backdate(gone, 40);
      fs.rmSync(gone);
      expect(attachmentsDb.totalBytesForUser(1)).toBe(500);

      attachmentsDb.sweepExpired(30);
      expect(attachmentsDb.totalBytesForUser(1)).toBe(0);
    });
  });

  it('TTL 非法时不做任何清理', async () => {
    await withIsolatedDatabase((dir) => {
      const p = seed(dir, 'keep.bin', 100, 1);
      backdate(p, 999);
      for (const ttl of [0, -1, Number.NaN]) {
        expect(attachmentsDb.sweepExpired(ttl)).toEqual({ removed: 0, bytes: 0 });
      }
      expect(fs.existsSync(p)).toBe(true);
    });
  });
});

describe('forgetUnder', () => {
  it('按目录前缀删台账,不误伤兄弟目录', async () => {
    await withIsolatedDatabase((dir) => {
      const fs = require('node:fs');
      const path = require('node:path');
      const sub = path.join(dir, 'attachments');
      const sibling = path.join(dir, 'attachments-old');
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      const a = path.join(sub, 'a.png');
      const b = path.join(sub, 'b.png');
      const other = path.join(sibling, 'c.png');
      for (const f of [a, b, other]) fs.writeFileSync(f, 'x');
      for (const f of [a, b, other]) {
        attachmentsDb.record({ userId: 1, sessionId: null, projectPath: dir, kind: 'file', absPath: f, bytes: 10 });
      }
      expect(attachmentsDb.totalBytesForUser(1)).toBe(30);

      attachmentsDb.forgetUnder(sub);

      // sub 下两行没了,兄弟目录 attachments-old 的那行还在(前缀补了分隔符,不误伤)
      expect(attachmentsDb.totalBytesForUser(1)).toBe(10);
    });
  });
});

describe('commitAttachmentWithinQuota', () => {
  it('配额内正常记账;超配额不记账并回 reason=quota', async () => {
    const prev = process.env.PRISM_ATTACHMENT_QUOTA_MB;
    process.env.PRISM_ATTACHMENT_QUOTA_MB = '1'; // 1MB
    try {
      await withIsolatedDatabase(async (dir) => {
        const path = require('node:path');
        const { commitAttachmentWithinQuota } = await import('@/shared/attachment-storage.js');

        const ok = commitAttachmentWithinQuota({
          userId: 1, sessionId: null, projectPath: dir, kind: 'file',
          absPath: path.join(dir, 'a.bin'), bytes: 600 * 1024,
        });
        expect(ok.ok).toBe(true);
        expect(attachmentsDb.totalBytesForUser(1)).toBe(600 * 1024);

        // 再来 600KB,合计 1.17MB 超 1MB → 拒,且不入账
        const bad = commitAttachmentWithinQuota({
          userId: 1, sessionId: null, projectPath: dir, kind: 'file',
          absPath: path.join(dir, 'b.bin'), bytes: 600 * 1024,
        });
        expect(bad.ok).toBe(false);
        expect(bad.reason).toBe('quota');
        expect(attachmentsDb.totalBytesForUser(1)).toBe(600 * 1024); // 没变

        // 拿不到 userId 一律放行(不因身份缺失堵上传)
        const anon = commitAttachmentWithinQuota({
          userId: null, sessionId: null, projectPath: dir, kind: 'file',
          absPath: path.join(dir, 'c.bin'), bytes: 999 * 1024 * 1024,
        });
        expect(anon.ok).toBe(true);
      });
    } finally {
      if (prev === undefined) delete process.env.PRISM_ATTACHMENT_QUOTA_MB;
      else process.env.PRISM_ATTACHMENT_QUOTA_MB = prev;
    }
  });
});

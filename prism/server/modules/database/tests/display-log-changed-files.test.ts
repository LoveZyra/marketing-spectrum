import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let closeConnection: () => void;
let tempDir: string;

/**
 * dr:changed_files 帧现在落显示日志(工作面板认非 Write 写盘靠它),
 * 但必须**剥掉 diff** —— 单文件 diff 上限 20KB,留着日志会白胖几个量级。
 */
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-changed-files-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  const db = await import('@/modules/database/index.js');
  sessionMessagesDb = db.sessionMessagesDb;
  closeConnection = db.closeConnection;
  db.initializeDatabase();
});

afterAll(() => {
  try { closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('changed_files 落显示日志', () => {
  it('落库且逐文件剥 diff,其余字段(含 cwd/checkpointId)原样保留', () => {
    const SESSION = 'sess_changed_files';
    const appended = sessionMessagesDb.append(SESSION, {
      id: 'cf_1',
      sessionId: SESSION,
      kind: 'changed_files',
      timestamp: '2026-08-31T12:00:00.000Z',
      provider: 'claude',
      checkpointId: 'cp-x',
      cwd: '/home/ubuntu/demo',
      truncated: false,
      files: [
        {
          path: 'users.csv',
          status: 'added',
          untracked: true,
          additions: 100,
          deletions: 0,
          diff: 'x'.repeat(20_000),
          diffTruncated: true,
          revertible: true,
        },
      ],
    } as never);
    expect(appended).toBe(true);

    const rows = sessionMessagesDb.listForSession(SESSION);
    expect(rows).toHaveLength(1);
    const row = rows[0] as unknown as {
      kind: string; cwd?: string; checkpointId?: string;
      files: Array<Record<string, unknown>>;
    };
    expect(row.kind).toBe('changed_files');
    expect(row.cwd).toBe('/home/ubuntu/demo');
    expect(row.checkpointId).toBe('cp-x');
    expect(row.files[0].path).toBe('users.csv');
    expect(row.files[0].untracked).toBe(true);
    expect(row.files[0].additions).toBe(100);
    expect(row.files[0]).not.toHaveProperty('diff');
    expect(row.files[0]).not.toHaveProperty('diffTruncated');
    // 落库行确实小:整行 JSON 不该带着那 20KB
    expect(JSON.stringify(row).length).toBeLessThan(1000);
  });
});

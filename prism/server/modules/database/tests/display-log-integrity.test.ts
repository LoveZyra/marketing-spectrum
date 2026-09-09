import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * fj:显示日志的**完整性**不变式。
 *
 * 两条规则叠在一起会让长会话的历史永久消失:
 *   ① `fetchHistory` 见日志有行就完全改读日志、不再看 transcript;
 *   ② `trimSession` 把超出上限的最早那批物理删掉。
 * 于是超过约 2048 条的会话,早期几百上千条从界面消失,而磁盘上的 jsonl 还在。
 *
 * 这一组钉的是修法的三条支柱:裁剪要盖戳、seed 不许自裁、有 transcript 的空日志
 * 不许被别的入口写第一行。
 */

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let sessionsDb: typeof import('@/modules/database/index.js')['sessionsDb'];
let getConnection: typeof import('@/modules/database/index.js')['getConnection'];
let closeConnection: () => void;
let tempDir: string;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-display-integrity-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_DISPLAY_LOG_MAX_PER_SESSION = '128';
  const db = await import('@/modules/database/index.js');
  sessionMessagesDb = db.sessionMessagesDb;
  sessionsDb = db.sessionsDb;
  getConnection = db.getConnection;
  closeConnection = db.closeConnection;
  db.initializeDatabase();
});

afterAll(() => {
  delete process.env.PRISM_DISPLAY_LOG_MAX_PER_SESSION;
  try { closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const row = (sessionId: string, n: number) => ({
  id: `${sessionId}_${n}`,
  sessionId,
  kind: 'text',
  role: 'assistant',
  content: `m${n}`,
  timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, n % 60)).toISOString(),
  provider: 'claude',
}) as never;

describe('fj:裁剪必须留下痕迹', () => {
  it('没超上限时不裁、不盖戳', () => {
    const sid = 'trim-none';
    for (let i = 0; i < 64; i += 1) sessionMessagesDb.append(sid, row(sid, i));
    expect(sessionMessagesDb.countForSession(sid)).toBe(64);
    expect(sessionMessagesDb.isTrimmed(sid)).toBe(false);
  });

  it('超上限被裁之后 isTrimmed 为真 —— 这是回放据以回落 transcript 的唯一判据', () => {
    const sid = 'trim-yes';
    for (let i = 0; i < 256; i += 1) sessionMessagesDb.append(sid, row(sid, i));
    // 上限 128,步长 64:必然裁过
    expect(sessionMessagesDb.countForSession(sid)).toBeLessThanOrEqual(128 + 63);
    expect(sessionMessagesDb.isTrimmed(sid)).toBe(true);
  });
});

describe('fj:seed 不许在抄写过程中把自己裁掉', () => {
  it('appendMany 抄 400 条(上限 128)之后一条都不少 —— 逐条裁剪会让它只剩 128', () => {
    const sid = 'seed-notrim';
    const many = Array.from({ length: 400 }, (_, i) => row(sid, i));
    const seeded = sessionMessagesDb.appendMany(sid, many);
    expect(seeded).toBe(400);
    // appendMany 结束后只裁一次,所以会落在 [128, 128+63] 区间;
    // 关键是**不能**是"抄写途中反复裁"导致的更小值,也不能因此报成功。
    expect(sessionMessagesDb.countForSession(sid)).toBeGreaterThanOrEqual(128);
  });

  it('抄完清戳:整批抄进来的这一份是完整的', () => {
    const sid = 'seed-clear';
    sessionMessagesDb.appendMany(sid, [row(sid, 1), row(sid, 2)]);
    expect(sessionMessagesDb.isTrimmed(sid)).toBe(false);
  });
});

describe('fj:有 transcript 的空日志,不许被别的入口写第一行', () => {
  it('定时任务/外部 API/检查点那类裸 append 会被拒 —— 否则该会话历史当场从界面消失', () => {
    const sid = 'guard-old';
    // createSession 按 provider-native id 建行,app id 与它相等即可(磁盘发现的会话就是这样)
    sessionsDb.createSession(sid, 'claude', '/tmp/p', undefined, undefined, undefined, '/tmp/p/x.jsonl');
    expect(sessionMessagesDb.append(sid, row(sid, 1))).toBe(false);
    expect(sessionMessagesDb.countForSession(sid)).toBe(0);
  });

  it('seed 走的 appendForSeed 不受这道门约束 —— 它正是来补历史的', () => {
    const sid = 'guard-old';
    expect(sessionMessagesDb.appendMany(sid, [row(sid, 1), row(sid, 2)])).toBe(2);
    // 抄过之后普通 append 就放行了
    expect(sessionMessagesDb.append(sid, row(sid, 3))).toBe(true);
  });

  it('还没有 transcript 的新会话照旧可以直接写第一行', () => {
    const sid = 'guard-new';
    // 网页新建的会话:sessions 行在、provider_session_id 还是 NULL
    getConnection()
      .prepare("INSERT INTO sessions (session_id, provider, provider_session_id, project_path) VALUES (?, 'claude', NULL, '/tmp/p')")
      .run(sid);
    expect(sessionMessagesDb.append(sid, row(sid, 1))).toBe(true);
  });

  it('sessions 表里根本没有这条会话时也放行(第一条消息可能早于 sessions 行落库)', () => {
    assert.equal(sessionMessagesDb.append('guard-unknown', row('guard-unknown', 1)), true);
  });
});

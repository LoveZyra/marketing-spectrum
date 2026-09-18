import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

/**
 * **压缩不许动时间轴。**
 *
 * gt 把压缩交还给 CLI 之后,压缩从「Prism 的 internal 维护回合」变成「用户回合内部
 * 由 CLI 自己做」。第一反应是担心:会话的时间轴会不会因此被截断?
 *
 * 结论是不会,而且理由是结构性的 —— 时间轴读的是 Prism 自己的
 * `session_display_messages`(`sessions.service.ts` 里 `logIsAuthoritative` 那道判据),
 * 而压缩相关的帧**根本进不了这张表**:
 *   · `normalizeMessage` 对 `type:'system'` 产出 0 条(压根没有 system 分支);
 *   · `status` 不在 `DURABLE_KINDS` 白名单里,`append` 直接 return false。
 *
 * 问题是这个不变量**此前一条测试都没有** —— 结构上成立,但没人钉住。
 * 这一类"靠结构成立、没有判据"的地方,正是下一次改动最容易踩塌的。钉在这里。
 */

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let isDurableDisplayMessage: typeof import('@/modules/database/index.js')['isDurableDisplayMessage'];
let closeConnection: () => void;
let tempDir: string;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-compact-timeline-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  const db = await import('@/modules/database/index.js');
  sessionMessagesDb = db.sessionMessagesDb;
  isDurableDisplayMessage = db.isDurableDisplayMessage;
  closeConnection = db.closeConnection;
  db.initializeDatabase();
});

afterAll(() => {
  try { closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SESSION = 'compact-timeline-session';

const text = (id: string, content: string) => ({
  id,
  sessionId: SESSION,
  kind: 'text',
  role: 'assistant',
  content,
  timestamp: '2026-09-15T10:00:00.000Z',
  provider: 'claude',
}) as never;

/** Prism 造给界面的压缩状态帧(createCompactionStatus 的形状)。 */
const compactingStatus = () => ({
  id: 'compact-status-1',
  sessionId: SESSION,
  kind: 'status',
  statusKind: 'compacting',
  text: 'Context at 83% — compacting…',
  timestamp: '2026-09-15T10:00:01.000Z',
  provider: 'claude',
}) as never;

describe('压缩不动时间轴', () => {
  it('压缩状态帧不是 durable —— 进不了显示日志', () => {
    assert.equal(isDurableDisplayMessage({ kind: 'status' } as never), false);
    assert.equal(isDurableDisplayMessage(compactingStatus()), false);
  });

  it('**关键**:一轮压缩前后,显示日志的行数与内容一个字不变', () => {
    sessionMessagesDb.append(SESSION, text('m1', '压缩之前的第一条'));
    sessionMessagesDb.append(SESSION, text('m2', '压缩之前的第二条'));
    const before = sessionMessagesDb.countForSession(SESSION);
    assert.equal(before, 2, '前置条件:两条正文已落库');

    // 模拟一轮压缩:状态帧 + 结束帧,都往 append 里喂一遍
    sessionMessagesDb.append(SESSION, compactingStatus());
    sessionMessagesDb.append(SESSION, {
      ...(compactingStatus() as Record<string, unknown>),
      id: 'compact-status-2',
      text: 'compact done',
    } as never);

    assert.equal(
      sessionMessagesDb.countForSession(SESSION),
      before,
      '压缩往显示日志里写东西了 —— 时间轴会多出噪音,而且是不可回放的瞬时态'
    );

    // 压缩之后继续说话,历史要接得上,不是从头开始
    sessionMessagesDb.append(SESSION, text('m3', '压缩之后的一条'));
    assert.equal(sessionMessagesDb.countForSession(SESSION), before + 1);
  });

  it('**关键**:压缩不会删掉任何既有行(时间轴不被截断)', () => {
    const rows = sessionMessagesDb.listForSession(SESSION) as Array<Record<string, unknown>>;
    const contents = rows.map((row) => String((row as { content?: unknown }).content ?? ''));
    assert.ok(contents.some((c) => c.includes('压缩之前的第一条')), '压缩前的历史被截断了');
    assert.ok(contents.some((c) => c.includes('压缩之前的第二条')), '压缩前的历史被截断了');
    assert.ok(contents.some((c) => c.includes('压缩之后的一条')));
  });

  it('未被裁剪的日志仍然是权威源 —— 不会因为压缩回落去读 transcript', () => {
    // `logIsAuthoritative` 的两个输入:有行 && 没被裁剪。压缩两个都不碰。
    assert.ok(sessionMessagesDb.countForSession(SESSION) > 0);
    assert.equal(sessionMessagesDb.isTrimmed(SESSION), false, '压缩不该把日志标成裁剪过');
  });
});

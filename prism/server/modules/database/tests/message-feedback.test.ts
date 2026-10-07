import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  closeConnection, getConnection, initializeDatabase, messageFeedbackDb, sessionTrashDb, sessionsDb, userDb,
} from '@/modules/database/index.js';

/**
 * 用户反馈表(赞 / 踩与效果调查卡),技能优化的数据源。
 *
 * 钉三件事:一人一条回答只有一行(改票是 upsert,不留历史);调查卡「跳过」留行但
 * verdict 为空、不进"好/一般/差"统计;会话进回收站反馈不动、彻底清扫时随行删掉。
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

async function freshDb(): Promise<{ alice: number; bob: number }> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'message-feedback-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
  return {
    alice: Number(userDb.createUser('alice', 'h').id),
    bob: Number(userDb.createUser('bob', 'h').id),
  };
}

const MSG = '0f3b2c1a-1111-4222-8333-444455556666_text';

describe('message_feedback', () => {
  test('同一人同一条回答:改票是 upsert,一行到底;verdict 与 uuid 反推正确', async () => {
    const { alice } = await freshDb();
    const first = messageFeedbackDb.upsert({
      sessionId: 's1', projectId: 'p1', messageId: MSG, userId: alice,
      source: 'vote', verdict: -1, status: 'answered', category: '结果错误',
      note: '少一列', expectedOutput: '小红书单列', skillHint: 'marketing-audit',
    });
    assert.equal(first.verdict, -1);
    assert.equal(first.message_uuid, '0f3b2c1a-1111-4222-8333-444455556666');
    const second = messageFeedbackDb.upsert({
      sessionId: 's1', projectId: 'p1', messageId: MSG, userId: alice,
      source: 'vote', verdict: 1, status: 'answered',
    });
    assert.equal(second.id, first.id, '改票不该开新行');
    assert.equal(second.verdict, 1);
    assert.equal(second.note, null, '改成 👍 后旧说明清掉');
    assert.equal(second.skill_hint, 'marketing-audit', 'skill 未传时沿用旧值');
    assert.equal(messageFeedbackDb.listForSessionAndUser('s1', alice).length, 1);
  });

  test('调查卡「跳过」留行、verdict 为空,不进好/一般/差,但算进弹出数', async () => {
    const { alice, bob } = await freshDb();
    messageFeedbackDb.upsert({ sessionId: 's1', projectId: 'p1', messageId: MSG, userId: alice,
      source: 'survey', verdict: 0, status: 'answered', note: '表格少了渠道列', skillHint: 'marketing-audit' });
    messageFeedbackDb.upsert({ sessionId: 's2', projectId: 'p2', messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee_text', userId: bob,
      source: 'survey', verdict: 7, status: 'dismissed', skillHint: 'marketing-audit' });
    messageFeedbackDb.upsert({ sessionId: 's3', projectId: 'p1', messageId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee_text', userId: bob,
      source: 'vote', verdict: 1, status: 'answered', skillHint: 'marketing-audit' });
    const dismissed = messageFeedbackDb.get('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee_text', bob);
    assert.equal(dismissed?.verdict, null, 'dismissed 行 verdict 必须为空');
    const stats = messageFeedbackDb.statsBySkill('marketing-audit');
    assert.deepEqual(
      { shown: stats.shown, answered: stats.answered, votes: stats.votes, good: stats.good, neutral: stats.neutral, bad: stats.bad, projects: stats.projects, users: stats.users },
      { shown: 2, answered: 1, votes: 1, good: 1, neutral: 1, bad: 0, projects: 2, users: 2 },
    );
    assert.equal(stats.recentNotes[0]?.note, '表格少了渠道列');
    assert.ok(messageFeedbackDb.lastSurveyAt(alice, 'marketing-audit'));
    assert.equal(messageFeedbackDb.lastSurveyAt(alice, 'onesql'), null);
    assert.deepEqual(messageFeedbackDb.skillsWithFeedback(), ['marketing-audit']);
  });

  test('删除:remove 只删自己那票;会话彻底清扫时随行删掉', async () => {
    const { alice, bob } = await freshDb();
    sessionsDb.createAppSession('s1', 'claude', '/tmp/p', alice);
    messageFeedbackDb.upsert({ sessionId: 's1', projectId: 'p1', messageId: MSG, userId: alice, source: 'vote', verdict: 1, status: 'answered' });
    messageFeedbackDb.upsert({ sessionId: 's1', projectId: 'p1', messageId: MSG, userId: bob, source: 'vote', verdict: -1, status: 'answered' });
    assert.equal(messageFeedbackDb.remove(MSG, alice), true);
    assert.equal(messageFeedbackDb.remove(MSG, alice), false);
    assert.equal(messageFeedbackDb.get(MSG, bob)?.verdict, -1, '别人的票不受影响');
    // 直接走 purge 的 SQL 路径(sessionTrashDb.purge 只在行存在于回收站时才动手)
    assert.equal(messageFeedbackDb.deleteForSession('s1'), 1);
    assert.equal(messageFeedbackDb.get(MSG, bob), null);
    // 回收站清扫同样带走反馈
    messageFeedbackDb.upsert({ sessionId: 's1', projectId: 'p1', messageId: MSG, userId: bob, source: 'vote', verdict: -1, status: 'answered' });
    getConnection().prepare(`INSERT INTO session_trash (session_id, provider, project_path, deleted_at) VALUES ('s1', 'claude', '/tmp/p', CURRENT_TIMESTAMP)`).run();
    sessionTrashDb.purge('s1');
    assert.equal(messageFeedbackDb.get(MSG, bob), null, '彻底清扫后反馈应随行删除');
  });
});

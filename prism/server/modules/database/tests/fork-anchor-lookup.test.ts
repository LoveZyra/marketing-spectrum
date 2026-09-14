import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let closeConnection: () => void;
let tempDir: string;

/**
 * fy(F14):「编辑重跑」的分叉锚点从显示日志里查,不再解析消息 id 的形状。
 *
 * 病灶:实时对话里用户气泡的 id 是 `user_<随机 uuid>` —— 前缀不是 uuid,
 * 反推不出原生 uuid,扫 jsonl 那条路从一开始就走不通(fp 把静默降级改成了
 * 明确 409,但仍然做不成)。用户说的那句话没有出站 SDK 帧,写它的时候手里
 * 确实没有 uuid;而 assistant 帧有,所以改成"assistant 行落库时记下自己的
 * uuid,查的时候按日志顺序往回取第一条"。
 */
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-fork-anchor-'));
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

const UUID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
/** tool_result 在 jsonl 里是一条独立的 **user** 记录,uuid 与它对应的 tool_use 不同。 */
const UUID_C = 'cccccccc-3333-4333-8333-cccccccccccc';
/** 从 transcript 抄回来的用户消息:id 是 uuid 形状,但它是 user 记录。 */
const UUID_D = 'dddddddd-4444-4444-8444-dddddddddddd';

const row = (over: Record<string, unknown>) => ({
  sessionId: 'S',
  provider: 'claude',
  timestamp: new Date().toISOString(),
  ...over,
}) as never;

describe('sessionMessagesDb.forkAnchorFor', () => {
  const SESSION = 'sess_fork_anchor';

  beforeAll(() => {
    // 一段真实形状的历史:
    //   用户问 → 助手答(A) → 用户又问 → 助手答(B) → 用户第三次问
    sessionMessagesDb.append(SESSION, row({ id: 'user_q1', kind: 'text', role: 'user', content: '问题一' }));
    sessionMessagesDb.append(SESSION, row({ id: `${UUID_A}_text`, kind: 'text', role: 'assistant', content: '回答一' }));
    sessionMessagesDb.append(SESSION, row({ id: 'user_q2', kind: 'text', role: 'user', content: '问题二' }));
    sessionMessagesDb.append(SESSION, row({ id: `${UUID_B}_0`, kind: 'tool_use', toolName: 'Bash', content: '' }));
    sessionMessagesDb.append(SESSION, row({ id: `${UUID_C}_tr_toolu_1`, kind: 'tool_result', content: 'ok' }));
    sessionMessagesDb.append(SESSION, row({ id: UUID_D, kind: 'text', role: 'user', content: '抄回来的用户消息' }));
    sessionMessagesDb.append(SESSION, row({ id: 'user_q3', kind: 'text', role: 'user', content: '问题三' }));
  });

  it('**用户气泡拿得到锚点了** —— 这就是 F14 修好的那一半', () => {
    // 第二个问题之前最后一个 assistant 是回答一
    expect(sessionMessagesDb.forkAnchorFor(SESSION, 'user_q2')).toBe(UUID_A);
  });

  it('往回找的是**最近**那一个,不是第一个', () => {
    // 第三个问题之前最后一个 assistant 侧的行是那次 tool_use(B)
    expect(sessionMessagesDb.forkAnchorFor(SESSION, 'user_q3')).toBe(UUID_B);
  });

  it('**tool_result 与 user 正文都不当锚点**(它们在 jsonl 里是 user 记录)', () => {
    // q3 上面紧挨着的两行是「抄回来的用户消息」(uuid 形状)和 tool_result,
    // 两者的 uuid 都不是 assistant 的 —— 拿去 resumeSessionAt 会被 SDK 拒掉。
    const anchor = sessionMessagesDb.forkAnchorFor(SESSION, 'user_q3');
    expect(anchor).not.toBe(UUID_C);
    expect(anchor).not.toBe(UUID_D);
    expect(anchor).toBe(UUID_B);
  });

  it('会话的第一句 → `null`(有这一行,但它之前没有回答)', () => {
    expect(sessionMessagesDb.forkAnchorFor(SESSION, 'user_q1')).toBeNull();
  });

  it('**日志里没有这一行 → `undefined`**,调用方据此退回扫 jsonl,而不是当成没锚点', () => {
    expect(sessionMessagesDb.forkAnchorFor(SESSION, 'user_不存在')).toBeUndefined();
    expect(sessionMessagesDb.forkAnchorFor('sess_没有这条会话', 'user_q2')).toBeUndefined();
    expect(sessionMessagesDb.forkAnchorFor('', 'user_q2')).toBeUndefined();
    expect(sessionMessagesDb.forkAnchorFor(SESSION, '')).toBeUndefined();
  });

  it('锚点按会话隔离 —— 别的会话的 assistant 行不算数', () => {
    const OTHER = 'sess_fork_anchor_other';
    sessionMessagesDb.append(OTHER, row({ id: 'user_only', kind: 'text', role: 'user', content: '只有一句' }));
    expect(sessionMessagesDb.forkAnchorFor(OTHER, 'user_only')).toBeNull();
  });
});

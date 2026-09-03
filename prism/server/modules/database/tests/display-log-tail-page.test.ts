import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sliceTailPage } from '@/shared/utils.js';

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let closeConnection: () => void;
let tempDir: string;

/**
 * dn-O1 回归:SQL 尾页(listTailPage)与「整段读出 + sliceTailPage」逐字节同义。
 * 分页语义只有一份,两条实现必须在任何 (limit, offset) 上给出同一页。
 */
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-tail-page-'));
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

const SESSION = 'sess_tail_page';
const TOTAL = 37;

const seedMessage = (index: number) => ({
  id: `m_${String(index).padStart(3, '0')}`,
  sessionId: SESSION,
  kind: 'text',
  role: 'assistant',
  content: `第 ${index} 条`,
  timestamp: new Date(Date.UTC(2026, 7, 20, 10, 0, index)).toISOString(),
  provider: 'claude',
}) as never;

describe('sessionMessagesDb.listTailPage', () => {
  it('matches sliceTailPage(listForSession) for every (limit, offset) combination probed', () => {
    for (let index = 0; index < TOTAL; index += 1) {
      sessionMessagesDb.append(SESSION, seedMessage(index));
    }

    const full = sessionMessagesDb.listForSession(SESSION);
    expect(full).toHaveLength(TOTAL);

    const combos: Array<[number, number]> = [
      [20, 0], [20, 20], [20, 40],      // 常规翻页,含越界
      [1, 0], [1, TOTAL - 1], [1, TOTAL],
      [TOTAL, 0], [100, 0], [100, 5],   // limit 超过总量
      [0, 0], [5, 3], [10, 30],
    ];

    for (const [limit, offset] of combos) {
      const reference = sliceTailPage(full, limit, offset);
      const paged = sessionMessagesDb.listTailPage(SESSION, limit, offset);
      expect(paged.total, `total@${limit}/${offset}`).toBe(TOTAL);
      expect(paged.hasMore, `hasMore@${limit}/${offset}`).toBe(reference.hasMore);
      expect(
        paged.messages.map((message) => message.id),
        `page@${limit}/${offset}`,
      ).toEqual(reference.page.map((message) => (message as { id: string }).id));
    }
  });

  it('serves the tail correctly right after an append invalidates the parsed cache', () => {
    // 先命中一次缓存,再追加一条打穿它 —— SQL 路径必须直接给出新尾页。
    sessionMessagesDb.listForSession(SESSION);
    sessionMessagesDb.append(SESSION, seedMessage(TOTAL));

    const page = sessionMessagesDb.listTailPage(SESSION, 3, 0);
    expect(page.total).toBe(TOTAL + 1);
    expect(page.messages.map((message) => message.id)).toEqual([
      `m_${String(TOTAL - 2).padStart(3, '0')}`,
      `m_${String(TOTAL - 1).padStart(3, '0')}`,
      `m_${String(TOTAL).padStart(3, '0')}`,
    ]);
    expect(page.hasMore).toBe(true);
  });

  it('returns an empty page for an unknown session', () => {
    const page = sessionMessagesDb.listTailPage('sess_nonexistent', 20, 0);
    expect(page).toEqual({ messages: [], total: 0, hasMore: false });
  });
});

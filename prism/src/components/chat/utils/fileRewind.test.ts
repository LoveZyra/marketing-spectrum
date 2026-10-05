import { describe, expect, it } from 'vitest';

import { fileRewindTurns } from './fileRewind';

const row = (extra: Record<string, unknown>) => ({ id: String(Math.random()), sessionId: 's', timestamp: '2026-10-01T00:00:00Z', provider: 'claude', kind: 'text', role: 'user', content: 'hi', ...extra }) as never;

describe('ho(hq-2) 文件回退的轮次', () => {
  it('只取带 turnUuid、没被撤回的用户行,新的在前,去重', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const turns = fileRewindTurns([
      row({ turnUuid: a, content: '第一轮' }),
      row({ role: 'assistant', turnUuid: b }),
      row({ turnUuid: 'not-a-uuid' }),
      row({ content: '本地回声,没有 turnUuid' }),
      row({ turnUuid: b, content: '第二轮' }),
      row({ turnUuid: b, content: '重复' }),
      row({ turnUuid: '33333333-3333-4333-8333-333333333333', withdrawn: true }),
    ]);
    expect(turns.map((turn) => turn.prompt)).toEqual(['第二轮', '第一轮']);
    expect(fileRewindTurns(null)).toEqual([]);
  });
});

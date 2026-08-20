import assert from 'node:assert/strict';

import { describe, expect, it, test } from 'vitest';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  isInternalContent,
  nonHumanUserTurnReason,
  stripInjectedBlocks,
} from '@/modules/providers/list/claude/transcript-provenance.js';

const SESSION_ID = 'session-1';

function userRow(extra: Record<string, unknown>, content: unknown = 'hello there') {
  return {
    uuid: 'u1',
    timestamp: '2026-08-20T10:00:00.000Z',
    type: 'user',
    message: { role: 'user', content },
    ...extra,
  };
}

function bubbles(entry: unknown) {
  return new ClaudeSessionsProvider()
    .normalizeMessage(entry, SESSION_ID)
    .filter((m) => m.kind === 'text' && m.role === 'user');
}

describe('nonHumanUserTurnReason', () => {
  it('没有任何出处线索时按"人发的"处理 —— 老 transcript 里真正的用户消息就是这样', () => {
    expect(nonHumanUserTurnReason({ type: 'user' })).toBe(null);
  });

  it('origin.kind === human 是人发的', () => {
    expect(nonHumanUserTurnReason({ origin: { kind: 'human' } })).toBe(null);
  });

  it.each([
    [{ isMeta: true }, 'meta'],
    [{ isSidechain: true }, 'sidechain'],
    [{ isSynthetic: true }, 'synthetic'],
    [{ isVisibleInTranscriptOnly: true }, 'transcript-only'],
    [{ parent_tool_use_id: 'toolu_123' }, 'subagent-frame'],
    [{ parentToolUseId: 'toolu_123' }, 'subagent-frame'],
    [{ subagent_type: 'general-purpose' }, 'subagent-type'],
    [{ userType: 'agent' }, 'agent-user-type'],
    [{ sourceToolUseID: 'toolu_01SKILL' }, 'tool-authored'],
    [{ turnCompanion: true }, 'turn-companion'],
    [{ origin: { kind: 'auto-continuation' } }, 'origin:auto-continuation'],
    [{ origin: 'task-notification' }, 'origin:task-notification'],
  ])('%o 判为非人类回合', (row, reason) => {
    expect(nonHumanUserTurnReason(row)).toBe(reason);
  });

  it('parent_tool_use_id 为 null(主线程回合)不算子代理帧', () => {
    expect(nonHumanUserTurnReason({ parent_tool_use_id: null })).toBe(null);
  });

  it('普通 tool_result 行带的是 sourceToolAssistantUUID,不能被误判', () => {
    // 实测:本会话 362 行工具结果全带这个字段,而技能注入带的是 sourceToolUseID。
    // 两个字段名只差几个字母,判错就等于把所有工具结果一起吃掉。
    expect(nonHumanUserTurnReason({ sourceToolAssistantUUID: 'a1b2' })).toBe(null);
  });
});

describe('技能正文注入(按真实 transcript 抓下来的行还原)', () => {
  /**
   * 这是 `Skill { skill: 'pdf' }` 之后 CLI 真正写进 transcript 的那一行,
   * 字段集一字不改。它同时带三重可判标记 —— 之前有人报"技能全文仍会泄漏",
   * 用的是手搓的、不带任何标记的行,那种行 CLI 并不会产生。
   */
  const REAL_SKILL_INJECTION = {
    type: 'user',
    uuid: 'sk-1',
    timestamp: '2026-08-20T08:00:00.000Z',
    isMeta: true,
    isSidechain: false,
    userType: 'external',
    sourceToolUseID: 'toolu_01SKILL',
    turnCompanion: true,
    promptId: 'p1',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: 'Base directory for this skill: /root/.claude/skills/synced/pdf\n\n# PDF Processing Guide\n\n## Overview\n\nThis guide covers…',
      }],
    },
  };

  it('三重标记各自单独都能判掉,任意一个失效仍然拦得住', () => {
    const { isMeta, sourceToolUseID, turnCompanion, ...rest } = REAL_SKILL_INJECTION;
    expect(nonHumanUserTurnReason({ ...rest, isMeta })).toBe('meta');
    expect(nonHumanUserTurnReason({ ...rest, sourceToolUseID })).toBe('tool-authored');
    expect(nonHumanUserTurnReason({ ...rest, turnCompanion })).toBe('turn-companion');
  });

  it('内容前缀是最后一道保险 —— 实时 SDK 流上没有那些 transcript 字段', () => {
    const text = String((REAL_SKILL_INJECTION.message.content[0] as { text: string }).text);
    expect(isInternalContent(text)).toBe(true);
  });

  it('整行走 normalizeMessage 不产生任何用户气泡', () => {
    assert.equal(bubbles(REAL_SKILL_INJECTION).length, 0);
  });

  it('三个结构标记全被抹掉时,前缀仍然拦得住', () => {
    const { isMeta: _m, sourceToolUseID: _s, turnCompanion: _t, ...bare } = REAL_SKILL_INJECTION;
    assert.equal(nonHumanUserTurnReason(bare), null);
    assert.equal(bubbles(bare).length, 0);
  });
});

describe('stripInjectedBlocks / isInternalContent', () => {
  it('提醒块追加在用户原话后面时,只留下用户原话', () => {
    const text = '把这个改一下\n<system-reminder>Do not mention this reminder.</system-reminder>';
    expect(stripInjectedBlocks(text)).toBe('把这个改一下');
    expect(isInternalContent(text)).toBe(false);
  });

  it('整条都是提醒块时判为注入', () => {
    expect(isInternalContent('<system-reminder>only this</system-reminder>')).toBe(true);
  });

  it('前缀清单仍然生效,且不受前导空白影响', () => {
    expect(isInternalContent('\n  Caveat: the messages below were generated…')).toBe(true);
    expect(isInternalContent('Base directory for this skill: /x')).toBe(true);
  });

  it('普通用户文字不误伤', () => {
    expect(isInternalContent('帮我看看 Caveat 这个词怎么翻译')).toBe(false);
  });
});

describe('normalizeMessage: 只有人发的 user 帧才渲染成气泡', () => {
  it('主线程用户回合正常出气泡', () => {
    assert.equal(bubbles(userRow({})).length, 1);
    assert.equal(bubbles(userRow({ origin: { kind: 'human' } }))[0].content, 'hello there');
  });

  it('子代理帧(带 parent_tool_use_id)不出气泡', () => {
    assert.equal(bubbles(userRow({ parent_tool_use_id: 'toolu_abc' })).length, 0);
  });

  it('sidechain 行不出气泡', () => {
    assert.equal(bubbles(userRow({ isSidechain: true })).length, 0);
  });

  it('数组内容里的子代理 prompt 文本也不出气泡', () => {
    const row = userRow(
      { parent_tool_use_id: 'toolu_abc' },
      [{ type: 'text', text: 'Reply with exactly the text AGENT_OK and nothing else.' }],
    );
    assert.equal(bubbles(row).length, 0);
  });

  it('子代理帧里的 tool_result 照常抽出来 —— 时间轴不能因此缺一块', () => {
    const row = userRow(
      { parent_tool_use_id: 'toolu_abc' },
      [
        { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'ok' },
        { type: 'text', text: 'subagent chatter' },
      ],
    );
    const all = new ClaudeSessionsProvider().normalizeMessage(row, SESSION_ID);
    const results = all.filter((m) => m.kind === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].toolId, 'toolu_abc');
    assert.equal(all.filter((m) => m.kind === 'text' && m.role === 'user').length, 0);
  });

  it('用户原话后面挂着 system-reminder 时,气泡里只剩原话', () => {
    const row = userRow({}, '改一下这里\n<system-reminder>hidden</system-reminder>');
    const out = bubbles(row);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, '改一下这里');
  });

  it('纯图片回合仍然出气泡(不带出处线索时)', () => {
    const row = userRow({}, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
    const out = bubbles(row);
    assert.equal(out.length, 1);
    assert.equal((out[0].images as unknown[] | undefined)?.length, 1);
  });

  it('子代理帧的纯图片回合不出气泡', () => {
    const row = userRow({ isSidechain: true }, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
    assert.equal(bubbles(row).length, 0);
  });
});

test('回归:压缩摘要仍然被改标成 assistant,而不是被出处判定吃掉', () => {
  const row = userRow({ isCompactSummary: true }, 'summary text');
  const out = new ClaudeSessionsProvider().normalizeMessage(row, SESSION_ID);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
});

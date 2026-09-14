import { describe, expect, it } from 'vitest';

import { forkAnchorUuid, isAssistantSideRow, nativeUuidFromMessageId } from '@/shared/fork-anchor.js';

const UUID = '0b9c4b2e-7f61-4a1d-9c3e-8a2f5d6e7b01';

describe('nativeUuidFromMessageId', () => {
  it('裸 uuid 与各种显示后缀都认得出来', () => {
    expect(nativeUuidFromMessageId(UUID)).toBe(UUID);
    expect(nativeUuidFromMessageId(`${UUID}_text`)).toBe(UUID);
    expect(nativeUuidFromMessageId(`${UUID}_text_0`)).toBe(UUID);
    expect(nativeUuidFromMessageId(`${UUID}_images`)).toBe(UUID);
    expect(nativeUuidFromMessageId(`${UUID}_tr_toolu_01`)).toBe(UUID);
  });

  it('**app 自造的 id 反推不出 uuid** —— 这正是 F14 的病灶', () => {
    expect(nativeUuidFromMessageId(`user_${UUID}`)).toBeNull();
    expect(nativeUuidFromMessageId('local_1757400000000_ab12cd')).toBeNull();
    expect(nativeUuidFromMessageId(`claude_${UUID}`)).toBeNull();
    expect(nativeUuidFromMessageId('')).toBeNull();
    expect(nativeUuidFromMessageId(undefined)).toBeNull();
    expect(nativeUuidFromMessageId(42)).toBeNull();
  });
});

/**
 * 判据要和 jsonl 里的 `type === 'assistant'` 对齐,不是和"看起来像模型说的"对齐。
 * 尤其 `tool_result`:界面上挂在工具行下面,jsonl 里却是一条 **user** 记录,
 * 拿它的 uuid 去 `resumeSessionAt` 会被 SDK 拒掉。
 */
describe('isAssistantSideRow', () => {
  it('assistant 正文 / 思考 / 工具调用 → 是', () => {
    expect(isAssistantSideRow({ kind: 'text', role: 'assistant' })).toBe(true);
    expect(isAssistantSideRow({ kind: 'thinking' })).toBe(true);
    expect(isAssistantSideRow({ kind: 'tool_use' })).toBe(true);
  });

  it('**tool_result 不是**(它在 jsonl 里是 user 记录)', () => {
    expect(isAssistantSideRow({ kind: 'tool_result' })).toBe(false);
  });

  it('用户正文不是', () => {
    expect(isAssistantSideRow({ kind: 'text', role: 'user' })).toBe(false);
    expect(isAssistantSideRow({ kind: 'text' })).toBe(false);
  });

  it('其它 kind 一律不是', () => {
    for (const kind of ['error', 'complete', 'status', 'changed_files', 'checkpoint_created']) {
      expect(isAssistantSideRow({ kind })).toBe(false);
    }
  });
});

describe('forkAnchorUuid', () => {
  it('assistant 侧 + id 里带得出 uuid → 有锚点', () => {
    expect(forkAnchorUuid({ id: `${UUID}_text`, kind: 'text', role: 'assistant' })).toBe(UUID);
    expect(forkAnchorUuid({ id: UUID, kind: 'thinking' })).toBe(UUID);
    expect(forkAnchorUuid({ id: `${UUID}_0`, kind: 'tool_use' })).toBe(UUID);
  });

  it('**assistant 侧但 id 是 app 自造的 → 没有锚点**(不能瞎编一个)', () => {
    expect(forkAnchorUuid({ id: `claude_${UUID}`, kind: 'text', role: 'assistant' })).toBeNull();
  });

  it('**非 assistant 侧一律没有锚点** —— 列的含义必须唯一:非空即可用', () => {
    expect(forkAnchorUuid({ id: `${UUID}_tr_toolu_01`, kind: 'tool_result' })).toBeNull();
    expect(forkAnchorUuid({ id: UUID, kind: 'text', role: 'user' })).toBeNull();
    expect(forkAnchorUuid({ id: `user_${UUID}`, kind: 'text', role: 'user' })).toBeNull();
  });
});

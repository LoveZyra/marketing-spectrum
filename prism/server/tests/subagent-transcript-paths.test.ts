import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { subagentTranscriptCandidates } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * 子代理 transcript 到底在哪儿。
 *
 * 当前形状是 `<projectDir>/<session-id>/subagents/agent-<id>.jsonl`(同步器
 * `claude-session-synchronizer.provider.ts` 的 `isSubagentTranscript()` 也按这个形状跳过它们),
 * 旧形状是扁平的 `<projectDir>/agent-<id>.jsonl`。读取一侧必须和同步器认同一个形状,否则子代理的
 * 工具细节读不到(Task 工具在界面上没有内层),而且找不到时一声不吭。
 * 所以按候选顺序找:当前形状在前,旧形状留作兼容放在最后。
 */
const DIR = path.join('/home/u/.claude/projects', '-home-u-proj');
const SESSION = 'b93db2bb-f99c-4ea6-ae64-f21c98992e35';

describe('subagentTranscriptCandidates', () => {
  it('当前形状排第一:<projectDir>/<session-id>/subagents/agent-<id>.jsonl', () => {
    const candidates = subagentTranscriptCandidates(DIR, SESSION, 'a1');
    expect(candidates[0]).toBe(path.join(DIR, SESSION, 'subagents', 'agent-a1.jsonl'));
  });

  it('老形状留作兼容,但排在最后', () => {
    const candidates = subagentTranscriptCandidates(DIR, SESSION, 'a1');
    expect(candidates[candidates.length - 1]).toBe(path.join(DIR, 'agent-a1.jsonl'));
  });

  it('不按会话分层的那种也认', () => {
    expect(subagentTranscriptCandidates(DIR, SESSION, 'a1')).toContain(
      path.join(DIR, 'subagents', 'agent-a1.jsonl'),
    );
  });

  it('没有 providerSessionId 时跳过第一个候选,其余照旧', () => {
    const candidates = subagentTranscriptCandidates(DIR, null, 'a1');
    expect(candidates).toEqual([
      path.join(DIR, 'subagents', 'agent-a1.jsonl'),
      path.join(DIR, 'agent-a1.jsonl'),
    ]);
  });

  it('候选之间不重复,而且都在项目目录之下', () => {
    const candidates = subagentTranscriptCandidates(DIR, SESSION, 'a1');
    expect(new Set(candidates).size).toBe(candidates.length);
    for (const candidate of candidates) {
      expect(candidate.startsWith(DIR + path.sep)).toBe(true);
    }
  });

  it('agentId 原样进文件名(SDK 给什么用什么)', () => {
    expect(subagentTranscriptCandidates(DIR, SESSION, 'agent_x-9')).toContain(
      path.join(DIR, SESSION, 'subagents', 'agent-agent_x-9.jsonl'),
    );
  });
});

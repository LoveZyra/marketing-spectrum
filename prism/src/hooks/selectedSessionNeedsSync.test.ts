/**
 * 顶栏标题跟着改名走。
 *
 * 2026-09-15 实测:在顶栏用那支铅笔把会话改名 → 侧栏当场是新名字,
 * 顶栏仍写着 "New Session",点一次「刷新项目和会话」才对上。
 *
 * 根因是 URL→selectedSession 那个 effect 的判据只有 id 与 provider —— 改名
 * 一样都不动。这里逐条钉住放宽后的判据,并守住"不要为每条消息重挑对象"
 * 与"空标题不许覆盖已有标题"这两条边界。
 */
import { describe, it, expect } from 'vitest';

import type { ProjectSession } from '../types/app';

import { selectedSessionNeedsSync } from './useProjectsState';

const row = (over: Partial<ProjectSession> = {}): ProjectSession => ({
  id: 's1',
  summary: '',
  __provider: 'claude',
  ...over,
} as ProjectSession);

describe('selectedSessionNeedsSync', () => {
  it('还没选中任何会话:要换', () => {
    expect(selectedSessionNeedsSync(null, row())).toBe(true);
    expect(selectedSessionNeedsSync(undefined, row())).toBe(true);
  });

  it('换了会话 / 换了 provider:要换(原来就有的两条)', () => {
    expect(selectedSessionNeedsSync(row({ id: 's1' }), row({ id: 's2' }))).toBe(true);
    // 会话行上的 __provider 可能还没填(旧数据 / 占位),填上之后要当作"变了"
    expect(selectedSessionNeedsSync(row({ __provider: undefined }), row({ __provider: 'claude' }))).toBe(true);
    // id 是字符串还是数字不该影响判断
    expect(selectedSessionNeedsSync(row({ id: 7 as unknown as string }), row({ id: '7' }))).toBe(false);
  });

  it('改名:要换 —— 这一条就是顶栏挂着旧标题的那个 bug', () => {
    expect(selectedSessionNeedsSync(row({ summary: '' }), row({ summary: 'gk 验收-重命名测试' }))).toBe(true);
    expect(selectedSessionNeedsSync(row({ summary: '旧名字' }), row({ summary: '新名字' }))).toBe(true);
  });

  it('只是又来了一条消息(标题没变):不换 —— 否则流式输出期间整棵聊天子树重渲', () => {
    const current = row({ summary: '同一个标题', messageCount: 3 } as Partial<ProjectSession>);
    const incoming = row({ summary: '同一个标题', messageCount: 4, lastActivity: new Date().toISOString() } as Partial<ProjectSession>);
    expect(selectedSessionNeedsSync(current, incoming)).toBe(false);
  });

  it('空标题不许覆盖已有标题(新会话会短暂广播一个空 custom_name)', () => {
    expect(selectedSessionNeedsSync(row({ summary: '已经有的标题' }), row({ summary: '' }))).toBe(false);
    expect(selectedSessionNeedsSync(row({ summary: '已经有的标题' }), row({ summary: '   ' }))).toBe(false);
    expect(selectedSessionNeedsSync(row({ summary: '标题' }), row({ summary: undefined }))).toBe(false);
  });

  it('前后空白不算改名', () => {
    expect(selectedSessionNeedsSync(row({ summary: '标题' }), row({ summary: '  标题  ' }))).toBe(false);
  });
});

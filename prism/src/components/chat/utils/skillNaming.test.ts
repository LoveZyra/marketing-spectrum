import { describe, expect, it } from 'vitest';

import {
  describeSkillInvocationInput,
  matchSkillInvocation,
  type SkillCatalogEntry,
  type SkillCommandLike,
} from './skillNaming';

const catalog: SkillCatalogEntry[] = [
  { command: '/echo-probe', name: 'echo-probe', description: '回显探针技能' },
  { command: '/pdf', name: 'pdf', description: '处理 PDF 文档' },
];

describe('matchSkillInvocation', () => {
  it('首词命中技能命令 → 返回该条目(允许后随参数)', () => {
    expect(matchSkillInvocation('/echo-probe 你好 世界', catalog)?.name).toBe('echo-probe');
    expect(matchSkillInvocation('  /pdf', catalog)?.name).toBe('pdf');
  });

  it('前缀相同但不是同一个命令 → 不命中', () => {
    expect(matchSkillInvocation('/echo-probe2 你好', catalog)).toBeNull();
    expect(matchSkillInvocation('/echo', catalog)).toBeNull();
  });

  it('非斜杠开头、中途出现命令、空串 → 都不算调用', () => {
    expect(matchSkillInvocation('请用 /pdf 处理', catalog)).toBeNull();
    expect(matchSkillInvocation('普通消息', catalog)).toBeNull();
    expect(matchSkillInvocation('', catalog)).toBeNull();
  });
});

const skillCommand: SkillCommandLike = {
  name: '/echo-probe',
  description: '回显探针技能',
  namespace: 'skill',
  type: 'skill',
  metadata: { skillName: 'echo-probe', scope: 'user' },
};
const builtinCommand: SkillCommandLike = {
  name: '/cost',
  description: 'Display token usage information',
  namespace: 'builtin',
};
const menu: SkillCommandLike[] = [builtinCommand, skillCommand];

describe('describeSkillInvocationInput', () => {
  it('技能命令 + 参数 → 「技能名:参数」', () => {
    expect(describeSkillInvocationInput('/echo-probe 整理季度报告', menu)).toBe(
      'echo-probe:整理季度报告',
    );
  });

  it('技能命令无参数 → 用描述;描述为空再退回技能名', () => {
    expect(describeSkillInvocationInput('/echo-probe', menu)).toBe('回显探针技能');
    const bare: SkillCommandLike[] = [{ name: '/x', type: 'skill' }];
    expect(describeSkillInvocationInput('/x', bare)).toBe('x');
  });

  it('metadata.skillName 缺失时从命令名剥斜杠', () => {
    const noMeta: SkillCommandLike[] = [
      { name: '/plain-skill', description: '', namespace: 'skill' },
    ];
    expect(describeSkillInvocationInput('/plain-skill 参数', noMeta)).toBe('plain-skill:参数');
  });

  it('内置命令、未知命令、普通消息 → 原样返回', () => {
    expect(describeSkillInvocationInput('/cost', menu)).toBe('/cost');
    expect(describeSkillInvocationInput('/unknown 东西', menu)).toBe('/unknown 东西');
    expect(describeSkillInvocationInput('普通消息', menu)).toBe('普通消息');
  });
});

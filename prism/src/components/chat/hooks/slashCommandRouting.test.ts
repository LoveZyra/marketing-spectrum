import { describe, expect, it } from 'vitest';

import { isPromptCommand } from './useSlashCommands';

/**
 * 一条命令要么交服务端 `/api/commands/execute` 跑,要么打进输入框让 CLI 跑。
 * 分错的后果很具体:CLI 自带命令被送去 execute 端点,一律报
 * 「Command path is required for custom commands」。
 */
describe('isPromptCommand —— 命令该由谁执行', () => {
  it('技能进输入框', () => {
    expect(isPromptCommand({ name: '/pdf', type: 'skill' })).toBe(true);
    expect(isPromptCommand({ name: '/pdf', metadata: { type: 'skill' } })).toBe(true);
  });

  it('CLI 自带命令进输入框 —— 服务端既没 handler 也没 path', () => {
    expect(isPromptCommand({ name: '/compact', type: 'cli', namespace: 'cli' })).toBe(true);
    expect(isPromptCommand({ name: '/clear', namespace: 'cli' })).toBe(true);
  });

  it('六个内置命令交服务端执行', () => {
    for (const name of ['/help', '/models', '/cost', '/memory', '/config', '/status']) {
      expect(isPromptCommand({ name, namespace: 'builtin', metadata: { type: 'builtin' } })).toBe(false);
    }
  });

  it('带 path 的自定义命令交服务端执行', () => {
    expect(isPromptCommand({
      name: '/deploy',
      type: 'custom',
      path: '/home/u/.claude/commands/deploy.md',
    })).toBe(false);
  });

  it('自定义命令缺 path 时进输入框,而不是撞到服务端报错', () => {
    expect(isPromptCommand({ name: '/deploy', type: 'custom' })).toBe(true);
  });
});

/**
 * 回归:客户端在拿到 `/api/commands/list` 的 `builtIn` 数组后,会**无差别**
 * 给每一项盖上 `type: 'built-in'`(useSlashCommands 里那个 map)。
 * 而那个数组里混着 `cliPassthroughCommands` —— 服务端给它们标的是
 * `namespace: 'cli'`。判据必须扛得住这层覆盖,否则 `/compact` 又会被
 * 当成内置命令送去 execute 端点。
 */
describe('回归:builtIn 数组里混进来的 CLI 命令', () => {
  const asClientSees = (command: { name: string } & Record<string, unknown>) => ({
    ...command,
    type: 'built-in' as const,
  });

  it('type 被盖成 built-in,但 namespace 仍是 cli —— 必须判为进输入框', () => {
    for (const name of ['/compact', '/clear', '/init', '/review', '/todos', '/rewind']) {
      const command = asClientSees({ name, namespace: 'cli', metadata: { type: 'cli' } });
      expect(isPromptCommand(command)).toBe(true);
    }
  });

  it('真内置命令即便同样被盖上 built-in,仍然交服务端', () => {
    const command = asClientSees({ name: '/help', namespace: 'builtin', metadata: { type: 'builtin' } });
    expect(isPromptCommand(command)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { pickClientRuntimeOptions } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * `chat.send` 的客户端 options 按白名单挑选,不能展开后再用黑名单覆盖。
 *
 * 黑名单漏一个键就是一个洞:例如 `oneShot` + `newSessionId` 能让运行时把别人的会话 id
 * 当成自己的 transcript id 回灌,进而在 `assignProviderSessionId` 里删掉别人那一行。
 * 会话 id 是 uuid,就在浏览器地址栏里,不是密钥。
 */
describe('pickClientRuntimeOptions', () => {
  it('前端真正会发的那几项照常放行', () => {
    const picked = pickClientRuntimeOptions({
      model: 'claude-x', effort: 'high', permissionMode: 'default',
      toolsSettings: { allowedTools: [] }, skipPermissions: false, sessionSummary: '摘要',
    });
    expect(picked).toEqual({
      model: 'claude-x', effort: 'high', permissionMode: 'default',
      toolsSettings: { allowedTools: [] }, skipPermissions: false, sessionSummary: '摘要',
    });
  });

  it('`newSessionId` / `oneShot` 一律不进', () => {
    const picked = pickClientRuntimeOptions({
      model: 'claude-x',
      oneShot: true,
      newSessionId: '11111111-2222-4333-8444-555555555555',
    });
    expect(picked).toEqual({ model: 'claude-x' });
    expect('oneShot' in picked).toBe(false);
    expect('newSessionId' in picked).toBe(false);
  });

  it('其余服务端内部键一个都不许进 —— 白名单的意义就在这儿', () => {
    const picked = pickClientRuntimeOptions({
      cwd: '/别人的项目', env: { ANTHROPIC_API_KEY: 'x' }, ownerUserId: 1,
      usageSource: 'forged', resumeSessionId: 'x', runId: 'x', sessionId: 'x',
      actorUsername: 'root', imageRoots: ['/'], skipAutoCompact: true,
      effortModels: {}, resolvedEffort: 'max',
    });
    expect(picked).toEqual({});
  });

  it('`images` / `forkFrom` / `hiddenContext` / `projectPath` 不走白名单 —— 它们各有专门的校验分支', () => {
    const picked = pickClientRuntimeOptions({
      images: [{ path: '/etc/passwd' }], forkFrom: { sessionId: 'x' },
      hiddenContext: '...', projectPath: '/别人的项目',
    });
    expect(picked).toEqual({});
  });

  it('没给的键不会凭空出现 undefined(会盖掉服务端算好的值)', () => {
    expect(Object.keys(pickClientRuntimeOptions({}))).toEqual([]);
    expect(Object.keys(pickClientRuntimeOptions({ model: undefined }))).toEqual([]);
  });
});

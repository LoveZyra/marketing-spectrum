import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { rememberablePermissionEntry } from '../claude-sdk.js';

/**
 * 审批答复里的「允许并记住」(rememberEntry)来自客户端,要在服务端校验:
 * 只认由这次请求的工具生成的那一条;不在 PRISM_ALLOW_BYPASS_USERS 名单里的人只放行这一次;
 * 服务端强制禁用的工具不记。
 */

const withEnv = (vars, run) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const noPolicy = { PRISM_ALLOW_BYPASS_USERS: undefined, PRISM_FORCED_DENY_TOOLS: undefined };

describe('rememberablePermissionEntry', () => {
  test('只认由这次请求的工具生成的那一条(与前端 buildClaudeToolPermissionEntry 同一算法)', () => {
    withEnv(noPolicy, () => {
      const bash = { toolName: 'Bash', input: { command: 'git status --short && rm -rf x' }, actorUsername: 'alice' };
      assert.equal(rememberablePermissionEntry('Bash(git status:*)', bash), 'Bash(git status:*)');
      assert.equal(rememberablePermissionEntry('Bash', bash), null, '整条 Bash 放行不是这次请求生成的');
      assert.equal(rememberablePermissionEntry('Bash(rm:*)', bash), null);
      assert.equal(rememberablePermissionEntry('Bash(npm:*)', { toolName: 'Bash', input: { command: '  npm test --silent' } }), 'Bash(npm:*)');
      assert.equal(rememberablePermissionEntry('Bash', { toolName: 'Bash', input: {} }), 'Bash', '没有命令时就是工具名');
      assert.equal(rememberablePermissionEntry('Read', { toolName: 'Read', input: { file_path: '/x' } }), 'Read');
      assert.equal(rememberablePermissionEntry('Write', { toolName: 'Read', input: {} }), null, '换了工具名不行');
      assert.equal(rememberablePermissionEntry('', { toolName: 'Read' }), null);
      assert.equal(rememberablePermissionEntry(42, { toolName: 'Read' }), null);
    });
  });

  test('不在 PRISM_ALLOW_BYPASS_USERS 名单里的人只放行这一次;名单没配不限制', () => {
    const read = (actorUsername) => ({ toolName: 'Read', input: {}, actorUsername });
    withEnv({ ...noPolicy, PRISM_ALLOW_BYPASS_USERS: 'Alice' }, () => {
      assert.equal(rememberablePermissionEntry('Read', read('alice')), 'Read');
      assert.equal(rememberablePermissionEntry('Read', read('bob')), null);
      assert.equal(rememberablePermissionEntry('Read', read(null)), null);
    });
    withEnv(noPolicy, () => {
      assert.equal(rememberablePermissionEntry('Read', read('bob')), 'Read');
    });
  });

  test('服务端强制禁用的工具(PRISM_FORCED_DENY_TOOLS、跨会话消息)不记', () => {
    withEnv({ ...noPolicy, PRISM_FORCED_DENY_TOOLS: 'ExitPlanMode,Bash(rm:*)' }, () => {
      assert.equal(rememberablePermissionEntry('ExitPlanMode', { toolName: 'ExitPlanMode', input: {} }), null);
      assert.equal(rememberablePermissionEntry('Bash(rm:*)', { toolName: 'Bash', input: { command: 'rm -rf build' } }), null);
      assert.equal(rememberablePermissionEntry('Bash(ls:*)', { toolName: 'Bash', input: { command: 'ls' } }), 'Bash(ls:*)');
      assert.equal(rememberablePermissionEntry('SendMessage', { toolName: 'SendMessage', input: {} }), null);
    });
  });
});

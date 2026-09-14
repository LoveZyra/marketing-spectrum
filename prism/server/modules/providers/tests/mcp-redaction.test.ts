import { describe, expect, it } from 'vitest';

import {
  REDACTED_VALUE,
  redactMcpSecrets,
  redactMcpSecretsInList,
  shouldRedactScope,
} from '@/modules/providers/services/mcp-redaction.js';
import type { ProviderMcpServer } from '@/shared/types.js';

/**
 * F03:`user` 作用域的 MCP 配置能看见,但看不见里面的凭据。
 *
 * `scope: 'user'` 写的是 `~/.claude.json` —— **服务进程的家目录**,全机生效,
 * 而 `env` / `headers` 正是放 API key、bearer token 的地方。不带 `scope` 的那条
 * 列表接口过了项目检查就把三组原样返回,任何登录用户读一次就全拿到了。
 */
const stdioServer: ProviderMcpServer = {
  provider: 'claude',
  name: 'github',
  scope: 'user',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: 'ghp_realtoken', LOG_LEVEL: 'debug' },
};

const httpServer: ProviderMcpServer = {
  provider: 'claude',
  name: 'internal',
  scope: 'user',
  transport: 'http',
  url: 'https://mcp.example.com',
  headers: { Authorization: 'Bearer real-token' },
};

describe('redactMcpSecrets', () => {
  it('env 的**键名保留、值打掉** —— 用户要能看出这个 server 需要什么', () => {
    const redacted = redactMcpSecrets(stdioServer);
    expect(Object.keys(redacted.env!)).toEqual(['GITHUB_TOKEN', 'LOG_LEVEL']);
    expect(redacted.env).toEqual({ GITHUB_TOKEN: REDACTED_VALUE, LOG_LEVEL: REDACTED_VALUE });
  });

  it('headers 同样处理', () => {
    expect(redactMcpSecrets(httpServer).headers).toEqual({ Authorization: REDACTED_VALUE });
  });

  it('**非凭据字段一个不动** —— 打码不该顺手改掉别的东西', () => {
    const redacted = redactMcpSecrets(stdioServer);
    expect(redacted.name).toBe('github');
    expect(redacted.command).toBe('npx');
    expect(redacted.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(redacted.transport).toBe('stdio');
  });

  it('不改原对象(缓存里那份不能被打码污染)', () => {
    redactMcpSecrets(stdioServer);
    expect(stdioServer.env).toEqual({ GITHUB_TOKEN: 'ghp_realtoken', LOG_LEVEL: 'debug' });
  });

  it('没有凭据字段的原样返回(同一个引用)', () => {
    const plain: ProviderMcpServer = { provider: 'claude', name: 'x', scope: 'project', transport: 'stdio', command: 'ls' };
    expect(redactMcpSecrets(plain)).toBe(plain);
  });

  it('空的 env 也保留成空对象,而不是变成 undefined', () => {
    // 「有这个字段但里面是空的」和「没有这个字段」在界面上是两件事。
    const withEmpty: ProviderMcpServer = { ...stdioServer, env: {} };
    expect(redactMcpSecrets(withEmpty).env).toEqual({});
  });

  it('整列一起处理', () => {
    const out = redactMcpSecretsInList([stdioServer, httpServer]);
    expect(out[0].env!.GITHUB_TOKEN).toBe(REDACTED_VALUE);
    expect(out[1].headers!.Authorization).toBe(REDACTED_VALUE);
  });
});

describe('shouldRedactScope', () => {
  it('user 作用域对非 root 打码', () => {
    expect(shouldRedactScope('user', false)).toBe(true);
  });

  it('root 看到真值(他本来就写得了这份配置)', () => {
    // 规矩:**能读到的 = 能写的**。
    expect(shouldRedactScope('user', true)).toBe(false);
  });

  it('project / local 不打码 —— 那是调用者已经过了可见性检查的项目', () => {
    expect(shouldRedactScope('project', false)).toBe(false);
    expect(shouldRedactScope('local', false)).toBe(false);
  });

  it('没有 scope 时不打码(分组列表按组逐个判)', () => {
    expect(shouldRedactScope(undefined, false)).toBe(false);
    expect(shouldRedactScope(null, false)).toBe(false);
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';

import {
  __resetJupyterAuthForTest,
  buildJupyterArgs,
  buildJupyterEntryUrl,
  isJupyterSessionValid,
  issueJupyterEntryTicket,
  readCookieValue,
  redeemJupyterEntryTicket,
} from '../services/jupyter-manager.service.js';
import {
  buildForwardHeaders,
  buildUpgradeRequestHead,
  stripEntryTicket,
} from '../services/jupyter-proxy.service.js';

afterEach(() => {
  __resetJupyterAuthForTest();
});

describe('buildJupyterArgs', () => {
  it('固定回环、base_url=/jupyter、token 与 root_dir 落到位', () => {
    const args = buildJupyterArgs({ port: 8890, token: 'tok', rootDir: '/data/ws' });
    expect(args[0]).toBe('lab');
    expect(args).toContain('--ServerApp.ip=127.0.0.1');
    expect(args).toContain('--ServerApp.port=8890');
    expect(args).toContain('--ServerApp.token=tok');
    expect(args).toContain('--ServerApp.base_url=/jupyter');
    expect(args).toContain('--ServerApp.root_dir=/data/ws');
    expect(args).toContain('--allow-root');
  });
});

describe('buildJupyterEntryUrl', () => {
  it('工作区内的文件深链到 /lab/tree/<相对路径>,逐段编码', () => {
    const url = buildJupyterEntryUrl({
      rootDir: '/data/ws',
      targetPath: '/data/ws/项目 A/分析.ipynb',
      ticket: 't1',
    });
    expect(url).toBe(`/jupyter/lab/tree/${encodeURIComponent('项目 A')}/${encodeURIComponent('分析.ipynb')}?prism_ticket=t1`);
  });

  it('越出根目录 / 带 .. 的路径退回 lab 根', () => {
    expect(buildJupyterEntryUrl({ rootDir: '/data/ws', targetPath: '/etc/passwd', ticket: 't' })).toBe(
      '/jupyter/lab?prism_ticket=t',
    );
    expect(buildJupyterEntryUrl({ rootDir: '/data/ws', targetPath: '/data/ws/a/../../x', ticket: 't' })).toBe(
      '/jupyter/lab?prism_ticket=t',
    );
    expect(buildJupyterEntryUrl({ rootDir: '/data/ws', targetPath: null, ticket: 't' })).toBe(
      '/jupyter/lab?prism_ticket=t',
    );
  });
});

describe('readCookieValue', () => {
  it('多个 cookie 里取对名字,没有给 null', () => {
    expect(readCookieValue('a=1; prism_jupyter=abc; b=2', 'prism_jupyter')).toBe('abc');
    expect(readCookieValue('a=1', 'prism_jupyter')).toBeNull();
    expect(readCookieValue(undefined, 'prism_jupyter')).toBeNull();
  });
});

describe('入口票据 → 会话', () => {
  it('票据一次性;换出的会话通过校验,伪造的不通过', () => {
    const ticket = issueJupyterEntryTicket(7);
    const sessionId = redeemJupyterEntryTicket(ticket);
    expect(sessionId).toBeTruthy();
    expect(redeemJupyterEntryTicket(ticket)).toBeNull(); // 二次使用作废
    expect(isJupyterSessionValid(sessionId)).toBe(true);
    expect(isJupyterSessionValid('deadbeef')).toBe(false);
    expect(isJupyterSessionValid(null)).toBe(false);
  });
});

describe('buildForwardHeaders', () => {
  it('剥逐跳与调用方 authorization,注入 jupyter token 和上游 host', () => {
    const headers = buildForwardHeaders(
      {
        host: 'prism.example',
        authorization: 'Bearer prism-jwt',
        connection: 'keep-alive, x-drop-me',
        'x-drop-me': 'yes',
        'transfer-encoding': 'chunked',
        cookie: 'prism_jupyter=s1',
        accept: 'text/html',
      },
      { hostLabel: '127.0.0.1:8890', jupyterToken: 'tok' },
    );
    expect(headers.host).toBe('127.0.0.1:8890');
    expect(headers.authorization).toBe('token tok');
    expect(headers).not.toHaveProperty('connection');
    expect(headers).not.toHaveProperty('x-drop-me');
    expect(headers).not.toHaveProperty('transfer-encoding');
    expect(headers.accept).toBe('text/html');
    expect(headers.cookie).toBe('prism_jupyter=s1');
  });
});

describe('stripEntryTicket', () => {
  it('只摘掉 prism_ticket,其余查询串原样', () => {
    expect(stripEntryTicket('/jupyter/lab?prism_ticket=abc&x=1')).toBe('/jupyter/lab?x=1');
    expect(stripEntryTicket('/jupyter/api/status')).toBe('/jupyter/api/status');
  });
});

describe('buildUpgradeRequestHead', () => {
  it('保留原始首部(含重复),替换 host 与 authorization,path 去票', () => {
    const request = {
      url: '/jupyter/api/kernels/k1/channels?session_id=s&prism_ticket=zz',
      rawHeaders: [
        'Host', 'prism.example',
        'Upgrade', 'websocket',
        'Connection', 'Upgrade',
        'Sec-WebSocket-Key', 'KEY==',
        'Sec-WebSocket-Extensions', 'ext-a',
        'Sec-WebSocket-Extensions', 'ext-b',
        'Authorization', 'Bearer prism-jwt',
        'Cookie', 'prism_jupyter=s1',
      ],
    } as unknown as IncomingMessage;
    const head = buildUpgradeRequestHead(request, { hostLabel: '127.0.0.1:8890', jupyterToken: 'tok' });
    expect(head.startsWith('GET /jupyter/api/kernels/k1/channels?session_id=s HTTP/1.1\r\n')).toBe(true);
    expect(head).toContain('Upgrade: websocket');
    expect(head).toContain('Sec-WebSocket-Extensions: ext-a');
    expect(head).toContain('Sec-WebSocket-Extensions: ext-b');
    expect(head).toContain('Host: 127.0.0.1:8890');
    expect(head).toContain('Authorization: token tok');
    expect(head).not.toContain('prism-jwt');
    expect(head).not.toContain('prism_ticket');
    expect(head.endsWith('\r\n\r\n')).toBe(true);
  });
});

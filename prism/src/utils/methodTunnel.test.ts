import { describe, expect, it, vi } from 'vitest';

/**
 * ea:前端方法隧道 —— PATCH/PUT/DELETE 一律改成 POST + X-HTTP-Method-Override。
 * 与服务端 shared/method-override.ts 认的集合是同一份。
 *
 * api.js 在模块顶层读 import.meta.env 与 localStorage,这里只 mock 到能 import 的程度。
 */
vi.mock('../constants/config', () => ({ IS_PLATFORM: false }));
vi.mock('../shared/view/ui/toastBus', () => ({ emitToast: () => undefined }));
vi.mock('./tokenRefresh', () => ({ hasJwtShape: () => true, installRefreshedToken: () => undefined }));

import { tunnelMethod, withMethodQuery } from './api.js';

describe('tunnelMethod', () => {
  it('PATCH / PUT / DELETE → POST + 覆盖头 + ?_method(大小写不敏感)', () => {
    expect(tunnelMethod('/api/tasks/1', { method: 'PATCH' })).toEqual({
      url: '/api/tasks/1?_method=PATCH', method: 'POST', headers: { 'X-HTTP-Method-Override': 'PATCH' }, tunneled: true,
    });
    expect(tunnelMethod('/api/x', { method: 'put' })).toEqual({
      url: '/api/x?_method=PUT', method: 'POST', headers: { 'X-HTTP-Method-Override': 'PUT' }, tunneled: true,
    });
    expect(tunnelMethod('/api/x', { method: 'Delete' })).toEqual({
      url: '/api/x?_method=DELETE', method: 'POST', headers: { 'X-HTTP-Method-Override': 'DELETE' }, tunneled: true,
    });
  });

  it('GET / POST / 未指定:原样,不加头、不动 URL', () => {
    expect(tunnelMethod('/api/x', { method: 'GET' })).toEqual({ url: '/api/x', method: 'GET', headers: {}, tunneled: false });
    expect(tunnelMethod('/api/x', { method: 'POST' })).toEqual({ url: '/api/x', method: 'POST', headers: {}, tunneled: false });
    expect(tunnelMethod('/api/x', {})).toEqual({ url: '/api/x', method: undefined, headers: {}, tunneled: false });
  });
});

describe('withMethodQuery', () => {
  it('已有查询串用 & 接,没有用 ?,hash 留在最后', () => {
    expect(withMethodQuery('/api/a', 'PATCH')).toBe('/api/a?_method=PATCH');
    expect(withMethodQuery('/api/a?x=1', 'DELETE')).toBe('/api/a?x=1&_method=DELETE');
    expect(withMethodQuery('/api/a?x=1#top', 'PUT')).toBe('/api/a?x=1&_method=PUT#top');
  });
});

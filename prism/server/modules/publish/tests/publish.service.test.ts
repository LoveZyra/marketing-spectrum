import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  contentTypeFor,
  injectBaseHref,
  normalizePublicSubPath,
  publicBaseHref,
} from '@/modules/publish/services/publish.service.js';

describe('公开路由的子路径归一化', () => {
  test('正常子路径原样通过,前导 ./ 和空段被清掉', () => {
    assert.equal(normalizePublicSubPath('assets/app.css'), 'assets/app.css');
    assert.equal(normalizePublicSubPath('./assets//app.css'), 'assets/app.css');
    assert.equal(normalizePublicSubPath(''), '');
  });

  test('任何往上爬的写法一律拒绝', () => {
    // 这些都是同一个攻击的不同写法;逐个列出来,以后有人动这个函数会先看到清单
    assert.equal(normalizePublicSubPath('../secrets.env'), null);
    assert.equal(normalizePublicSubPath('a/../../b'), null);
    assert.equal(normalizePublicSubPath('%2e%2e/secrets'), null);
    assert.equal(normalizePublicSubPath('..\\\\windows\\\\system32'), null);
    assert.equal(normalizePublicSubPath('/etc/passwd'), null);
    assert.equal(normalizePublicSubPath('C:/Windows'), null);
    assert.equal(normalizePublicSubPath('a\0b'), null);
    assert.equal(normalizePublicSubPath('%zz'), null);
  });
});

describe('MIME 白名单', () => {
  test('白名单内的类型正常返回', () => {
    assert.equal(contentTypeFor('a/b/report.html').contentType, 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('chart.SVG').contentType, 'image/svg+xml');
    assert.equal(contentTypeFor('x.woff2').forceDownload, false);
  });

  test('白名单外一律当附件下载,不让浏览器自己猜', () => {
    for (const name of ['payload.xhtml', 'macro.xlsm', 'thing.exe', 'noext']) {
      const resolved = contentTypeFor(name);
      assert.equal(resolved.forceDownload, true, name);
      assert.equal(resolved.contentType, 'application/octet-stream');
    }
  });
});

describe('base href 注入', () => {
  test('单文件发布锁在 /p/<token>/', () => {
    assert.equal(publicBaseHref('t'.repeat(32), 'file', ''), `/p/${'t'.repeat(32)}/`);
  });

  test('整站发布锁在当前文件所在目录', () => {
    const token = 'a'.repeat(32);
    assert.equal(publicBaseHref(token, 'folder', 'docs/index.html'), `/p/${token}/docs/`);
    assert.equal(publicBaseHref(token, 'folder', 'index.html'), `/p/${token}/`);
  });

  test('base 插在 <head> 之后 —— 插在别处对已声明的资源不生效', () => {
    const html = '<html><head><link rel="stylesheet" href="a.css"></head><body>x</body></html>';
    const out = injectBaseHref(html, '/p/tok/');
    assert.ok(out.indexOf('<base href="/p/tok/">') < out.indexOf('<link'));
  });

  test('没有 <head> 的片段也能拿到 base', () => {
    assert.ok(injectBaseHref('<p>hi</p>', '/p/tok/').startsWith('<base href="/p/tok/">'));
  });

  test('页面自己写了 base 就不动它 —— 那是作者的决定', () => {
    const html = '<head><base href="https://example.com/"></head>';
    assert.equal(injectBaseHref(html, '/p/tok/'), html);
  });

  test('带属性的 <head> 也能匹配', () => {
    const out = injectBaseHref('<head lang="zh"><title>t</title></head>', '/p/tok/');
    assert.ok(out.includes('<base href="/p/tok/">'));
    assert.ok(out.indexOf('<base') < out.indexOf('<title>'));
  });
});

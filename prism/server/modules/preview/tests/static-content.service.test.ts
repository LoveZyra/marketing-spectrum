import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  contentTypeFor,
  normalizePublicSubPath,
} from '@/modules/preview/services/static-content.service.js';

/**
 * 这两条规则原来属于「发布」功能。那个功能整体移除了,规则跟着搬到了预览模块 ——
 * 它们是任何"按 URL 尾巴从磁盘取文件"的路由的承重墙,和哪个功能在用无关:
 *
 * · 路径归一化挡的是往上爬,是 `validatePathInProject` 之前的第一道;
 * · MIME 白名单挡的是存储型 XSS —— 让浏览器自己猜类型,一个 `.xhtml` 就能在
 *   同源里执行脚本,而 Prism 的 JWT 就放在 localStorage 里。
 *
 * 用例也一并搬过来,而不是随功能删掉。
 */

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

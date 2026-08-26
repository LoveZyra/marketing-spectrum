/**
 * `GET /api/projects/:projectId/files/content` 的 inline 白名单。
 *
 * 这条路由早先是 `mime.lookup()` 直出、不带 Content-Disposition、也没有 CSP:
 * 往项目里放一个 `evil.html`,它就会被以 `text/html` 内联渲染在应用**同源**下。
 * `nosniff` 挡不住 —— 类型是服务端自己显式声明的。实测那份 HTML 里的脚本执行了,
 * 并把 localStorage 里的整个 JWT 读了出来。
 *
 * 所以这张白名单只放位图 / 音频 / 视频,其余一律按附件下发。宁可窄:
 * 名单里少一个类型,最坏是直接导航时变成下载(应用内全部走 blob,不受影响);
 * 名单里多一个能承载脚本的类型,就是一个同源的存储型 XSS。
 */

import { describe, it, expect } from 'vitest';

import { isInlineSafeContentType } from '../files.routes.js';

describe('files/content inline 白名单', () => {
  it('位图、音频、视频可以 inline', () => {
    for (const type of [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'video/mp4', 'video/webm', 'video/quicktime',
    ]) {
      expect(isInlineSafeContentType(type)).toBe(true);
    }
  });

  it('能承载脚本的类型一律不 inline', () => {
    for (const type of [
      'text/html',
      'application/xhtml+xml',
      'image/svg+xml',        // 位图前缀命中,但 SVG 能带脚本,必须单独挡掉
      'application/xml',
      'text/xml',
      'application/javascript',
      'text/javascript',
      'application/pdf',
    ]) {
      expect(isInlineSafeContentType(type)).toBe(false);
    }
  });

  it('普通文本也不 inline —— 它没有 inline 的必要,而白名单要窄', () => {
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/json']) {
      expect(isInlineSafeContentType(type)).toBe(false);
    }
  });

  it('带参数和大小写不影响判定', () => {
    expect(isInlineSafeContentType('IMAGE/PNG')).toBe(true);
    expect(isInlineSafeContentType('image/png; charset=binary')).toBe(true);
    expect(isInlineSafeContentType(' image/png ')).toBe(true);
    expect(isInlineSafeContentType('TEXT/HTML; charset=utf-8')).toBe(false);
    expect(isInlineSafeContentType('Image/SVG+XML')).toBe(false);
  });

  it('未知类型不 inline', () => {
    for (const type of ['', 'application/octet-stream', 'application/x-msdownload', 'weird']) {
      expect(isInlineSafeContentType(type)).toBe(false);
    }
  });
});

/**
 * 附件落盘文件名。
 *
 * 附件目录现在**明放在项目文件树里**,所以名字得让人认得出 —— 原先的
 * `1787648734803-93142742.png` 在文件树里就是一串噪音。但可读不能以放松约束
 * 为代价,下面三条一条都不能松,这里逐条钉住。
 */

import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { buildAttachmentFilename } from '../services/image-assets.service.js';

describe('buildAttachmentFilename', () => {
  it('扩展名只由已校验的 MIME 决定,不听上传方的', () => {
    // 关键用例:上传方把文件名写成 .html,MIME 声明是 png。
    // 让上传方决定扩展名,配合按扩展名定 Content-Type 的取文件路由,就能在
    // 应用同源下拿到一个 inline 的 HTML 文档 —— 而 JWT 就在 localStorage 里。
    expect(buildAttachmentFilename('evil.html', 'image/png')).toMatch(/\.png$/);
    expect(buildAttachmentFilename('x.svg', 'image/jpeg')).toMatch(/\.jpg$/);
    expect(buildAttachmentFilename('a.png', 'image/webp')).toMatch(/\.webp$/);
    // 未知 MIME 落到 .bin —— 取文件时会被当附件下载
    expect(buildAttachmentFilename('a.png', 'application/x-weird')).toMatch(/\.bin$/);
  });

  it('不留任何路径分隔符或穿越片段', () => {
    for (const evil of [
      '../../etc/passwd.png',
      '..\\..\\windows\\system32\\a.png',
      '/absolute/path.png',
      'sub/dir/name.png',
    ]) {
      const built = buildAttachmentFilename(evil, 'image/png');
      expect(built).not.toContain('/');
      expect(built).not.toContain('\\');
      expect(built).not.toContain('..');
      expect(path.basename(built)).toBe(built);
    }
  });

  it('同名文件不会互相覆盖', () => {
    const first = buildAttachmentFilename('截图.png', 'image/png');
    const second = buildAttachmentFilename('截图.png', 'image/png');
    expect(first).not.toBe(second);
  });

  it('中文名保留下来,还认得出是哪个文件', () => {
    expect(buildAttachmentFilename('季度报表.png', 'image/png')).toMatch(/^季度报表-[a-z0-9]+\.png$/);
  });

  it('各系统的保留字符被洗掉', () => {
    const built = buildAttachmentFilename('a:b*c?d"e<f>g|h.png', 'image/png');
    for (const forbidden of [':', '*', '?', '"', '<', '>', '|']) {
      expect(built).not.toContain(forbidden);
    }
  });

  it('控制字符被洗掉', () => {
    const withControl = `a${String.fromCharCode(0)}b${String.fromCharCode(10)}c.png`;
    const built = buildAttachmentFilename(withControl, 'image/png');
    const controlRange = new RegExp('[\\u0000-\\u001f]');
    expect(controlRange.test(built)).toBe(false);
    expect(built).toMatch(/^a_b_c-[a-z0-9]+\.png$/);
  });

  it('空名、纯点、超长名都有兜底', () => {
    expect(buildAttachmentFilename('', 'image/png')).toMatch(/^attachment-[a-z0-9]+\.png$/);
    expect(buildAttachmentFilename('...', 'image/png')).toMatch(/^attachment-[a-z0-9]+\.png$/);
    const long = buildAttachmentFilename(`${'长'.repeat(300)}.png`, 'image/png');
    expect(long.length).toBeLessThan(80);
  });
});

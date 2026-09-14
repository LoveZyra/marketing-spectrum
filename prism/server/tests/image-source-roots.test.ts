import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ATTACHMENT_DIR_NAME as ATTACHMENT_DIR_IN_IMAGES, imageSourceRoots, isAllowedImageSourcePath } from '@/shared/image-attachments.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';

/**
 * A7:一张图片可以来自哪些目录 —— **只有一个答案**。
 *
 * 之前这个问题在三个地方各答了一遍,而且答案不同:上传落盘按前端传的
 * `projectId`、`chat.send` 按 `sessions.project_path`、组装给模型按运行时 cwd。
 * 只要有一处对不齐,图片就在那道门被静默丢掉,而**界面照样显示得好好的** ——
 * 用户看到的是"图在页面上,模型却说传不进来"。
 */
describe('两个 ATTACHMENT_DIR_NAME 必须相等', () => {
  it('image-attachments 里那份与 attachment-storage 里那份是同一个值', () => {
    // 就地定义是为了不把配额/落盘那一整套依赖拖进 provider 侧的构建路径,
    // 代价是它可能和另一处漂开 —— 漂开就等于"上传落哪"和"允许读哪"再次分家。
    expect(ATTACHMENT_DIR_IN_IMAGES).toBe(ATTACHMENT_DIR_NAME);
  });
});

describe('imageSourceRoots', () => {
  const cwd = path.join(os.tmpdir(), 'a7-proj');

  it('包含 cwd 自己的 attachments/ —— 图片就落在那儿', () => {
    expect(imageSourceRoots(cwd)).toContain(path.join(cwd, ATTACHMENT_DIR_NAME));
  });

  it('显式传入的项目根,连同它的 attachments/ 一起认', () => {
    const other = path.join(os.tmpdir(), 'a7-other');
    const roots = imageSourceRoots(cwd, [other]);
    expect(roots).toContain(other);
    expect(roots).toContain(path.join(other, ATTACHMENT_DIR_NAME));
  });
});

describe('isAllowedImageSourcePath', () => {
  const cwd = path.join(os.tmpdir(), 'a7-proj');

  it('cwd 下的 attachments/ 里的图放行(此前只认 cwd 本身与全局图库)', () => {
    expect(isAllowedImageSourcePath(path.join(cwd, ATTACHMENT_DIR_NAME, 'shot.png'), cwd)).toBe(true);
  });

  it('cwd 之外的项目 attachments/ —— 不传项目根时拒绝', () => {
    const other = path.join(os.tmpdir(), 'a7-other', ATTACHMENT_DIR_NAME, 'shot.png');
    expect(isAllowedImageSourcePath(other, cwd)).toBe(false);
  });

  it('传了项目根就放行 —— 这就是 chat.send 那道门递过来的结论', () => {
    const otherRoot = path.join(os.tmpdir(), 'a7-other');
    const other = path.join(otherRoot, ATTACHMENT_DIR_NAME, 'shot.png');
    expect(isAllowedImageSourcePath(other, cwd, [otherRoot])).toBe(true);
  });

  it('系统敏感目录照旧拒绝(放宽的是项目内,不是任意路径)', () => {
    expect(isAllowedImageSourcePath('/etc/passwd', cwd)).toBe(false);
    expect(isAllowedImageSourcePath(path.join(os.homedir(), '.ssh', 'id_rsa'), cwd)).toBe(false);
    expect(isAllowedImageSourcePath('/etc/passwd', cwd, [path.join(os.tmpdir(), 'a7-other')])).toBe(false);
  });

  it('传进来的项目根是空串时被忽略,不会把整个文件系统放开', () => {
    expect(isAllowedImageSourcePath('/etc/passwd', cwd, ['', '   '])).toBe(false);
  });
});

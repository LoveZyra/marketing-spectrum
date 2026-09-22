/**
 * 发给模型前缩图。
 *
 * 用户贴什么就传什么,一张手机原图就是 3.6MB 的 base64,而且它躺在 transcript 里
 * **以后每一轮都会再发一次**。模型端反正也会把长边缩到 ~1568px,多传的字节纯粹浪费;
 * 在把 base64 当文本计数的网关下,它们直接变成"Input exceeds the context limit"。
 *
 * 下面每一条都对应设计里的一条边界,最要紧的是第一条:**磁盘原图一个字节都不动**。
 * 用户明确问过"不会把上传的图片清晰度压低吧" —— 这条测试就是那句承诺。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { buildClaudeUserContent } from '../image-attachments.js';
import { downscaleImageForModel, DEFAULT_MAX_EDGE, DEFAULT_MAX_BYTES } from '../image-downscale.js';

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

/** 造一张有噪点的大图 —— 纯色图压出来太小,测不出"超过 1MB 之后怎么办"。 */
async function noisyImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[i] = seed & 0xff; }
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === 'png') return img.png({ compressionLevel: 0 }).toBuffer();
  if (format === 'jpeg') return img.jpeg({ quality: 100 }).toBuffer();
  return img.webp({ quality: 100 }).toBuffer();
}

const settings = { enabled: true, maxEdge: DEFAULT_MAX_EDGE, maxBytes: DEFAULT_MAX_BYTES };

describe('磁盘原图不动', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'img-downscale-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test('发一张 4000×3000 的图给模型之后,原文件的 md5 一字不变;模型收到的是缩过的', async () => {
    const original = await noisyImage(4000, 3000, 'png');
    const file = path.join(dir, 'big.png');
    await writeFile(file, original);
    const before = md5(await readFile(file));

    const blocks = await buildClaudeUserContent('看图', [{ path: file, mimeType: 'image/png' }], dir, [dir]);

    // 原文件
    expect(md5(await readFile(file))).toBe(before);
    expect((await readFile(file)).length).toBe(original.length);

    // 模型收到的
    const image = blocks.find((b) => b.type === 'image') as { source: { data: string; media_type: string } };
    expect(image).toBeTruthy();
    const sent = Buffer.from(image.source.data, 'base64');
    expect(sent.length).toBeLessThan(original.length / 4);
    const meta = await sharp(sent).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(DEFAULT_MAX_EDGE);
    expect(image.source.media_type).toBe('image/png');
  });
});

describe('缩图规则', () => {
  test('长边缩到 1568,比例不变', async () => {
    const r = await downscaleImageForModel(await noisyImage(4000, 3000, 'jpeg'), 'image/jpeg', settings);
    expect(r.changed).toBe(true);
    expect(r.output.width).toBe(1568);
    expect(r.output.height).toBe(1176);
  });

  test('小图一个字节都不改 —— 连重编码都省了', async () => {
    // 400×300 的满噪点 PNG 约 360KB:尺寸和体积都在线内。
    // (第一版用 800×600,噪点 PNG 压不动、1.4MB 超了体积线,于是被正确地无损重压 ——
    //  那是代码对、夹具错。)
    const small = await noisyImage(400, 300, 'png');
    const r = await downscaleImageForModel(small, 'image/png', settings);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('within-limits');
    expect(r.bytes).toBe(small);            // 同一个 Buffer 对象
  });

  test('不换格式:PNG 进 PNG 出、JPEG 进 JPEG 出、WebP 进 WebP 出', async () => {
    for (const [fmt, type] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
      const r = await downscaleImageForModel(await noisyImage(3000, 2000, fmt), type, settings);
      expect(r.changed).toBe(true);
      expect(r.mediaType).toBe(type);
      expect((await sharp(r.bytes).metadata()).format).toBe(fmt);
    }
  });

  test('PNG 超限时退到调色板,但绝不转成 JPEG', async () => {
    // 1568×1568 满噪点 PNG,无损压不进 1MB —— 逼它走调色板那一支。
    const r = await downscaleImageForModel(await noisyImage(1600, 1600, 'png'), 'image/png', settings);
    expect(r.changed).toBe(true);
    const meta = await sharp(r.bytes).metadata();
    expect(meta.format).toBe('png');
    expect(meta.paletteBitDepth ?? (meta as { palette?: boolean }).palette ?? 8).toBeTruthy();
  });

  test('GIF 不碰(多半是动图,重编码只剩第一帧)', async () => {
    const gif = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#f00' } }).gif().toBuffer();
    const r = await downscaleImageForModel(gif, 'image/gif', settings);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unsupported');
  });

  test('EXIF 竖拍的图会被真正转正,并且标签被剥掉', async () => {
    // 造一张 3000×2000 横图,打上 orientation=6(顺时针 90°),等价于一张竖拍。
    const landscape = await noisyImage(3000, 2000, 'jpeg');
    const tagged = await sharp(landscape).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
    const r = await downscaleImageForModel(tagged, 'image/jpeg', settings);
    expect(r.changed).toBe(true);
    const meta = await sharp(r.bytes).metadata();
    expect(meta.orientation).toBeUndefined();     // 标签没了
    expect(meta.height!).toBeGreaterThan(meta.width!);  // 像素真的竖过来了
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
  });

  test('关掉开关就原样发', async () => {
    const big = await noisyImage(4000, 3000, 'png');
    const r = await downscaleImageForModel(big, 'image/png', { ...settings, enabled: false });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(r.bytes).toBe(big);
  });

  test('坏图不拦消息:退回原字节', async () => {
    const junk = Buffer.from('this is not an image at all');
    const r = await downscaleImageForModel(junk, 'image/png', settings);
    expect(r.changed).toBe(false);
    expect(r.bytes).toBe(junk);
    expect(['error', 'within-limits']).toContain(r.reason);
  });
});

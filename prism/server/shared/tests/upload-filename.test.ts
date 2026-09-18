/**
 * multipart 文件名的 latin1→UTF-8 恢复。
 *
 * 这个判据原来写死在 documents.js 里,于是**只有文档上传**的中文名是好的:
 * 图片附件与文件树上传两条路拿 `file.originalname` 原样用,`附件.png` 以
 * `é™„ä»¶.png` 落盘(2026-09-15 在测试环境实测)。提到 shared 层之后三条路共用
 * 一份 —— 所以这里既钉判据本身,也钉"三条路都真的用上了"。
 */

import { Readable } from 'node:stream';

import multer from 'multer';
import { describe, it, expect } from 'vitest';

import { recoverUploadFilename } from '../upload-filename.js';
import { buildAttachmentFilename, buildStoredImageRecords } from '../../modules/assets/services/image-assets.service.js';

/** 浏览器发的是 UTF-8 字节,busboy 按 latin1 逐字节读 —— 这就是那一步。 */
const asBusboyWouldRead = (name: string): string => Buffer.from(name, 'utf8').toString('latin1');

describe('recoverUploadFilename', () => {
  it('把被当 latin1 读的 UTF-8 名字恢复回来', () => {
    for (const real of ['附件.png', '26年国庆报告.docx', 'gk-test-附件.png', 'ünïcodé.txt', '截图 2026-09-15.png']) {
      const mojibake = asBusboyWouldRead(real);
      expect(mojibake, real).not.toBe(real); // 先确认这一步真把名字弄坏了
      expect(recoverUploadFilename(mojibake)).toBe(real);
    }
  });

  it('纯 ASCII 原样不动', () => {
    for (const name of ['report.docx', 'a.png', 'UPPER_case-1.2.3.tar.gz', '']) {
      expect(recoverUploadFilename(name)).toBe(name);
    }
  });

  it('已经是正常 Unicode 的名字绝不碰(幂等:恢复过的不会再被恢复一次)', () => {
    for (const real of ['附件.png', '报告.docx', 'ünïcodé.txt']) {
      expect(recoverUploadFilename(real)).toBe(real);
      expect(recoverUploadFilename(recoverUploadFilename(asBusboyWouldRead(real)))).toBe(real);
    }
  });

  it('真的单字节 latin1 名字不被改坏(往返对不上就保持原样)', () => {
    // 孤立的 0xE9 不是合法 UTF-8 起始序列,解出来是替换字符,编回去对不上。
    expect(recoverUploadFilename('café.txt')).toBe('café.txt');
    expect(recoverUploadFilename('über.txt')).toBe('über.txt');
  });

  it('空值给空串(调用方自己兜底名)', () => {
    expect(recoverUploadFilename(null)).toBe('');
    expect(recoverUploadFilename(undefined)).toBe('');
    expect(recoverUploadFilename('')).toBe('');
  });
});

/**
 * 图片附件那条路:落盘名与回给前端的显示名都必须过恢复。
 * 把 `recoverUploadFilename` 从 image-assets.service 里摘掉,这两条就红。
 */
describe('图片附件上传路径用上了恢复', () => {
  it('落盘名带回中文(而不是 é™„ä»¶)', () => {
    const built = buildAttachmentFilename(asBusboyWouldRead('附件.png'), 'image/png');
    expect(built).toMatch(/^附件-[a-z0-9]{1,6}\.png$/);
    expect(built).not.toContain('Ã');
  });

  it('回给前端的显示名与落盘名同一个来源,不会一个中文一个乱码', () => {
    const mojibake = asBusboyWouldRead('gk-test-附件.png');
    const [record] = buildStoredImageRecords([
      { originalname: mojibake, filename: buildAttachmentFilename(mojibake, 'image/png'), size: 42, mimetype: 'image/png' },
    ]);
    expect(record.name).toBe('gk-test-附件.png');
    expect(path0(record.path)).toMatch(/^gk-test-附件-[a-z0-9]{1,6}\.png$/);
  });
});

/** 取路径最后一段(不引 node:path,避免 Windows 分隔符的歧义)。 */
function path0(value: string): string {
  const parts = value.split('/');
  return parts[parts.length - 1];
}

/**
 * 真跑一遍 multer:上面的 `asBusboyWouldRead` 是对 busboy 行为的模拟,这一条把
 * 模拟与真实对齐 —— 不然整套断言可能钉的是一个想象出来的病。
 *
 * 2026-09-15 实测(multer 2.0.x):`附件.png` 的 `originalname` 码点是
 * `e9 99 84 e4 bb b6 2e 70 6e 67` —— UTF-8 的六个字节被逐字节当成了字符。
 *
 * 断言写成**不变量**而不是"一定是乱码":哪天 multer 改了默认字符集,
 * `recoverUploadFilename` 因为「码点 > 0xFF 就不碰」会自动变成空操作,这一条照样绿。
 */
describe('multer 的真实行为', () => {
  const parseOneUpload = (filename: string): Promise<string> => new Promise((resolve, reject) => {
    const boundary = '----prism-upload-filename-test';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, 'utf8'),
      Buffer.from(`Content-Disposition: form-data; name="files"; filename="${filename}"\r\n`, 'utf8'),
      Buffer.from('Content-Type: image/png\r\n\r\n', 'utf8'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]), // 四个字节的假 PNG 头,够了
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    // multer 只要一个「带 headers 的可读流」,不需要真的起一个 server。
    const req = Readable.from([body]) as unknown as {
      headers: Record<string, string>;
      files?: Array<{ originalname: string }>;
    };
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    multer({ storage: multer.memoryStorage() }).array('files', 1)(
      req as never,
      {} as never,
      (error: unknown) => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(req.files?.[0]?.originalname ?? '');
      },
    );
  });

  it('恢复之后拿回真名字(不管 multer 当下按什么字符集读)', async () => {
    for (const real of ['附件.png', '26年国庆报告.png', 'plain.png']) {
      expect(recoverUploadFilename(await parseOneUpload(real)), real).toBe(real);
    }
  });

  it('模拟与真实一致:asBusboyWouldRead 给出的就是 multer 给的那个串', async () => {
    const real = '附件.png';
    const fromMulter = await parseOneUpload(real);
    // 今天这里是乱码;哪天不是了,下一行会告诉我们(而上一条不变量仍然绿)。
    expect(fromMulter).toBe(asBusboyWouldRead(real));
  });
});

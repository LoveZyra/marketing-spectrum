import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import { formatBytes, formatKilobytes } from './formatBytes';

/**
 * 字节展示口径:**前后端必须同答案**,而且只能有一份实现。
 *
 * 这个仓库里曾经有四份 `formatBytes` / `formatFileSize`,其中两份渲染在**同一个
 * 设置面板里**(`ServerStatusTab` 与它的子组件 `RuntimeStatsSection`)—— 上下并排、
 * MB 档小数位不同,肉眼可见的漂。另外两处各有各的缺档(缺 `< 1KB`、缺 GB)。
 *
 * 没有安全后果,但它是"抄一遍就会漂、漂了没人发现"最干净的样本。所以这里钉两条:
 * 各档边界的具体答案,以及**前端源码里不许再出现第二份实现**。
 */
describe('formatBytes', () => {
  test('四档边界', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');            // 曾经有一份在这里印 "0 KB"
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '2 KB');            // KB 取整,不留小数
    assert.equal(formatBytes(1024 ** 2), '1.0 MB');
    assert.equal(formatBytes(1024 ** 2 * 1.25), '1.3 MB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GB');
    assert.equal(formatBytes(1024 ** 3 * 2.5), '2.5 GB'); // 曾经有一份在这里印 "2560.0 MB"
  });

  test('脏输入不炸', () => {
    assert.equal(formatBytes(undefined), '0 B');
    assert.equal(formatBytes(null), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });

  test('formatKilobytes 就是 ×1024', () => {
    assert.equal(formatKilobytes(1), '1 KB');
    assert.equal(formatKilobytes(2048), '2.0 MB');
  });

  test('与服务端那份逐字同口径', () => {
    // 服务端 server/shared/attachment-storage.ts 里有一份同名函数。两端各留一份是
    // 有意的(前端不引服务端代码),但答案必须一致 —— 这里直接把它的实现读出来比。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverFile = path.resolve(here, '../../server/shared/attachment-storage.ts');
    const source = fs.readFileSync(serverFile, 'utf8');
    const body = source.match(/export function formatBytes\(bytes: number\): string \{([\s\S]*?)\n\}/);
    assert.ok(body, '服务端 formatBytes 的形状变了,这条比对失效了 —— 请同步更新');
    const serverFormat = new Function('bytes', body[1].replace(/`/g, '`')) as (n: number) => string;
    for (const value of [0, 1, 512, 1023, 1024, 4096, 1024 ** 2, 1024 ** 2 * 3.7, 1024 ** 3, 1024 ** 3 * 9.9]) {
      assert.equal(formatBytes(value), serverFormat(value), `${value} 字节两端不一致`);
    }
  });

  test('前端源码里不许再出现第二份实现', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.endsWith(path.join('utils', 'formatBytes.ts'))) continue;
        if (entry.name.includes('.test.')) continue;
        const text = fs.readFileSync(full, 'utf8');
        // 自己实现的判据:出现 1024 ** 2 之类的分档运算
        if (/1024\s*\*\*\s*[23]|1024\s*\*\s*1024/.test(text) && /toFixed\(\s*[01]\s*\)/.test(text)) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    assert.deepEqual(offenders, [], `这些文件像是又抄了一份字节格式化,请改用 utils/formatBytes:\n  ${offenders.join('\n  ')}`);
  });
});

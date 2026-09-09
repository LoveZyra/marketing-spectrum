import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import { buildLookupMap, extractFirstValidJsonlData } from '@/shared/utils.js';

/**
 * 两个 JSONL 读取函数**不许漏文件描述符**,坏行也不许让整份文件白读。
 *
 * ## 为什么值得钉
 *
 * 这两个函数用 `for await (const line of readline)` 逐行读。异步迭代器被 throw 或
 * break 打断时(abrupt completion),底层流没走到 'end' —— autoClose 不触发,GC 也
 * 不回收,fd 是**永久泄漏**。原来的写法只在成功路径上关流,两条 abrupt 出口都漏。
 *
 * 这不是理论问题,两条路都极其容易踩:
 *   - `~/.claude/history.jsonl` 只要有一行坏 JSON(CLI 崩在 append 中途、盘满,
 *     都会留下永久截断的一行),`buildLookupMap` 就抛 —— 而这个文件**每来一条
 *     prompt 就重读一次**;
 *   - `extractFirstValidJsonlData` 的语义就是"命中即停",每次成功都是一次 break。
 *
 * 泄漏到 `ulimit -n` 之后,服务表现为"活着但什么都干不了":accept 失败、
 * transcript 读不了、SQLite 打不开,只能重启。
 *
 * ## 为什么顺带钉"坏行不丢整份文件"
 *
 * 修 fd 的同时把 `JSON.parse` 单独兜住了。之前一行坏行会让循环整个抛出去,
 * 前面已经解析好的行**一起丢掉**——history 里一行截断,整个会话名字映射就空了。
 * 这条断言防止以后有人"简化"掉那层 try。
 */

const FD_DIR = '/proc/self/fd';
const canCountFds = fs.existsSync(FD_DIR);
const countFds = (): number => fs.readdirSync(FD_DIR).length;

let dir: string;
let goodAndBad: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-jsonl-fd-'));
  goodAndBad = path.join(dir, 'history.jsonl');
  // 一行完整 + 一行被截断 —— CLI 崩在 append 中途留下的真实形状
  fs.writeFileSync(goodAndBad, '{"a":"1","b":"x"}\n{"a":"2","b"\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JSONL 读取:fd 与坏行', () => {
  test('坏行不会让整份文件白读', async () => {
    const map = await buildLookupMap(goodAndBad, 'a', 'b');
    // 坏行之前那条必须还在。原来的写法会在坏行处抛出整个循环,这里会是空 Map。
    assert.equal(map.get('1'), 'x');
    assert.equal(map.size, 1);
  });

  test.skipIf(!canCountFds)('反复读带坏行的文件不漏 fd', async () => {
    await buildLookupMap(goodAndBad, 'a', 'b'); // 预热,别把首次的懒加载算进来
    const before = countFds();
    for (let i = 0; i < 40; i += 1) {
      await buildLookupMap(goodAndBad, 'a', 'b');
    }
    // 留一点余量给运行时自己的临时 fd;真漏的话这里会是 +40。
    assert.ok(countFds() <= before + 3, `fd 从 ${before} 涨到 ${countFds()}`);
  });

  test.skipIf(!canCountFds)('提前命中(break 语义)不漏 fd', async () => {
    const hit = (parsed: unknown): string | null => {
      const row = parsed as { a?: string };
      return typeof row?.a === 'string' ? row.a : null;
    };
    await extractFirstValidJsonlData(goodAndBad, hit);
    const before = countFds();
    for (let i = 0; i < 40; i += 1) {
      const got = await extractFirstValidJsonlData(goodAndBad, hit);
      assert.equal(got, '1'); // 顺带确认命中即停确实还在工作
    }
    assert.ok(countFds() <= before + 3, `fd 从 ${before} 涨到 ${countFds()}`);
  });

  test.skipIf(!canCountFds)('扫到底没命中也不漏 fd', async () => {
    await extractFirstValidJsonlData(goodAndBad, () => null);
    const before = countFds();
    for (let i = 0; i < 40; i += 1) {
      await extractFirstValidJsonlData(goodAndBad, () => null);
    }
    assert.ok(countFds() <= before + 3, `fd 从 ${before} 涨到 ${countFds()}`);
  });

  test('文件不存在时不抛,也不漏', async () => {
    const missing = path.join(dir, 'nope.jsonl');
    assert.deepEqual([...(await buildLookupMap(missing, 'a', 'b'))], []);
    assert.equal(await extractFirstValidJsonlData(missing, () => 'x'), null);
  });
});

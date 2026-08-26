import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { pushReplayChunk } from '../shell-replay-buffer.js';

const bytes = (text: string) => Buffer.byteLength(text);

/**
 * B5 回归:PTY 回放缓冲按字节裁,不按条数。
 *
 * 旧上限只数 5000 条,单块不设限 —— `cat` 大文件的单个巨块能把缓冲挂到几十 MB。
 */
describe('pushReplayChunk', () => {
  test('未超预算:全留,字节合计正确', () => {
    const buffer: string[] = [];
    let total = 0;
    total = pushReplayChunk(buffer, total, 'abc', 1000, 10, bytes);
    total = pushReplayChunk(buffer, total, 'de', 1000, 10, bytes);
    assert.deepEqual(buffer, ['abc', 'de']);
    assert.equal(total, 5);
  });

  test('超字节预算:从头部丢最老的,直到落回预算内', () => {
    const buffer: string[] = [];
    let total = 0;
    // 预算 10 字节。逐个塞 4 字节块。
    for (const chunk of ['aaaa', 'bbbb', 'cccc']) {
      total = pushReplayChunk(buffer, total, chunk, 10, 100, bytes);
    }
    // aaaa+bbbb+cccc=12 > 10 → 丢掉 aaaa,剩 bbbb+cccc=8。
    assert.deepEqual(buffer, ['bbbb', 'cccc']);
    assert.equal(total, 8);
  });

  test('单个块就超字节预算:连它一起丢,缓冲留空(宁空不挂巨块)', () => {
    const buffer: string[] = [];
    const huge = 'x'.repeat(50);
    const total = pushReplayChunk(buffer, 0, huge, 10, 100, bytes);
    assert.deepEqual(buffer, []);
    assert.equal(total, 0);
  });

  test('条数兜底:海量小块也会按条数上限裁', () => {
    const buffer: string[] = [];
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      total = pushReplayChunk(buffer, total, 'x', 10_000, 3, bytes);
    }
    // 字节远没超,但条数上限 3 → 只留最后 3 条。
    assert.equal(buffer.length, 3);
    assert.equal(total, 3);
  });

  test('多字节 UTF-8 按字节而非字符数计', () => {
    const buffer: string[] = [];
    // '中' = 3 字节。预算 6 字节 → 最多留 2 个。
    let total = 0;
    total = pushReplayChunk(buffer, total, '中', 6, 100, bytes);
    total = pushReplayChunk(buffer, total, '文', 6, 100, bytes);
    total = pushReplayChunk(buffer, total, '字', 6, 100, bytes);
    assert.deepEqual(buffer, ['文', '字']);
    assert.equal(total, 6);
  });
});

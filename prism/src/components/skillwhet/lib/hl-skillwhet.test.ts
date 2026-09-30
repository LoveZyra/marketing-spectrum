import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { buildUploadBundle } from './skill-upload';
import { checkTasks, jsonErrorLine, parseRows } from './task-upload';

/**
 * hl 修复轮(2026-09-29)—— 技能优化前端的两条 P3:
 *   · JSONL 一行坏掉退成 JSON 时给行号、提示手选格式(原来只有 `position 49`);
 *   · 上传对话框 SKILL.md 在子目录时明确标出(原来悄悄拿子目录名当技能名)。
 */
describe('hl · 任务集导入的报错定位', () => {
  test('JSON 解析失败给行 / 列;多行对象提示可能是 JSONL', () => {
    const content = '{"input":"a","expected_output":1}\n{"input":"b","expected_output":2\n{"input":"c","expected_output":3}';
    assert.throws(() => parseRows(content, 'json'), (error: Error) => /第 \d+ 行/.test(error.message) && /jsonl/i.test(error.message));
    const at = jsonErrorLine('ab\ncd\nef', 'Unexpected token at position 4');
    assert.deepEqual(at, { line: 2, column: 2 });
    assert.deepEqual(jsonErrorLine('', 'JSON.parse: bad at line 3 column 7'), { line: 3, column: 7 });
    assert.equal(jsonErrorLine('x', 'no position here'), null);
    // 手选 jsonl 后逐行报错自带行号
    assert.throws(() => parseRows(content, 'jsonl'), /第 2 行/);
  });
});

describe('hl 复核 P3 · CSV 空单元格与 serve 同口径', () => {
  test('可选列留空当缺省;空 expected_output = 没给,没有 rubric 就拒', () => {
    const csv = 'task_id,input,expected_output,rubric,split,checks\nt1,hello,world,,,\nt2,hi,,a rubric long enough,,\nt3,yo,,,,\n';
    const r = checkTasks(csv, 'csv');
    assert.deepEqual(r.rows.map((x) => [x.ok, x.referenceKind]), [[true, 'exact'], [true, 'rubric'], [false, '']]);
    assert.match(r.rows[2].errors[0], /expected_output/);
  });
});

class FakeFile extends Blob {
  name: string;
  webkitRelativePath: string;
  constructor(rel: string, content = 'x') {
    super([content]);
    this.name = rel.split('/').pop() ?? rel;
    this.webkitRelativePath = rel;
  }
}

describe('hl · 上传技能:SKILL.md 在子目录', () => {
  test('标出 nestedRoot 与所选文件夹名;在根时不标', async () => {
    const polyfill = typeof globalThis.FileReader === 'undefined';
    if (polyfill) {
      // node 侧没有 FileReader:给一个最小实现(readAsDataURL → base64)
      (globalThis as unknown as { FileReader: unknown }).FileReader = class {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        error: Error | null = null;
        readAsDataURL(file: Blob) {
          void file.arrayBuffer().then((buf) => { this.result = `data:application/octet-stream;base64,${Buffer.from(buf).toString('base64')}`; this.onload?.(); });
        }
      };
    }
    try {
      const nested = await buildUploadBundle([new FakeFile('bundle/period-report/SKILL.md', '---\nname: period-report\n---\n'), new FakeFile('bundle/README.md')] as unknown as File[]);
      assert.equal(nested.name, 'period-report');
      assert.equal(nested.nestedRoot, 'bundle/period-report');
      assert.equal(nested.pickedFolder, 'bundle');
      assert.deepEqual(nested.files.map((f) => f.rel), ['SKILL.md']);
      const flat = await buildUploadBundle([new FakeFile('period-report/SKILL.md'), new FakeFile('period-report/scripts/a.py')] as unknown as File[]);
      assert.equal(flat.nestedRoot, undefined);
      assert.equal(flat.name, 'period-report');
    } finally {
      if (polyfill) delete (globalThis as unknown as { FileReader?: unknown }).FileReader;
    }
  });
});

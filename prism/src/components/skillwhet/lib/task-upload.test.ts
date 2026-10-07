import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { checkTasks, detectFormat, keepPassing, parseRows, TASK_TEMPLATES } from './task-upload';

/**
 * 任务集的浏览器侧校验,与 SkillWhet `imports.validate_and_map` 同一套规则;
 * 这里钉住的每一条都在 Python 侧的 `tests/test_imports.py` 有对应用例。
 */
describe('task-upload · 格式识别', () => {
  test('按扩展名优先,没有扩展名看内容', () => {
    assert.equal(detectFormat('a.jsonl', ''), 'jsonl');
    assert.equal(detectFormat('a.csv', ''), 'csv');
    assert.equal(detectFormat('a.json', ''), 'json');
    assert.equal(detectFormat(null, '[{"a":1}]'), 'json');
    assert.equal(detectFormat(null, '{"a":1}\n{"b":2}'), 'jsonl');
    assert.equal(detectFormat(null, 'task_id,input\nx,y'), 'csv');
  });
});

describe('task-upload · 逐行校验', () => {
  test('设计稿那四行:两通过、缺 expected_output、task_id 重复', () => {
    const content = JSON.stringify([
      { task_id: 'case-001', group_id: 'rate-a', input: { visits: 100, conversions: 8 }, expected_output: { rate: 0.08 } },
      { task_id: 'case-002', group_id: 'rate-a', input: { visits: 0, conversions: 0 }, expected_output: { rate: 0 } },
      { task_id: 'case-003', input: { visits: 50 } },
      { task_id: 'case-001', input: { visits: 20, conversions: 1 }, expected_output: { rate: 0.05 } },
    ]);
    const report = checkTasks(content, 'json');
    assert.equal(report.fatal, null);
    assert.deepEqual(report.rows.map((row) => row.ok), [true, true, false, false]);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 2);
    assert.match(report.rows[2].errors[0], /缺 expected_output/);
    assert.match(report.rows[3].errors[0], /与第 1 行相同/);
    assert.equal(report.rows[0].referenceKind, 'exact');
    assert.equal(report.rows[0].family, 'rate-a');
  });

  test('0 / false / null 是合法的 expected_output;rubric ≥ 8 字也算判据', () => {
    const report = checkTasks(JSON.stringify([
      { input: 'a', expected_output: 0 },
      { input: 'b', expected_output: false },
      { input: 'c', expected_output: null },
      { input: 'd', rubric: '至少要有八个字才算数' },
      { input: 'e', rubric: '太短' },
    ]), 'json');
    assert.deepEqual(report.rows.map((row) => row.ok), [true, true, true, true, false]);
    assert.equal(report.rows[3].referenceKind, 'rubric');
  });

  test('input 空串不算;split 只认 train/val/test 及别名;checks 必须是对象数组', () => {
    const report = checkTasks(JSON.stringify([
      { input: '   ', expected_output: 1 },
      { input: 'x', expected_output: 1, split: 'holdout' },
      { input: 'x', expected_output: 1, split: 'prod' },
      { input: 'x', expected_output: 1, checks: 'nope' },
    ]), 'json');
    assert.deepEqual(report.rows.map((row) => row.ok), [false, true, false, false]);
    assert.match(report.rows[0].errors[0], /缺 input/);
    assert.match(report.rows[2].errors[0], /split 只能是/);
    assert.match(report.rows[3].errors[0], /checks 必须是对象数组/);
  });

  test('jsonl 与 csv 都能解析;csv 的 expected_output 数字与 JSON 列会被还原', () => {
    const jsonl = checkTasks('{"input":"a","expected_output":1}\n\n{"input":"b","rubric":"八个字八个字八个字"}', 'jsonl');
    assert.equal(jsonl.passed, 2);
    const csv = checkTasks(TASK_TEMPLATES['tasks.csv'], 'csv');
    assert.equal(csv.passed, 2, JSON.stringify(csv));
    const rows = parseRows(TASK_TEMPLATES['tasks.csv'], 'csv');
    assert.deepEqual(rows[0].input, { visits: 100, conversions: 8 });
    assert.equal(rows[1].expected_output, 0);
  });

  test('解析失败给 fatal,不抛', () => {
    assert.match(checkTasks('{not json', 'json').fatal ?? '', /不是合法 JSON/);
    assert.match(checkTasks('{"a":1}', 'json').fatal ?? '', /顶层必须是 JSON 数组/);
    assert.match(checkTasks('[1,2]', 'json').fatal ?? '', /每一行都必须是对象/);
  });

  test('三份模板自身都通过校验', () => {
    assert.equal(checkTasks(TASK_TEMPLATES['exact.json'], 'json').failed, 0);
    assert.equal(checkTasks(TASK_TEMPLATES['rubric.jsonl'], 'jsonl').failed, 0);
    assert.equal(checkTasks(TASK_TEMPLATES['tasks.csv'], 'csv').failed, 0);
  });
});

describe('task-upload · 只留通过的', () => {
  test('剔掉失败行,jsonl 保持 jsonl,csv 回成 json', () => {
    const content = '{"input":"a","expected_output":1}\n{"input":"b"}';
    const report = checkTasks(content, 'jsonl');
    const kept = keepPassing(content, 'jsonl', report);
    assert.equal(kept.format, 'jsonl');
    assert.equal(kept.content.split('\n').length, 1);
    const csvReport = checkTasks(TASK_TEMPLATES['tasks.csv'], 'csv');
    assert.equal(keepPassing(TASK_TEMPLATES['tasks.csv'], 'csv', csvReport).format, 'json');
  });
});

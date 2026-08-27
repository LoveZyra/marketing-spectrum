import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { parseVimgrepLine, searchProjectFiles } from '@/modules/files/services/project-search.service.js';

/**
 * F10:跨文件全局搜索。
 *
 * 文件树的搜索框只匹配**文件名**;人真正要找的常常是内容。这里钉的是三件事:
 * 结果形状(相对路径,不泄漏服务器目录)、默认按字面量(而不是正则),以及
 * **截断如实上报** —— 少给结果而不说,比给少了更糟,用户会以为项目里就这么多。
 */
let repo: string | null = null;

afterEach(async () => {
  if (repo) {
    await rm(repo, { recursive: true, force: true });
    repo = null;
  }
});

async function seedRepo(): Promise<string> {
  repo = await mkdtemp(path.join(tmpdir(), 'project-search-'));
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const TOKEN = 1;\nconst other = TOKEN + 1;\n');
  await writeFile(path.join(repo, 'src', 'b.js'), 'console.log("token in lowercase");\n');
  await writeFile(path.join(repo, 'notes.md'), '# TOKEN 说明\n\n这里讲 TOKEN 是什么。\n');
  return repo;
}

describe('parseVimgrepLine', () => {
  test('切三次冒号 —— 正文里的冒号不能把解析带偏', () => {
    const parsed = parseVimgrepLine('src/a.ts:12:5:const url = "http://x:8080";');
    assert.deepEqual(parsed, {
      path: 'src/a.ts',
      line: 12,
      column: 5,
      text: 'const url = "http://x:8080";',
    });
  });

  test('残缺行返回 null 而不是半个结果', () => {
    assert.equal(parseVimgrepLine('没有冒号'), null);
    assert.equal(parseVimgrepLine('a:b'), null);
    assert.equal(parseVimgrepLine('src/a.ts:notanumber:5:text'), null);
  });

  test('超长行被截断 —— 压缩过的 JS 一行能有几百 KB', () => {
    const parsed = parseVimgrepLine(`src/a.ts:1:1:${'x'.repeat(2000)}`);
    assert.ok(parsed);
    assert.ok(parsed!.text.length < 500);
    assert.ok(parsed!.text.endsWith('…'));
  });
});

describe('searchProjectFiles', () => {
  test('返回相对路径 —— 绝对路径既没用又泄漏服务器目录结构', async () => {
    const root = await seedRepo();
    const result = await searchProjectFiles(root, 'TOKEN');

    assert.equal(result.error, null);
    assert.ok(result.matches.length >= 3);
    assert.ok(result.matches.every((m) => !path.isAbsolute(m.path)), '不该出现绝对路径');
    assert.ok(result.matches.some((m) => m.path === 'src/a.ts'));
    assert.ok(result.matches.some((m) => m.path === 'notes.md'));
  });

  test('默认不区分大小写;勾上后只命中原样', async () => {
    const root = await seedRepo();
    const loose = await searchProjectFiles(root, 'token');
    assert.ok(loose.matches.some((m) => m.path === 'src/a.ts'), '默认应该也命中大写的 TOKEN');

    const strict = await searchProjectFiles(root, 'token', { caseSensitive: true });
    assert.ok(strict.matches.every((m) => m.path === 'src/b.js'), '区分大小写后只剩小写那处');
  });

  test('默认按字面量 —— 正则元字符不该改变含义', async () => {
    const root = await seedRepo();
    await writeFile(path.join(root, 'src', 'c.ts'), 'const x = a.b;\nconst y = axb;\n');

    const literal = await searchProjectFiles(root, 'a.b');
    assert.ok(literal.matches.some((m) => m.text.includes('a.b')));
    assert.ok(!literal.matches.some((m) => m.text.includes('axb')), '字面量搜索不该把 . 当通配');

    const asRegex = await searchProjectFiles(root, 'a.b', { regex: true });
    assert.ok(asRegex.matches.some((m) => m.text.includes('axb')), '打开正则后 . 才是通配');
  });

  test('glob 过滤只搜指定类型', async () => {
    const root = await seedRepo();
    const result = await searchProjectFiles(root, 'TOKEN', { glob: '*.md' });
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.every((m) => m.path.endsWith('.md')));
  });

  test('超过上限时 truncated 为 true —— 少给结果必须说出来', async () => {
    const root = await seedRepo();
    const lines = Array.from({ length: 50 }, (_, index) => `const NEEDLE_${index} = NEEDLE;`).join('\n');
    await writeFile(path.join(root, 'many.ts'), lines);

    const result = await searchProjectFiles(root, 'NEEDLE', { maxMatches: 5 });
    assert.equal(result.matches.length, 5);
    assert.equal(result.truncated, true);
  });

  test('空查询直接返回空,不去起进程', async () => {
    const root = await seedRepo();
    const result = await searchProjectFiles(root, '   ');
    assert.deepEqual(result, { matches: [], truncated: false, error: null });
  });

  test('无命中不是错误', async () => {
    const root = await seedRepo();
    const result = await searchProjectFiles(root, 'zzz-not-here-zzz');
    assert.deepEqual(result.matches, []);
    assert.equal(result.error, null);
  });
});

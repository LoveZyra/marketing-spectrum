import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import { resolveMarkdownImagePath } from '../code-editor/view/subcomponents/markdown/markdownImagePath';

import { pickSubtreesToReload, replaceSubtree, runWithConcurrency } from './hooks/useFileTreeData';
import { chunkUploadBatches, formatOverwrittenMessage, formatUploadFailureMessage } from './hooks/useFileTreeUpload';
import { describeFileServerError } from './utils/serverErrorText';
import { findExistingUploadTargets } from './utils/uploadTargets';
import { emitFileSaved, resetFileSavedListeners, subscribeFileSaved } from './utils/fileTreeEvents';
import type { FileTreeNode } from './types/types';

/** 这些函数只用 defaultValue,不查表 —— 相当于"中文界面、键缺失时"的行为。 */
const t = (_key: string, options: Record<string, unknown> & { defaultValue: string }) => options.defaultValue;

const tree: FileTreeNode[] = [
  { name: 'big', type: 'directory', path: '/p/big', truncated: true, children: [{ name: 'a.txt', type: 'file', path: '/p/big/a.txt' }] },
  { name: 'small', type: 'directory', path: '/p/small', truncated: true, children: [] },
  { name: 'readme.md', type: 'file', path: '/p/readme.md' },
];

describe('文件树前端纯函数', () => {
  test('懒加载:把截断目录的 children 原地换掉,并按服务端的根截断头保留 / 去掉标记', () => {
    const loaded: FileTreeNode[] = [{ name: 'x.txt', type: 'file', path: '/p/small/x.txt' }];
    const next = replaceSubtree(tree, '/p/small', loaded, false);
    const small = next.find((n) => n.name === 'small')!;
    assert.deepEqual(small.children, loaded);
    assert.equal(small.truncated, undefined);
    assert.equal(next[0], tree[0], '没动的兄弟节点保持引用(memo 不被击穿)');
    assert.equal(replaceSubtree(tree, '/p/nope', loaded, false), tree, '找不到就原样返回');
    assert.equal(replaceSubtree(tree, '/p/big', loaded, true).find((n) => n.name === 'big')!.truncated, true);
  });

  test('上传前查同名:只报树里已存在的相对路径(含子目录上传)', () => {
    const nodes: FileTreeNode[] = [
      ...tree,
      { name: 'docs', type: 'directory', path: '/p/docs', children: [{ name: 'a.md', type: 'file', path: '/p/docs/a.md' }] },
    ];
    assert.deepEqual(findExistingUploadTargets(nodes, '/p', ['readme.md', 'new.txt', 'docs/a.md'], ''), ['readme.md', 'docs/a.md']);
    assert.deepEqual(findExistingUploadTargets(nodes, '/p', ['a.txt'], '/p/big'), ['a.txt']);
    assert.deepEqual(findExistingUploadTargets(nodes, null, ['readme.md'], ''), []);
  });

  test('覆盖提示最多列 3 个;超过 20 个文件分批而不是整批拒', () => {
    assert.equal(formatOverwrittenMessage(['a', 'b'], t), '已覆盖同名文件:a、b');
    assert.equal(formatOverwrittenMessage(['a', 'b', 'c', 'd', 'e'], t), '已覆盖同名文件:a、b、c,另有 2 个');
    const batches = chunkUploadBatches(Array.from({ length: 45 }, () => ({ size: 1 })));
    assert.deepEqual(batches.map((b) => b.length), [20, 20, 5]);
  });

  test('小文件装批:个数不超过 20,累计字节不超过一片,按原顺序', () => {
    const MB = 1024 * 1024;
    const chunk = 15 * MB;
    const files = (sizesInMb: number[]) => sizesInMb.map((mb, index) => ({ index, size: mb * MB }));
    const shape = (batches: Array<Array<{ index: number }>>) => batches.map((batch) => batch.map((f) => f.index));
    const totals = (batches: Array<Array<{ size: number }>>) => batches.map((batch) => batch.reduce((sum, f) => sum + f.size, 0));

    // 20 个 12MB:只按个数切会是一个 240MB 的请求
    const big = chunkUploadBatches(files(Array.from({ length: 20 }, () => 12)), { maxBytes: chunk });
    assert.equal(big.length, 20);
    assert.ok(totals(big).every((bytes) => bytes <= chunk));

    assert.deepEqual(shape(chunkUploadBatches(files([5, 5, 5, 5, 1]), { maxBytes: chunk })), [[0, 1, 2], [3, 4]]);
    // 恰好一片的单独成批;顺序不重排
    assert.deepEqual(shape(chunkUploadBatches(files([1, 15, 1]), { maxBytes: chunk })), [[0], [1], [2]]);
    // 个数约束仍在
    const tiny = chunkUploadBatches(Array.from({ length: 45 }, (_, index) => ({ index, size: 10 })), { maxBytes: chunk });
    assert.deepEqual(tiny.map((b) => b.length), [20, 20, 5]);
    assert.deepEqual(chunkUploadBatches([], { maxBytes: chunk }), []);
  });

  test('上传流程按片大小装批(接线)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, 'hooks/useFileTreeUpload.ts'), 'utf8');
    assert.match(source, /chunkUploadBatches\(smallFiles, \{ maxBytes: chunkBytes \}\)/);
  });

  test('反向代理的 413(响应体不是 JSON)给出明确原因;Prism 自己的 413 照旧', () => {
    assert.match(describeFileServerError('Upload failed with status 413', t), /反向代理/);
    assert.match(describeFileServerError('Upload failed with status 413', t), /client_max_body_size/);
    assert.equal(describeFileServerError('File too large. Maximum size is 1GB.', t), '文件太大,超过单文件上限');
    assert.equal(describeFileServerError('Upload failed with status 500', t), 'Upload failed with status 500');
  });

  test('中途失败:说明已经传上去几个、还剩几个', () => {
    assert.equal(formatUploadFailureMessage('上传失败,请检查网络后重试', 0, 30, t), '上传失败,请检查网络后重试');
    const text = formatUploadFailureMessage('上传失败,请检查网络后重试', 20, 30, t);
    assert.match(text, /^上传失败,请检查网络后重试/);
    assert.match(text, /20 个文件已上传/);
    assert.match(text, /其余 10 个没有上传/);
  });

  test('服务端英文错误映射成界面语言;认不得的原样透传', () => {
    assert.equal(describeFileServerError('Directory already exists', t), '同名文件夹已存在');
    assert.equal(describeFileServerError('A file or directory with this name already exists', t), '已存在同名的文件或文件夹');
    assert.equal(describeFileServerError('Too many files. Maximum is 20 files.', t), '一次上传的文件太多');
    assert.equal(describeFileServerError('你同时进行中的大文件上传已有 8 个', t), '你同时进行中的大文件上传已有 8 个');
    assert.equal(describeFileServerError('', t), '操作失败');
  });

  test('保存后刷新树:事件总线送达订阅者,退订后不再收到', () => {
    resetFileSavedListeners();
    const got: string[] = [];
    const off = subscribeFileSaved((p) => got.push(p));
    emitFileSaved('/p/a.txt');
    off();
    emitFileSaved('/p/b.txt');
    assert.deepEqual(got, ['/p/a.txt']);
  });

  test('markdown 相对图片按文件所在目录解析(不按站点根)', () => {
    assert.equal(resolveMarkdownImagePath('./img/chart.png', 'docs/report.md'), 'docs/img/chart.png');
    assert.equal(resolveMarkdownImagePath('../assets/a%20b.png', 'docs/sub/r.md'), 'docs/assets/a b.png');
    assert.equal(resolveMarkdownImagePath('/logo.png', 'docs/r.md'), 'logo.png');
    assert.equal(resolveMarkdownImagePath('https://x/y.png', 'r.md'), null);
    assert.equal(resolveMarkdownImagePath('data:image/png;base64,xx', 'r.md'), null);
    assert.equal(resolveMarkdownImagePath('../../escape.png', 'r.md'), null, '跑出项目根不发请求');
  });
});

describe('刷新后懒加载目录重拉', () => {
  test('只挑仍存在、仍截断、且展开着的缓存目录(基线是把旧子树原样盖回去)', () => {
    const fresh: FileTreeNode[] = [
      { name: 'big', type: 'directory', path: '/p/big', truncated: true, children: [] },
      { name: 'small', type: 'directory', path: '/p/small', truncated: true, children: [] },
      { name: 'done', type: 'directory', path: '/p/done', children: [] },
    ];
    const cached = ['/p/big', '/p/small', '/p/done', '/p/gone'];
    const expanded = new Set(['/p/big', '/p/done', '/p/gone']);
    assert.deepEqual(pickSubtreesToReload(fresh, cached, (p) => expanded.has(p)), ['/p/big']);
  });

  test('嵌套的缓存目录在外层拉回来之后才出现在树上(下一波)', () => {
    const outer: FileTreeNode[] = [{ name: 'a', type: 'directory', path: '/p/a', truncated: true, children: [] }];
    const all = () => true;
    assert.deepEqual(pickSubtreesToReload(outer, ['/p/a', '/p/a/b'], all), ['/p/a']);
    const afterOuter = replaceSubtree(outer, '/p/a', [{ name: 'b', type: 'directory', path: '/p/a/b', truncated: true, children: [] }], false);
    assert.deepEqual(pickSubtreesToReload(afterOuter, ['/p/a/b'], all), ['/p/a/b']);
  });

  test('并发限流:同时在跑的不超过上限,全部跑完', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      done.push(n);
    });
    assert.equal(peak, 3);
    assert.deepEqual([...done].sort(), [1, 2, 3, 4, 5, 6, 7]);
  });
});

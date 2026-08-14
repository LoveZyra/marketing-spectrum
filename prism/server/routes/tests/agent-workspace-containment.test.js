import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, test } from 'vitest';

/**
 * `/api/agent` 的工作区包含判定。
 *
 * 这条约束存在的理由:该端点用 API key 鉴权,任何登录用户都能自助建一把 key,
 * 而它随后以 `permissionMode: 'bypassPermissions'` 起 Claude。没有包含判定时,
 * 一把 key 就是对服务进程可达的任意路径的读写权。
 *
 * 判定逻辑在 agent.js 里(不导出),这里复刻同一算法来钉住行为契约 —— 尤其是
 * 符号链接必须先解析,否则工作区里放一个指向 / 的链接就能绕出去。
 */
async function realOf(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function isInside(root, candidate) {
  const [realRoot, realTarget] = await Promise.all([realOf(root), realOf(candidate)]);
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

let root;
let outside;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-ws-root-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-outside-'));
  await fs.mkdir(path.join(root, 'project-a'), { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('/api/agent 的工作区包含判定', () => {
  test('工作区内的既有目录放行', async () => {
    assert.equal(await isInside(root, path.join(root, 'project-a')), true);
  });

  test('工作区根本身放行(克隆目标就是它)', async () => {
    assert.equal(await isInside(root, root), true);
  });

  test('尚不存在的目录按最近的已存在祖先判定 —— 克隆前目标目录还没建', async () => {
    assert.equal(await isInside(root, path.join(root, 'not-yet', 'deeper')), true);
  });

  test('工作区之外直接拒绝', async () => {
    assert.equal(await isInside(root, outside), false);
    assert.equal(await isInside(root, '/etc'), false);
  });

  test('前缀相同但不是子目录的路径不算在内', async () => {
    // `<root>-evil` 以 `<root>` 开头,纯字符串前缀比较会误放行。
    assert.equal(await isInside(root, `${root}-evil`), false);
  });

  test('指向工作区外的符号链接会被 realpath 拆穿', async () => {
    const link = path.join(root, 'escape-hatch');
    await fs.symlink(outside, link);
    assert.equal(await isInside(root, link), false);
    assert.equal(await isInside(root, path.join(link, 'secret.txt')), false);
  });
});

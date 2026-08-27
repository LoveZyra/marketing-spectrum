import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, test } from 'vitest';

import { createCheckpoint, restoreCheckpoint } from '../git-checkpoint.js';

/**
 * E9:checkpoint 的 untracked 快照改成增量。
 *
 * 每个回合前都会给工作区打一份 checkpoint,而 untracked 快照原来是**每轮全量
 * copyFile**。仓库里躺着构建产物或数据文件时,这就是每轮几百 MB 的纯拷贝。
 * 现在同一路径只要 size + mtimeMs + inode 三者全同,就硬链到上一份副本上。
 *
 * 这个测试盯着三件事,任何一件破了都是数据问题而不只是性能问题:
 *   1. 没动过的文件被复用(不再重复占磁盘);
 *   2. 动过的文件必须重新拷贝 —— 旧 checkpoint 里存的仍是**旧内容**;
 *   3. 老 checkpoint 被清掉后,新 checkpoint 里那份硬链接照样能读、能还原。
 */
const run = promisify(execFile);

let repo = null;
let store = null;
const previousStore = process.env.PRISM_CHECKPOINT_DIR;

/** 这个文件系统支不支持硬链接 —— 不支持时实现会静默回落成拷贝,inode 断言就不成立。 */
async function supportsHardLinks(directory) {
  const source = path.join(directory, '.link-probe');
  const target = path.join(directory, '.link-probe-2');
  try {
    await fs.writeFile(source, 'probe');
    await fs.link(source, target);
    return true;
  } catch {
    return false;
  } finally {
    await rm(source, { force: true });
    await rm(target, { force: true });
  }
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'checkpoint-incremental-'));
  repo = path.join(base, 'repo');
  store = path.join(base, 'store');
  await fs.mkdir(repo, { recursive: true });
  process.env.PRISM_CHECKPOINT_DIR = store;

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.email', 'checkpoint@test.local'], { cwd: repo });
  await run('git', ['config', 'user.name', 'checkpoint test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', 'init'], { cwd: repo });

  // 模块是静态导入的:getCheckpointRoot 每次调用都现读 PRISM_CHECKPOINT_DIR,
  // 所以每个用例换一个 store 目录就够,不需要重新加载模块。
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.PRISM_CHECKPOINT_DIR;
  else process.env.PRISM_CHECKPOINT_DIR = previousStore;
  if (repo) await rm(path.dirname(repo), { recursive: true, force: true });
  repo = null;
  store = null;
});

const storedPath = (id, relativePath) => path.join(store, id, 'untracked', relativePath);

describe('checkpoint untracked 快照按 size+mtime+inode 增量复用', () => {
  test('没动过的文件被复用,动过的重新拷贝,旧 checkpoint 仍存旧内容', async () => {
    await fs.mkdir(path.join(repo, 'data'), { recursive: true });
    await fs.writeFile(path.join(repo, 'data/blob.bin'), Buffer.alloc(256 * 1024, 7));
    await fs.writeFile(path.join(repo, 'note.txt'), 'v1');

    const first = await createCheckpoint(repo, { sessionId: 's1' });
    assert.ok(first, '第一份 checkpoint 应该建得出来');
    assert.equal(first.untrackedLinked ?? 0, 0, '第一份没有可复用的上家');

    const second = await createCheckpoint(repo, { sessionId: 's1' });
    assert.equal(second.untrackedLinked, 2, '两个文件都没动过,应该全部复用');

    await fs.writeFile(path.join(repo, 'note.txt'), 'v2-changed');
    const third = await createCheckpoint(repo, { sessionId: 's1' });
    assert.equal(third.untrackedLinked, 1, '只有没动过的那个可以复用');

    // 复用不能串味:旧 checkpoint 里必须还是旧内容。
    assert.equal(await fs.readFile(storedPath(second.id, 'note.txt'), 'utf8'), 'v1');
    assert.equal(await fs.readFile(storedPath(third.id, 'note.txt'), 'utf8'), 'v2-changed');

    if (await supportsHardLinks(store)) {
      const [a, b] = await Promise.all([
        fs.stat(storedPath(first.id, 'data/blob.bin')),
        fs.stat(storedPath(second.id, 'data/blob.bin')),
      ]);
      assert.equal(a.ino, b.ino, '没动过的文件应该共享 inode(硬链接),而不是再拷一份');
    }
  });

  test('上一份被清理后,复用来的那份仍然完整可读、可还原', async () => {
    await fs.writeFile(path.join(repo, 'keep.txt'), 'keep-me');
    const first = await createCheckpoint(repo, { sessionId: 's1' });
    const second = await createCheckpoint(repo, { sessionId: 's1' });
    assert.equal(second.untrackedLinked, 1);

    // TTL 清理会整目录删掉上一份 —— 硬链接只掉一个链接数,内容不该消失。
    await rm(path.join(store, first.id), { recursive: true, force: true });
    assert.equal(await fs.readFile(storedPath(second.id, 'keep.txt'), 'utf8'), 'keep-me');

    await fs.writeFile(path.join(repo, 'keep.txt'), 'clobbered');
    const restored = await restoreCheckpoint(second.id, { force: true });
    assert.equal(restored.ok, true, '复用来的快照必须还原得回去');
    assert.equal(await fs.readFile(path.join(repo, 'keep.txt'), 'utf8'), 'keep-me');
  });

  test('工作区文件不会被硬链进 store —— 还原写的是副本,不是原件', async () => {
    await fs.writeFile(path.join(repo, 'source.txt'), 'original');
    const checkpoint = await createCheckpoint(repo, { sessionId: 's1' });

    const [working, stored] = await Promise.all([
      fs.stat(path.join(repo, 'source.txt')),
      fs.stat(storedPath(checkpoint.id, 'source.txt')),
    ]);
    assert.notEqual(working.ino, stored.ino, 'store 里的必须是独立副本,否则改工作区就等于改快照');
  });
});

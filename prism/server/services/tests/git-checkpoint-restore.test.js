import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, test } from 'vitest';

import {
  createCheckpoint,
  restoreCheckpoint,
  INCOMPLETE_TOO_MANY_UNTRACKED,
} from '../git-checkpoint.js';

/**
 * G1:checkpoint **还原**路径的行为矩阵。
 *
 * 打 checkpoint 有测试(cq 轮的增量快照),还原一直没有 —— 而还原才是危险的那半:
 * 它 `git reset --hard`、删未跟踪文件、replay stash。一条判据错掉就是用户的工作丢了。
 *
 * 这里钉的都是**拒绝**与**兜底**,因为那才是它的价值所在:
 *   - checkpoint 之后有提交 → 默认拒绝(reset 会把分支指针拖回去,提交就没了);
 *   - 快照不完整 → 默认拒绝,而且**即使 force 也绝不删未跟踪文件**
 *     (keep-set 不可信,删"不认识的"文件等于删用户的东西);
 *   - 还原前必须先给当前状态打一份安全 checkpoint —— 后悔药。
 */
const run = promisify(execFile);

let repo = null;
let store = null;
const previousStore = process.env.PRISM_CHECKPOINT_DIR;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'checkpoint-restore-'));
  repo = path.join(base, 'repo');
  store = path.join(base, 'store');
  await fs.mkdir(repo, { recursive: true });
  process.env.PRISM_CHECKPOINT_DIR = store;

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.email', 'restore@test.local'], { cwd: repo });
  await run('git', ['config', 'user.name', 'restore test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'v1\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', 'init'], { cwd: repo });
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.PRISM_CHECKPOINT_DIR;
  else process.env.PRISM_CHECKPOINT_DIR = previousStore;
  if (repo) await rm(path.dirname(repo), { recursive: true, force: true });
  repo = null;
  store = null;
});

const read = (name) => fs.readFile(path.join(repo, name), 'utf8');
const exists = (name) => fs.access(path.join(repo, name)).then(() => true).catch(() => false);

describe('restoreCheckpoint', () => {
  test('把已跟踪文件还原回 checkpoint 时的内容', async () => {
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'v2-changed\n');

    const result = await restoreCheckpoint(checkpoint.id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await read('tracked.txt'), 'v1\n');
  });

  test('把未跟踪文件的内容也还原回去', async () => {
    await fs.writeFile(path.join(repo, 'notes.txt'), 'original\n');
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    await fs.writeFile(path.join(repo, 'notes.txt'), 'clobbered\n');

    assert.equal((await restoreCheckpoint(checkpoint.id)).ok, true);
    assert.equal(await read('notes.txt'), 'original\n');
  });

  test('checkpoint 之后新建的未跟踪文件会被删掉(它不在 keep-set 里)', async () => {
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    await fs.writeFile(path.join(repo, 'scratch.txt'), 'created after\n');

    assert.equal((await restoreCheckpoint(checkpoint.id)).ok, true);
    assert.equal(await exists('scratch.txt'), false);
  });

  test('之后有提交时默认拒绝,并把提交列出来 —— reset 会把它们从分支上抹掉', async () => {
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'v2\n');
    await run('git', ['commit', '-qam', '之后的提交'], { cwd: repo });

    const refusal = await restoreCheckpoint(checkpoint.id);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, 'COMMITS_AFTER_CHECKPOINT');
    assert.equal(refusal.commitCount, 1);
    assert.equal(refusal.commits[0].subject, '之后的提交');
    assert.equal(await read('tracked.txt'), 'v2\n', '被拒绝时不能动工作区一个字节');

    // force 之后才真的还原
    assert.equal((await restoreCheckpoint(checkpoint.id, { force: true })).ok, true);
    assert.equal(await read('tracked.txt'), 'v1\n');
  });

  test('快照不完整时默认拒绝;force 还原,但**绝不删**未跟踪文件', async () => {
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    // 手动把这份 checkpoint 标成 incomplete —— 真实来源是文件数/字节数超限。
    const metaPath = path.join(store, checkpoint.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.incomplete = true;
    meta.incompleteReason = INCOMPLETE_TOO_MANY_UNTRACKED;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    const refusal = await restoreCheckpoint(checkpoint.id);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, 'CHECKPOINT_INCOMPLETE');

    await fs.writeFile(path.join(repo, 'unknown.txt'), '用户的东西\n');
    const forced = await restoreCheckpoint(checkpoint.id, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(
      await exists('unknown.txt'),
      true,
      'keep-set 不可信时,删"不认识的"文件等于删用户的东西 —— force 也不该删',
    );
  });

  test('不存在的 id → 404,不抛异常', async () => {
    const result = await restoreCheckpoint('cp-nope-deadbeef');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  test('还原前先给当前状态打一份安全 checkpoint —— 后悔药', async () => {
    const checkpoint = await createCheckpoint(repo, { sessionId: 's' });
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'about-to-be-lost\n');

    const before = (await fs.readdir(store)).length;
    const result = await restoreCheckpoint(checkpoint.id);
    assert.equal(result.ok, true);
    const after = (await fs.readdir(store)).length;
    assert.ok(after > before, '还原过程必须留下一份可以回到"还原前"的 checkpoint');

    // 那份安全 checkpoint 真的能把刚才的状态取回来
    const safetyId = (await fs.readdir(store)).find((id) => id !== checkpoint.id);
    assert.equal((await restoreCheckpoint(safetyId, { force: true })).ok, true);
    assert.equal(await read('tracked.txt'), 'about-to-be-lost\n');
  });
});

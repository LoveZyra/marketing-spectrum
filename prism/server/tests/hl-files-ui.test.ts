import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { createFilesRouter } from '@/modules/files/files.routes.js';
import { getFileTree, type FileTreeBudget } from '@/modules/files/services/file-tree.service.js';
import { searchProjectFiles } from '@/modules/files/services/project-search.service.js';
import { acquireZipSlot, hasZipSlot, ZIP_MAX_CONCURRENT } from '@/modules/files/services/zip-stream.js';
import { attachmentDisposition } from '@/shared/download-headers.js';

/**
 * hl · 切片 D(文件树 / 编辑器 / 上传下载)的回归测试。
 * 对应动态检测报告 P2-10 / P2-11 / P2-12 与 P3 文件组。
 */

type Ctx = { baseUrl: string; projectId: string; root: string };

async function withFilesServer(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'hl-files-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'hl.db');
  await initializeDatabase();
  let server: Server | null = null;
  try {
    const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
    const root = path.join(dir, 'proj');
    await mkdir(root, { recursive: true });
    const projectId = projectsDb.createProjectPath(root, null, alice.id).project!.project_id;
    const fakeAuth: RequestHandler = (req, _res, next) => {
      (req as unknown as { user?: typeof alice }).user = alice;
      next();
    };
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(createFilesRouter({ authenticateToken: fakeAuth }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no address');
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, projectId, root });
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    await rm(dir, { recursive: true, force: true });
  }
}

const makeFiles = async (dir: string, count: number, prefix = 'f') => {
  await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(path.join(dir, `${prefix}${String(i).padStart(4, '0')}.txt`), 'x')));
};

const uploadMultipart = async (baseUrl: string, projectId: string, files: Array<{ name: string; body: string }>, targetPath = '') => {
  const form = new FormData();
  form.append('targetPath', targetPath);
  form.append('requestedFileCount', String(files.length));
  for (const file of files) form.append('files', new Blob([file.body]), file.name);
  form.append('relativePaths', JSON.stringify(files.map((file) => file.name)));
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/files/upload`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('P2-10 文件树截断:确定性 + 打标', () => {
  test('预算用完的目录打 truncated,而不是显示成空目录;同一棵树两次结果一样', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-tree-'));
    try {
      // big 有 30 个文件、small 有 3 个;预算 20:根 2 个目录 + big 里 18 个 → big 截断,small 分不到 → 打标
      await makeFiles(path.join(dir, 'big'), 30);
      await makeFiles(path.join(dir, 'small'), 3);

      const run = async () => {
        const budget: FileTreeBudget = { remaining: 20, truncated: false };
        const tree = await getFileTree(dir, 10, 0, true, budget);
        return { tree, budget };
      };
      const first = await run();
      const second = await run();
      assert.deepEqual(JSON.stringify(first.tree), JSON.stringify(second.tree), '两次遍历结果必须一致');
      assert.equal(first.budget.truncated, true);

      const big = first.tree.find((n) => n.name === 'big')!;
      const small = first.tree.find((n) => n.name === 'small')!;
      assert.equal(big.truncated, true);
      assert.equal(big.children!.length, 18);
      // 基线里 small 会随机变成 children: [] 且无标记;现在明确打标
      assert.equal(small.truncated, true, '没分到预算的目录要打标');
      assert.equal(small.children!.length, 0);
      // 排序稳定:目录在前、按名字
      assert.deepEqual(first.tree.map((n) => n.name), ['big', 'small']);
      assert.equal(big.children![0].name, 'f0000.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('广度优先:浅层目录都列出来之后才轮到深层;深度上限处的目录打标', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-tree-'));
    try {
      await makeFiles(path.join(dir, 'a', 'deep'), 30);
      await makeFiles(path.join(dir, 'b'), 5);
      // 根:a、b(2);第二层:a 里 1 个 deep + b 里 5 个 = 6;第三层:deep 里 30 → 预算 12 时 deep 只拿到 4
      const budget: FileTreeBudget = { remaining: 12, truncated: false };
      const tree = await getFileTree(dir, 10, 0, true, budget);
      const b = tree.find((n) => n.name === 'b')!;
      assert.equal(b.children!.length, 5, 'b 是第二层,必须完整列出');
      assert.equal(b.truncated, undefined);
      const deep = tree.find((n) => n.name === 'a')!.children![0];
      assert.equal(deep.truncated, true);
      assert.equal(deep.children!.length, 4);

      // 深度上限:maxDepth=1 时第二层目录没进去看,打标(带预算时)
      const shallow = await getFileTree(dir, 1, 0, true, { remaining: 1000, truncated: false });
      const a = shallow.find((n) => n.name === 'a')!;
      assert.equal(a.children![0].name, 'deep');
      assert.equal(a.children![0].truncated, true);
      assert.equal(a.children![0].children, undefined);
      // 不带预算(browse-filesystem 那条)不打标
      const noBudget = await getFileTree(dir, 1, 0, true);
      assert.equal(noBudget.find((n) => n.name === 'a')!.children![0].truncated, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('软链目录按目录显示、带 symlinkTarget,不递归但打标;路由对根截断发 X-Prism-Root-Truncated', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await makeFiles(path.join(root, 'real'), 2);
      await symlink(path.join(root, 'real'), path.join(root, 'link'));
      await writeFile(path.join(root, 'plain.txt'), 'a');
      await symlink(path.join(root, 'plain.txt'), path.join(root, 'plainlink'));

      const tree = await getFileTree(root, 10, 0, true, { remaining: 100, truncated: false });
      const link = tree.find((n) => n.name === 'link')!;
      assert.equal(link.type, 'directory');
      assert.equal(link.isSymlink, true);
      assert.equal(link.symlinkTarget, 'directory');
      assert.equal(link.truncated, true);
      assert.equal(link.children, undefined);
      const plainlink = tree.find((n) => n.name === 'plainlink')!;
      assert.equal(plainlink.type, 'file');
      assert.equal(plainlink.symlinkTarget, 'file');

      // (懒加载走的是既有的 ?path= 分支,边界由 file-tree-boundary.test.ts 覆盖;
      //  这里的 fixture 在 /tmp 下,本身就在 FORBIDDEN_WORKSPACE_PATHS 里,不在此重复。)

      // 根截断头
      const prev = process.env.PRISM_FILETREE_MAX_ENTRIES;
      process.env.PRISM_FILETREE_MAX_ENTRIES = '2';
      try {
        const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`);
        assert.equal(response.headers.get('x-prism-truncated'), '1');
        assert.equal(response.headers.get('x-prism-root-truncated'), '1');
        assert.equal(((await response.json()) as unknown[]).length, 2);
      } finally {
        if (prev === undefined) delete process.env.PRISM_FILETREE_MAX_ENTRIES; else process.env.PRISM_FILETREE_MAX_ENTRIES = prev;
      }
    });
  });

  test('/file 对目录(含指向目录的软链)回可读中文而不是 EISDIR', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await mkdir(path.join(root, 'sub'));
      await symlink(path.join(root, 'sub'), path.join(root, 'sublink'));
      for (const name of ['sub', 'sublink']) {
        const response = await fetch(`${baseUrl}/api/projects/${projectId}/file?filePath=${encodeURIComponent(name)}`);
        assert.equal(response.status, 400);
        const body = await response.json() as { error: string; code: string };
        assert.equal(body.code, 'IS_DIRECTORY');
        assert.ok(!/EISDIR/.test(body.error));
        assert.ok(/目录/.test(body.error));
      }
    });
  });
});

describe('P2-12 上传同名覆盖要报出来', () => {
  test('批量上传:响应带 overwritten,列出被覆盖的相对名;首次上传为空', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      const first = await uploadMultipart(baseUrl, projectId, [{ name: 'a.txt', body: 'old' }, { name: 'b.txt', body: 'b' }]);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.overwritten, []);

      const second = await uploadMultipart(baseUrl, projectId, [{ name: 'a.txt', body: 'new' }, { name: 'c.txt', body: 'c' }]);
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.overwritten, ['a.txt']);
      assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'new');
    });
  });

  test('分片上传 complete 同样报 overwritten', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await writeFile(path.join(root, 'big.bin'), 'exists');
      const base = `${baseUrl}/api/projects/${projectId}/files/upload`;
      const started = await fetch(`${base}/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'big.bin', relativePath: 'big.bin', size: 5, targetPath: '' }),
      });
      const { uploadId } = await started.json() as { uploadId: string };
      const form = new FormData();
      form.append('uploadId', uploadId);
      form.append('index', '0');
      form.append('chunk', new Blob(['12345']), 'big.bin.part0');
      assert.equal((await fetch(`${base}/chunk`, { method: 'POST', body: form })).status, 200);
      const done = await fetch(`${base}/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }),
      });
      assert.equal(done.status, 200);
      assert.deepEqual((await done.json() as { overwritten: string[] }).overwritten, ['big.bin']);
    });
  });
});

describe('P3 文件组', () => {
  test('中文名下载的 ASCII 兜底不是隐藏的 .txt', () => {
    const header = attachmentDisposition('报告.txt');
    assert.match(header, /filename="download\.txt"/);
    assert.match(header, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.txt/);
    assert.match(attachmentDisposition('季度报告 2026.xlsx'), /filename="2026\.xlsx"/);
    assert.match(attachmentDisposition('中文'), /filename="download"/);
  });

  test('全文搜索:单文件上限与编辑器对齐(>2MB 但 <5MB 的能搜到),超上限的报跳过数', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-search-'));
    try {
      await writeFile(path.join(dir, 'mid.log'), `${'a'.repeat(3 * 1024 * 1024)}\nNEEDLE_MID\n`);
      await writeFile(path.join(dir, 'huge.log'), `${'a'.repeat(6 * 1024 * 1024)}\nNEEDLE_HUGE\n`);
      await writeFile(path.join(dir, 'small.txt'), 'NEEDLE_SMALL\n');
      const result = await searchProjectFiles(dir, 'NEEDLE_');
      assert.equal(result.error, null);
      const paths = result.matches.map((m) => m.path).sort();
      assert.deepEqual(paths, ['mid.log', 'small.txt'], '3MB 的文件在基线里被 2M 上限静默跳过');
      assert.equal(result.skippedLargeFiles, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('打包名额满时签票就回 429(不再等到导航才失败)', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await makeFiles(path.join(root, 'dir'), 2);
      const releases: Array<() => void> = [];
      try {
        while (hasZipSlot()) {
          const release = acquireZipSlot();
          if (!release) break;
          releases.push(release);
        }
        assert.equal(releases.length, ZIP_MAX_CONCURRENT);
        const response = await fetch(`${baseUrl}/api/projects/${projectId}/files/download-ticket`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: [path.join(root, 'dir')] }),
        });
        assert.equal(response.status, 429);
        assert.equal((await response.json() as { code: string }).code, 'ZIP_BUSY');
        // 单文件直传不占打包名额,照常签票
        const single = await fetch(`${baseUrl}/api/projects/${projectId}/files/download-ticket`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: [path.join(root, 'dir', 'f0000.txt')] }),
        });
        assert.equal(single.status, 200);
      } finally {
        for (const release of releases) release();
      }
    });
  });
});

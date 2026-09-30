import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import archiver from 'archiver';
import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { createFilesRouter } from '@/modules/files/files.routes.js';
import { decodeForDisplay, EDITOR_MAX_BYTES, sniffText } from '@/modules/files/services/text-sniff.js';
import { acquireZipSlot, streamZipEntries, ZIP_MAX_CONCURRENT } from '@/modules/files/services/zip-stream.js';
import { applyProjectPermissions, readProjectPermissionsView } from '@/modules/projects/services/project-permissions.service.js';

/**
 * hk:2026-09-24 全面审计第 2 批(别再毁用户文件)的回归测试。
 */

const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7, 0x0a]); // "你好,世界\n"

type Ctx = { baseUrl: string; projectId: string; root: string; aliceId: number };

async function withFilesServer(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'hk-files-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'hk.db');
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
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, projectId, root, aliceId: alice.id });
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

const readVia = async (baseUrl: string, projectId: string, filePath: string) => {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const saveVia = async (baseUrl: string, projectId: string, filePath: string, content: string, baseMtimeMs?: number) => {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath, content, ...(baseMtimeMs === undefined ? {} : { baseMtimeMs }) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('P1-6 / P2-7 文本判别', () => {
  test('NUL → 二进制;GBK → 非 UTF-8 并能按 GBK 显示;CRLF 占多数 → crlf', () => {
    assert.equal(sniffText(Buffer.from([0x80, 0x02, 0x00, 0x4b])).binary, true);
    const gbk = sniffText(GBK_HELLO);
    assert.equal(gbk.binary, false);
    assert.equal(gbk.utf8, false);
    assert.equal(decodeForDisplay(GBK_HELLO).content, '你好,世界\n');
    assert.equal(sniffText(Buffer.from('中文\r\nb\r\nc\n')).lineEnding, 'crlf');
    assert.equal(sniffText(Buffer.from('a\nb\n')).lineEnding, 'lf');
    assert.equal(sniffText(Buffer.from('中文', 'utf8')).utf8, true);
  });

  test('复核补的:UTF-16 带 BOM 不是二进制;只坏了几个字节的 UTF-8 不整份按 GBK 显示;混合换行按 LF', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 abc\r\n', 'utf16le')]);
    const s16 = sniffText(utf16);
    assert.equal(s16.binary, false);
    assert.equal(decodeForDisplay(utf16, s16).content, '中文 abc\r\n');
    const damaged = Buffer.concat([Buffer.from('中文日志\n'), Buffer.from([0xe9, 0x41]), Buffer.from('继续中文\n')]);
    const shown = decodeForDisplay(damaged);
    assert.equal(shown.encoding, 'utf-8-damaged');
    assert.ok(shown.content.startsWith('中文日志'));
    assert.equal(decodeForDisplay(Buffer.from('中文'.repeat(50) + '\u00e9', 'utf8').subarray(0, 301)).encoding, 'utf-8-damaged', '末尾截断在半个字符上');
    assert.equal(sniffText(Buffer.from('a\r\nb\n')).lineEnding, 'lf');
  });
});

describe('P1-6 / P2-6 / P2-7 / P2-8 编辑器读写', () => {
  test('二进制与 GBK 文件:读出来是只读;保存被服务端拒绝,文件一个字节不变', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      const pkl = Buffer.from([0x80, 0x04, 0x95, 0x00, 0x00, 0x7d, 0x94, 0x2e]);
      await writeFile(path.join(root, 'model.pkl'), pkl);
      await writeFile(path.join(root, 'noext'), pkl);
      await writeFile(path.join(root, 'data.csv'), GBK_HELLO);

      const bin = await readVia(baseUrl, projectId, 'noext');
      assert.equal(bin.status, 200);
      assert.equal(bin.body.binary, true);
      assert.equal(bin.body.content, '');

      const gbk = await readVia(baseUrl, projectId, 'data.csv');
      assert.equal(gbk.body.readOnly, true);
      assert.equal(gbk.body.readOnlyReason, 'encoding');
      assert.equal(gbk.body.content, '你好,世界\n');

      for (const [name, original] of [['noext', pkl], ['model.pkl', pkl], ['data.csv', GBK_HELLO]] as const) {
        const saved = await saveVia(baseUrl, projectId, name, 'x�y');
        assert.equal(saved.status, 409, name);
        assert.equal(saved.body.code, 'FILE_NOT_TEXT');
        assert.deepEqual(await readFile(path.join(root, name)), original, `${name} 必须一个字节不变`);
      }
    });
  });

  test('CRLF 文件改一个字,保存后仍是 CRLF', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await writeFile(path.join(root, 'win.txt'), 'a\r\nb\r\nc\r\n');
      const read = await readVia(baseUrl, projectId, 'win.txt');
      assert.equal(read.body.lineEnding, 'crlf');
      const saved = await saveVia(baseUrl, projectId, 'win.txt', 'a\nB\nc\n', read.body.mtimeMs as number);
      assert.equal(saved.status, 200);
      assert.equal(await readFile(path.join(root, 'win.txt'), 'utf8'), 'a\r\nB\r\nc\r\n');
    });
  });

  test('打开之后被删 / 改名:带基线保存回 409 FILE_DELETED,不把旧文件救活;不带基线(用户确认)才重建', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await writeFile(path.join(root, 'foo.txt'), 'v1');
      const read = await readVia(baseUrl, projectId, 'foo.txt');
      await unlink(path.join(root, 'foo.txt'));
      const saved = await saveVia(baseUrl, projectId, 'foo.txt', 'v2', read.body.mtimeMs as number);
      assert.equal(saved.status, 409);
      assert.equal(saved.body.code, 'FILE_DELETED');
      assert.equal(fs.existsSync(path.join(root, 'foo.txt')), false);
      assert.equal((await saveVia(baseUrl, projectId, 'foo.txt', 'v2')).status, 200);
      assert.equal(await readFile(path.join(root, 'foo.txt'), 'utf8'), 'v2');
    });
  });

  test('超过编辑器上限的文件回 413,不整份读进内存', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await writeFile(path.join(root, 'big.log'), Buffer.alloc(EDITOR_MAX_BYTES + 1, 0x61));
      const read = await readVia(baseUrl, projectId, 'big.log');
      assert.equal(read.status, 413);
      assert.equal(read.body.code, 'FILE_TOO_LARGE');
    });
  });

  test('普通 UTF-8 文本照常读写', async () => {
    await withFilesServer(async ({ baseUrl, projectId, root }) => {
      await writeFile(path.join(root, 'ok.md'), '# 标题\n');
      const read = await readVia(baseUrl, projectId, 'ok.md');
      assert.equal(read.body.content, '# 标题\n');
      assert.equal(read.body.readOnly, undefined);
      assert.equal((await saveVia(baseUrl, projectId, 'ok.md', '# 新\n', read.body.mtimeMs as number)).status, 200);
      assert.equal(await readFile(path.join(root, 'ok.md'), 'utf8'), '# 新\n');
    });
  });
});

describe('P1-7 zip 下载中途取消不漏文件句柄', () => {
  const countFds = () => fs.readdirSync('/proc/self/fd').length;

  test('客户端不读、然后断开:abort 之后打开的读流全部关掉,done 不挂死', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hk-zip-'));
    try {
      for (const name of ['a.bin', 'b.bin', 'c.bin']) {
        await writeFile(path.join(dir, name), Buffer.alloc(8 * 1024 * 1024, 7));
      }
      await mkdir(path.join(dir, 'sub'));
      await writeFile(path.join(dir, 'sub', 'd.txt'), 'd');
      const before = countFds();
      const archive = archiver('zip', { zlib: { level: 0 } });
      archive.on('error', () => {});
      // 一个永远不读完的下游:模拟浏览器限速 / 卡住
      const stuck = new Writable({ highWaterMark: 1024, write(_chunk, _enc, _cb) { /* 永不回调 */ } });
      archive.pipe(stuck);
      const handle = streamZipEntries(archive, [{ absPath: dir, entryName: 'dir', isDirectory: true }]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(handle.openStreams() >= 1, '打包进行中至少开着一个文件');
      handle.abort();
      await Promise.race([handle.done, new Promise((_, reject) => setTimeout(() => reject(new Error('done 挂死')), 3000))]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(handle.openStreams(), 0);
      assert.ok(countFds() <= before + 1, `fd 不应泄漏:之前 ${before},之后 ${countFds()}`);
      stuck.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('正常打完:目录、子目录、软链条目都在', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hk-zip2-'));
    try {
      await mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
      await writeFile(path.join(dir, 'sub', 'deep', 'x.txt'), 'x');
      fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
      const chunks: Buffer[] = [];
      const archive = archiver('zip');
      const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      const finished = new Promise((resolve) => sink.on('finish', resolve));
      archive.pipe(sink);
      const handle = streamZipEntries(archive, [{ absPath: dir, entryName: 'root', isDirectory: true }]);
      await handle.done;
      await finished;
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(Buffer.concat(chunks));
      assert.equal(await zip.file('root/sub/deep/x.txt')!.async('string'), 'x');
      assert.ok(zip.files['root/sub/'], '目录条目');
      const link = zip.files['root/link'];
      assert.ok(link, '软链以链接条目存入');
      assert.equal(await link.async('string'), path.relative(dir, '/etc/passwd'), '链接条目里是(相对)目标路径,不是目标文件内容');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('复核补的:正常打完之后不留 abort 回调(大目录不涨内存);已经取消的请求会释放名额', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'files', 'services', 'zip-stream.ts'), 'utf8');
    assert.doesNotMatch(src, /abortSignal\.then/, '不要每个条目都挂一次 abort 回调');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'modules', 'files', 'files.routes.ts'), 'utf8');
    assert.match(routes, /finished\(res, \(\) => \{\s*releaseSlot\(\);/, '名额释放挂在 finished(res) 上,对已关闭的响应也会回调');
  });

  test('同时打包的名额有上限', () => {
    const releases = [];
    for (let i = 0; i < ZIP_MAX_CONCURRENT; i += 1) releases.push(acquireZipSlot());
    assert.ok(releases.every(Boolean));
    assert.equal(acquireZipSlot(), null);
    releases[0]!();
    releases[0]!();
    const again = acquireZipSlot();
    assert.ok(again, '释放一个就能再占一个(重复释放只算一次)');
    assert.equal(acquireZipSlot(), null);
    again!();
    for (const release of releases.slice(1)) release!();
  });
});

describe('P2-9 分片上传按人限额', () => {
  test('同一个人同时进行的分片上传超过 8 个回 429;声明 1 字节不能追加一大片', async () => {
    await withFilesServer(async ({ baseUrl, projectId }) => {
      const start = (size: number) => fetch(`${baseUrl}/api/projects/${projectId}/files/upload/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size, name: 'x.bin' }),
      });
      const statuses: number[] = [];
      for (let i = 0; i < 9; i += 1) statuses.push((await start(10)).status);
      assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
      assert.equal(statuses[8], 429);
    });
  });
});

describe('P1-8 改项目权限失败时一点都不改', () => {
  test('「指定用户」只勾了所有者自己:报 400,项目仍是公开、仍无主', async () => {
    const prevDb = process.env.DATABASE_PATH;
    const dir = await mkdtemp(path.join(tmpdir(), 'hk-perm-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(dir, 'p.db');
    await initializeDatabase();
    try {
      const root = Number(userDb.createUser('boss', 'hash').id);
      const projectRoot = path.join(dir, 'p');
      await mkdir(projectRoot);
      const projectId = projectsDb.createProjectPath(projectRoot, null, null, 'public').project!.project_id;
      const before = readProjectPermissionsView(projectId);
      assert.throws(() => applyProjectPermissions(projectId, { visibility: 'shared', sharedUserIds: [root] }, root), /至少要选一位/);
      assert.deepEqual(readProjectPermissionsView(projectId), before, '失败时一个字段都不许变');
      assert.equal(projectsDb.getProjectOwner(projectId) ?? null, null);
      await stat(projectRoot);
    } finally {
      closeConnection();
      if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

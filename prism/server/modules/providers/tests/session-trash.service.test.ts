import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * gk:回收站的文件层 —— 空壳识别、删除后的回头检查、超期清扫、保留期解析。
 *
 * "空壳复活"是 2026-09-14 事故里最不直观的一环:transcript 删掉后半小时,常驻 CLI 被
 * 回收,退出时按老路径写了 `last-prompt` + `mode` 两行,同名文件"复活"成 362 字节。
 * 这里用那两行原样造一个空壳,钉住它会被收走、而一份真 transcript 不会被当成空壳。
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');
let trash: typeof import('@/modules/providers/services/session-trash.service.js');

const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  PRISM_DATA_DIR: process.env.PRISM_DATA_DIR,
  PRISM_TRASH_RETENTION_DAYS: process.env.PRISM_TRASH_RETENTION_DAYS,
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-trash-svc-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_DATA_DIR = path.join(tempDir, 'data');
  delete process.env.PRISM_TRASH_RETENTION_DAYS;
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
  trash = await import('@/modules/providers/services/session-trash.service.js');
});

afterAll(() => {
  try { db?.closeConnection?.(); } catch { /* ignore */ }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  const conn = db.getConnection();
  for (const table of ['session_trash_messages', 'session_trash', 'audit_log']) conn.prepare(`DELETE FROM ${table}`).run();
  delete process.env.PRISM_TRASH_RETENTION_DAYS;
});

const STRAY_SHELL = '{"type":"last-prompt","lastPrompt":"生成符合这个文档的格式","leafUuid":"70aa78f9","sessionId":"2d557940"}\n'
  + '{"type":"mode","mode":"normal","sessionId":"2d557940"}\n';

const makeTranscript = (name: string, content = `{"type":"user","cwd":"/p","sessionId":"${name}"}\n`) => {
  const dir = path.join(tempDir, 'claude', `proj-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, name, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n');
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
};

describe('空壳识别', () => {
  it('两行收尾记录、没有 cwd → 是空壳;带 cwd 的真 transcript → 不是;不存在 → 不是', async () => {
    const shell = makeTranscript('shell', STRAY_SHELL);
    const real = makeTranscript('real');
    expect(await trash.isStrayShellTranscript(shell)).toBe(true);
    expect(await trash.isStrayShellTranscript(real)).toBe(false);
    expect(await trash.isStrayShellTranscript(path.join(tempDir, 'nope.jsonl'))).toBe(false);
  });

  it('大文件即使没有 cwd 也不当空壳(判据保守:拿不准的一律留下)', async () => {
    const big = makeTranscript('big', `${'{"type":"x"}\n'.repeat(600)}`);
    expect(await trash.isStrayShellTranscript(big)).toBe(false);
  });
});

/** 回头检查要求这条**还在回收站里**(恢复之后就不该再动老路径),测试里补一行。 */
const insertTrashRow = (sessionId: string, jsonlPath: string | null = null) => db.getConnection().prepare(
  `INSERT INTO session_trash (session_id, provider, deleted_at, deleted_via, jsonl_path)
   VALUES (?, 'claude', CURRENT_TIMESTAMP, 'session', ?)`,
).run(sessionId, jsonlPath);

describe('搬入 / 回头检查 / 恢复', () => {
  it('搬入:transcript 与同名目录进回收站目录,原地不留;回头检查把复活的空壳也收走', async () => {
    const file = makeTranscript('p1');
    insertTrashRow('s1', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's1', jsonl_path: file }, new Date('2026-09-15T00:00:00Z'));
    expect(files.trashJsonlPath).toBe(path.join(tempDir, 'data', 'trash', '2026-09-15', 's1', 'p1.jsonl'));
    expect(files.trashDirPath).toBe(path.join(tempDir, 'data', 'trash', '2026-09-15', 's1', 'p1'));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(file), 'p1'))).toBe(false);
    expect(fs.existsSync(path.join(files.trashDirPath!, 'subagents', 'agent-1.jsonl'))).toBe(true);

    // CLI 退出时把空壳写回了老路径
    fs.writeFileSync(file, STRAY_SHELL);
    trash.scheduleStrayCheck({ session_id: 's1', jsonl_path: file }, files, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fs.existsSync(file)).toBe(false);
    const strays = fs.readdirSync(path.dirname(files.trashJsonlPath!)).filter((name) => name.startsWith('stray-'));
    expect(strays).toHaveLength(1);
  });

  it('回头检查:老路径上是一份真 transcript(带 cwd)时不动它', async () => {
    const file = makeTranscript('p2');
    insertTrashRow('s2', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's2', jsonl_path: file });
    fs.writeFileSync(file, '{"type":"user","cwd":"/p","sessionId":"p2"}\n');
    trash.scheduleStrayCheck({ session_id: 's2', jsonl_path: file }, files, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fs.existsSync(file)).toBe(true);
  });

  /**
   * 八秒内被恢复的那种时序:库里回收站行已经没了,老路径上是刚搬回来的文件。
   * 回头检查必须**什么都不做** —— 否则它会把刚恢复的东西搬进一个没有行指向的桶。
   */
  it('回头检查:这条已经不在回收站里(被恢复了)→ 一概不动老路径', async () => {
    const file = makeTranscript('p2b');
    insertTrashRow('s2b', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's2b', jsonl_path: file });
    fs.writeFileSync(file, STRAY_SHELL);
    db.getConnection().prepare("DELETE FROM session_trash WHERE session_id = 's2b'").run();
    trash.scheduleStrayCheck({ session_id: 's2b', jsonl_path: file }, files, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('恢复时撤掉还没跑的回头检查:定时器不再碰老路径', async () => {
    const file = makeTranscript('p2c');
    insertTrashRow('s2c', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's2c', jsonl_path: file });
    fs.writeFileSync(file, STRAY_SHELL);
    trash.scheduleStrayCheck({ session_id: 's2c', jsonl_path: file }, files, 20);
    trash.cancelStrayCheck('s2c');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('恢复:搬回原路径,老路径上的空壳被覆盖', async () => {
    const file = makeTranscript('p3');
    insertTrashRow('s3', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's3', jsonl_path: file });
    fs.writeFileSync(file, STRAY_SHELL);
    const row = {
      session_id: 's3', jsonl_path: file, trash_jsonl_path: files.trashJsonlPath, trash_dir_path: files.trashDirPath,
    } as Parameters<typeof trash.restoreTranscriptFromTrash>[0];
    const result = await trash.restoreTranscriptFromTrash(row);
    expect(result).toEqual({ transcriptRestored: true, failed: false });
    expect(fs.readFileSync(file, 'utf8')).toContain('"cwd"');
    expect(fs.existsSync(path.join(path.dirname(file), 'p3', 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(fs.existsSync(files.trashJsonlPath!)).toBe(false);
  });

  /**
   * 搬不回去要**报出来**:调用方靠 `failed` 决定"这次恢复不算成功"。
   * 上一版只记日志,于是回收站行被删掉、文件留在 trash 里再没有东西指向它。
   */
  it('恢复:回收站里有文件但原目录不可写 → failed=true,文件仍在回收站', async () => {
    const file = makeTranscript('p3b');
    insertTrashRow('s3b', file);
    const files = await trash.moveTranscriptToTrash({ session_id: 's3b', jsonl_path: file });
    // 原路径的父目录整个搬走:再搬回去时 mkdir 能建,所以这里换成"目标是一个目录"
    // 这种必然失败的形状(rename 到已存在的非空目录 → 退回复制也失败)。
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(path.join(file, 'blocker'), 'x');
    const row = {
      session_id: 's3b', jsonl_path: file, trash_jsonl_path: files.trashJsonlPath, trash_dir_path: null,
    } as Parameters<typeof trash.restoreTranscriptFromTrash>[0];
    const result = await trash.restoreTranscriptFromTrash(row);
    expect(result).toEqual({ transcriptRestored: false, failed: true });
    expect(fs.existsSync(files.trashJsonlPath!)).toBe(true);
  });

  it('没有 transcript 路径的行:什么都不搬,也不报错', async () => {
    const files = await trash.moveTranscriptToTrash({ session_id: 's4', jsonl_path: null });
    expect(files).toEqual({ trashJsonlPath: null, trashDirPath: null });
    expect(trash.scheduleStrayCheck({ session_id: 's4', jsonl_path: null }, files, 0)).toBeNull();
  });
});

describe('保留期与清扫', () => {
  /**
   * 「写不成数就按默认 30」而不是「按 0(永不清扫)」:0 会让 startTrashSweeper
   * 连定时器都不建,于是 `=30d` 这种手滑静默关掉整个清扫,而配置看着像设了 30 天。
   * 关掉自动清扫必须是明写 `0` 的决定。
   */
  it('保留期:不配 = 30;显式 0 = 永不;写不成数 = 回默认 30', () => {
    delete process.env.PRISM_TRASH_RETENTION_DAYS;
    expect(trash.getTrashRetentionDays()).toBe(30);
    process.env.PRISM_TRASH_RETENTION_DAYS = '0';
    expect(trash.getTrashRetentionDays()).toBe(0);
    process.env.PRISM_TRASH_RETENTION_DAYS = '7';
    expect(trash.getTrashRetentionDays()).toBe(7);
    for (const bad of ['abc', '30d', '-1', '7.5', '']) {
      process.env.PRISM_TRASH_RETENTION_DAYS = bad;
      expect(trash.getTrashRetentionDays()).toBe(30);
    }
  });

  /**
   * 桶名里那一段 session id 必须消毒:`session_id` 是从磁盘上的 transcript 里读出来的
   * (监视器),而路由的校验正则允许点号 —— `".."` 能一路走到 `rm -rf`,端掉整个回收站。
   */
  it('桶名:只留 [A-Za-z0-9_-];换过字符的缀短哈希(不同 id 不撞同一个桶)', () => {
    expect(trash.trashBucketSegment('a6bf141e-59bb-49b2-b45b-21539f3aafa6')).toBe('a6bf141e-59bb-49b2-b45b-21539f3aafa6');
    for (const evil of ['..', '.', '../../evil', 'a/b']) {
      const segment = trash.trashBucketSegment(evil);
      expect(segment).not.toContain('..');
      expect(segment).not.toContain('/');
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(trash.trashBucketSegment('a.b')).not.toBe(trash.trashBucketSegment('a_b'));
  });

  it('清扫拒绝非法桶:库里记的路径不在 <trash>/<日期>/<桶> 这一层时什么都不删', async () => {
    const root = path.join(tempDir, 'data', 'trash');
    const dayDir = path.join(root, '2026-02-02');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, 'keep.jsonl'), 'x');
    // trash_jsonl_path 直接落在日期目录下 → dirname 是日期目录(只有一级)→ 不许删
    await trash.purgeTrashFiles({
      session_id: 'weird', jsonl_path: null, trash_jsonl_path: path.join(dayDir, 'keep.jsonl'), trash_dir_path: null,
    } as Parameters<typeof trash.purgeTrashFiles>[0]);
    expect(fs.existsSync(dayDir)).toBe(true);
    expect(fs.existsSync(path.join(dayDir, 'keep.jsonl'))).toBe(true);
  });

  it('清扫:超期的行 + 回收站目录都删掉,不超期的留着,记一条汇总审计', async () => {
    const conn = db.getConnection();
    const insertTrash = (id: string, deletedAt: string, trashJsonl: string | null) => conn.prepare(
      `INSERT INTO session_trash (session_id, provider, custom_name, deleted_at, deleted_via, trash_jsonl_path)
       VALUES (?, 'claude', ?, ?, 'session', ?)`,
    ).run(id, `name-${id}`, deletedAt, trashJsonl);
    const oldBucket = path.join(tempDir, 'data', 'trash', '2026-01-01', 'old');
    fs.mkdirSync(oldBucket, { recursive: true });
    fs.writeFileSync(path.join(oldBucket, 'p.jsonl'), 'x');
    insertTrash('old', '2026-01-01 00:00:00', path.join(oldBucket, 'p.jsonl'));
    insertTrash('fresh', new Date().toISOString().replace('T', ' ').slice(0, 19), null);
    conn.prepare("INSERT INTO session_trash_messages (id, session_id, message_id, kind, timestamp, payload) VALUES (1, 'old', 'm', 'text', 't', '{}')").run();

    const purged = await trash.sweepExpiredTrash();
    expect(purged).toBe(1);
    expect(db.sessionTrashDb.get('old')).toBeNull();
    expect(db.sessionTrashDb.get('fresh')).not.toBeNull();
    expect(fs.existsSync(oldBucket)).toBe(false);
    expect(conn.prepare("SELECT COUNT(*) AS n FROM session_trash_messages WHERE session_id = 'old'").get()).toEqual({ n: 0 });
    const audit = conn.prepare("SELECT event, detail FROM audit_log WHERE event = 'session_trash_purged'").all() as Array<{ event: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].detail)).toMatchObject({ entry: 'retention', count: 1, names: ['name-old'] });
  });

  it('保留期 0:清扫什么都不做', async () => {
    process.env.PRISM_TRASH_RETENTION_DAYS = '0';
    db.getConnection().prepare(
      "INSERT INTO session_trash (session_id, provider, deleted_at, deleted_via) VALUES ('ancient', 'claude', '2020-01-01 00:00:00', 'session')",
    ).run();
    expect(await trash.sweepExpiredTrash()).toBe(0);
    expect(db.sessionTrashDb.get('ancient')).not.toBeNull();
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * gz:把受管副本(`<home>/work/<skill>/`)发布到技能库(`~/.claude/skills/<skill>/`)。
 *
 * 这是整个技能优化里**唯一**会写技能库的动作(回滚是它的逆),而且只有 root 能点。四条纪律:
 *   1. 前置:该副本最近一次 staging 已被采纳(`adopted.json`)—— 训练产物只进 staging,采纳与发布是两个动作;
 *   2. 技能库那份自导入以来**没被人改过**(serve 的 `/drift` 逐文件 sha 对账)—— 改过就 409 并列出文件,不覆盖别人的手工修改;
 *   3. 原子替换:先整棵拷到 `.publish-<skill>-<ts>` 再 `rename`,旧目录挪进 `<home>/rollback/<skill>/<ts>/`(保 3 份);
 *   4. 不带 `.evo/`、`__pycache__`:训练状态留在副本里,技能库永远是干净的 skill。
 *
 * 「发布为新技能」(上传来源)走同一条路,只是前置换成"技能库里**没有**同名目录"。
 */
export type PublishedFile = { rel: string; sha256: string };

export type PublishResult = {
  skill: string;
  liveDir: string;
  files: PublishedFile[];
  rollback: string | null;
  replaced: boolean;
};

const SKIP = new Set(['.evo', '__pycache__', '.pytest_cache', '.git']);
const KEEP_ROLLBACKS = 3;

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    // 根目录的 import.json 是 SkillWhet 的受管记录(每文件 sha),不是技能的一部分,不进技能库
    if (next === 'import.json') continue;
    if (entry.isDirectory()) out.push(...walk(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

/** 拷一棵干净的树(不带 SKIP 里的东西);目标必须不存在。 */
function copyClean(src: string, dst: string): PublishedFile[] {
  fs.mkdirSync(dst, { recursive: false });
  const files: PublishedFile[] = [];
  for (const rel of walk(src)) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files.push({ rel, sha256: sha256(to) });
  }
  return files;
}

/** rename 跨文件系统(EXDEV:技能库与 PRISM_SKILLWHET_HOME 不在一个盘)时退成 拷贝 + 删除。 */
function moveDir(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** 同一秒内发布又回滚会撞名(回滚点 == 新停车位),给个后缀。 */
function uniqueDir(parent: string, name: string): string {
  fs.mkdirSync(parent, { recursive: true });
  let candidate = path.join(parent, name);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(parent, `${name}-${n++}`);
  return candidate;
}

function pruneRollbacks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  while (entries.length > KEEP_ROLLBACKS) {
    const victim = entries.shift() as string;
    fs.rmSync(path.join(dir, victim), { recursive: true, force: true });
  }
}

export type PublishOptions = {
  skill: string;
  workDir: string;           // <home>/work/<skill>
  liveRoot: string;          // ~/.claude/skills
  rollbackRoot: string;      // <home>/rollback
  /** 覆盖发布时要求;发布为新技能时忽略 */
  drift?: string[];
  mode: 'replace' | 'new';
};

export function publishManagedCopy(options: PublishOptions): PublishResult {
  const { skill, workDir, liveRoot, rollbackRoot, mode } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skill)) {
    throw new AppError('技能名不合法', { code: 'SKILLWHET_BAD_NAME', statusCode: 400 });
  }
  if (!fs.existsSync(path.join(workDir, 'SKILL.md'))) {
    throw new AppError(`受管副本里没有 SKILL.md:${workDir}`, { code: 'SKILLWHET_NOT_MANAGED', statusCode: 404 });
  }
  if (fs.existsSync(path.join(workDir, '.evo', 'baseline')) === false) {
    throw new AppError('副本还没 bootstrap,没有可发布的东西', { code: 'SKILLWHET_NOT_BOOTSTRAPPED', statusCode: 409 });
  }
  const liveDir = path.join(liveRoot, skill);
  const exists = fs.existsSync(liveDir);
  if (mode === 'new' && exists) {
    throw new AppError(`技能库里已经有「${skill}」;要覆盖请走「发布到技能库」`, { code: 'SKILLWHET_LIVE_EXISTS', statusCode: 409 });
  }
  if (mode === 'replace') {
    if (!exists) {
      throw new AppError(`技能库里没有「${skill}」;要新建请走「发布为新技能」`, { code: 'SKILLWHET_LIVE_MISSING', statusCode: 409 });
    }
    if (options.drift && options.drift.length > 0) {
      throw new AppError(`技能库里的「${skill}」自导入以来被改过 ${options.drift.length} 个文件,不覆盖:${options.drift.slice(0, 8).join(', ')}${options.drift.length > 8 ? ' …' : ''}`, {
        code: 'SKILLWHET_LIVE_CHANGED', statusCode: 409, details: { files: options.drift },
      });
    }
  }
  if (fs.existsSync(path.join(liveDir, '.evo'))) {
    throw new AppError('技能库那份里有 .evo/,先挪走再发布', { code: 'SKILLWHET_LIVE_HAS_EVO', statusCode: 409 });
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const stagingDst = path.join(liveRoot, `.publish-${skill}-${ts}`);
  fs.mkdirSync(liveRoot, { recursive: true });
  if (fs.existsSync(stagingDst)) fs.rmSync(stagingDst, { recursive: true, force: true });
  let files: PublishedFile[];
  try {
    files = copyClean(workDir, stagingDst);
  } catch (error) {
    fs.rmSync(stagingDst, { recursive: true, force: true });
    throw error;
  }
  let rollback: string | null = null;
  if (exists) {
    const rollbackDir = path.join(rollbackRoot, skill);
    fs.mkdirSync(rollbackDir, { recursive: true });
    rollback = uniqueDir(rollbackDir, ts);
    try {
      moveDir(liveDir, rollback);
    } catch (error) {
      // 旧的挪不走(另一个 root 同时在发?rollback 根在别的文件系统且拷贝失败?):新拷的那份别留在技能库里
      fs.rmSync(stagingDst, { recursive: true, force: true });
      fs.rmSync(rollback, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    fs.renameSync(stagingDst, liveDir);
  } catch (error) {
    // 换不进去就把旧的放回来,不留一个没有技能的空洞
    if (rollback && !fs.existsSync(liveDir)) moveDir(rollback, liveDir);
    fs.rmSync(stagingDst, { recursive: true, force: true });
    throw error;
  }
  if (rollback) pruneRollbacks(path.join(rollbackRoot, skill));
  return { skill, liveDir, files, rollback, replaced: exists };
}

export type RollbackEntry = { ts: string; dir: string; files: number };

export function listRollbacks(rollbackRoot: string, skill: string): RollbackEntry[] {
  const dir = path.join(rollbackRoot, skill);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ ts: e.name, dir: path.join(dir, e.name), files: walk(path.join(dir, e.name)).length }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/** 回滚:把 `rollback/<skill>/<ts>/` 原子换回技能库;当前那份进 rollback(同样保 3 份)。 */
export function rollbackPublished(options: { skill: string; liveRoot: string; rollbackRoot: string; to: string }): PublishResult {
  const { skill, liveRoot, rollbackRoot, to } = options;
  if (!/^\d{8}T\d{6}Z(-\d+)?$/.test(to)) throw new AppError('回滚点格式不对', { code: 'SKILLWHET_BAD_ROLLBACK', statusCode: 400 });
  const src = path.join(rollbackRoot, skill, to);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new AppError(`没有这个回滚点:${to}`, { code: 'SKILLWHET_ROLLBACK_MISSING', statusCode: 404 });
  }
  const liveDir = path.join(liveRoot, skill);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let parked: string | null = null;
  if (fs.existsSync(liveDir)) {
    parked = uniqueDir(path.join(rollbackRoot, skill), ts);
    moveDir(liveDir, parked);
  }
  try {
    moveDir(src, liveDir);
  } catch (error) {
    if (parked && !fs.existsSync(liveDir)) moveDir(parked, liveDir);
    throw error;
  }
  pruneRollbacks(path.join(rollbackRoot, skill));
  const files = walk(liveDir).map((rel) => ({ rel, sha256: sha256(path.join(liveDir, rel)) }));
  return { skill, liveDir, files, rollback: parked, replaced: true };
}

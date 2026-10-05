/**
 * 版本号规则的纯函数(v2.0.0 起)—— scripts/release.mjs 用,单测在 server/tests/release-version.test.js。
 *
 * 版本号只用「主.次.修」三个数字,按**部署方要付出的代价**跳号(详见项目文档《版本号规范》):
 * - 主:要人工介入(换 Node / 换随包 CLI / 必须改 settings.json 或 .env / 不可回滚的迁移 / 删功能或改默认行为);
 * - 次:可回滚的迁移、依赖变了要 `npm install`、新增可选配置、用户看得见的新功能;
 * - 修:只改代码,库、依赖、配置都不动。
 *
 * 能机器判的只有「依赖 / schema / migrations 变没变」—— 变了至少跳次版本号;「主」要人判。
 */

import { createHash } from 'node:crypto';

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 判断「要不要装依赖 / 备份库」的三个文件(与部署文档里的判据同一组)。 */
export const FINGERPRINT_FILES = {
  deps: 'package-lock.json',
  schema: 'server/modules/database/schema.ts',
  migrations: 'server/modules/database/migrations.ts',
};

export const md5 = (text) => createHash('md5').update(text).digest('hex');

/** '2.0.0' → [2, 0, 0];不是三段纯数字返回 null。 */
export function parseVersion(value) {
  const match = typeof value === 'string' ? VERSION_PATTERN.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`版本号不合法:${!left ? a : b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * 上一版 → 这一版跳的是哪一位:'major' | 'minor' | 'patch' | 'same' | 'lower';没有上一版是 'initial'。
 * 跳了某一位,它后面的位必须归零(1.2.3 → 1.3.0,不是 1.3.3);没归零的算 'irregular'。
 */
export function bumpKind(previous, next) {
  const after = parseVersion(next);
  if (!after) throw new Error(`版本号不合法:${next}`);
  if (previous == null) return 'initial';
  const before = parseVersion(previous);
  if (!before) throw new Error(`上一版的版本号不合法:${previous}`);
  const order = compareVersions(previous, next);
  if (order === 0) return 'same';
  if (order > 0) return 'lower';
  if (after[0] > before[0]) return after[1] === 0 && after[2] === 0 ? 'major' : 'irregular';
  if (after[1] > before[1]) return after[2] === 0 ? 'minor' : 'irregular';
  return 'patch';
}

/**
 * 依赖指纹:package-lock.json 去掉根上的两处 `version` 之后的 md5。
 * 每次发版都会改根上的版本号,整份文件的 md5 因此每次都变 —— 用它判断「要不要 npm install」就失灵了。
 * 部署时手算(与这里同一算法):
 *   node -e "const l=require('./package-lock.json');delete l.version;if(l.packages&&l.packages[''])delete l.packages[''].version;console.log(require('crypto').createHash('md5').update(JSON.stringify(l)).digest('hex'))"
 */
export function depsFingerprint(lockText) {
  const lock = JSON.parse(lockText);
  delete lock.version;
  if (lock.packages && lock.packages['']) delete lock.packages[''].version;
  return md5(JSON.stringify(lock));
}

/** 一棵树的三个指纹;`readFile(相对路径)` 读不到返回 null。 */
export function treeFingerprints(readFile) {
  const lock = readFile(FINGERPRINT_FILES.deps);
  const schema = readFile(FINGERPRINT_FILES.schema);
  const migrations = readFile(FINGERPRINT_FILES.migrations);
  return {
    deps: lock == null ? null : depsFingerprint(lock),
    schema: schema == null ? null : md5(schema),
    migrations: migrations == null ? null : md5(migrations),
  };
}

/**
 * 校验这一版的号跳得对不对。`changed` = 与上一版相比 { deps, schema, migrations } 变没变。
 * 返回 { ok, kind, required, problems: string[] }。
 */
export function checkBump({ previous, next, changed }) {
  const problems = [];
  if (!parseVersion(next)) {
    return { ok: false, kind: null, required: null, problems: [`版本号「${next}」不是「主.次.修」三个数字`] };
  }
  const kind = bumpKind(previous, next);
  const dataChanged = Boolean(changed?.schema || changed?.migrations);
  const required = changed?.deps || dataChanged ? 'minor' : 'patch';
  if (kind === 'same') problems.push(`版本号 ${next} 已经发过(上一版就是它)—— 号不复用,至少跳修订号`);
  if (kind === 'lower') problems.push(`版本号 ${next} 比上一版 ${previous} 还小`);
  if (kind === 'irregular') problems.push(`${previous} → ${next}:跳了某一位,它后面的位要归零`);
  if (kind === 'patch' && required === 'minor') {
    const what = [changed?.deps && '依赖(package-lock.json)', changed?.schema && 'schema.ts', changed?.migrations && 'migrations.ts']
      .filter(Boolean)
      .join('、');
    problems.push(`${what} 变了,至少要跳次版本号(${previous} → 次版本号 +1、修订号归零);只跳修订号,部署的人会以为解包就行`);
  }
  return { ok: problems.length === 0, kind, required, problems };
}

/**
 * 上一个发布版 = 已合进来的 v* 标签里**版本号最大**的那个(不含这一版自己)。
 * 复审(P2):不能用 `git describe` —— 它按提交距离找最近的标签,热修分支(v2.0.1)合回主线之后,
 * 主线上的 2.1.1 会被拿去和 2.0.1 比(判成跳号不规则、升级标记也算错)。不合规的标签(v1.0.0-rc.1 之类)忽略。
 */
export function pickPreviousTag(tags, version) {
  const own = `v${version}`;
  const candidates = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith('v') && tag !== own && parseVersion(tag.slice(1)));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, tag) => (compareVersions(tag.slice(1), best.slice(1)) > 0 ? tag : best));
}

/** 'YYYYMMDD' 是不是真实存在的日子(20261399 不算)。 */
export function isValidReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 'YYYYMMDD'(默认按 Asia/Shanghai 的今天,可用 PRISM_RELEASE_TZ 改)。 */
export function releaseDate(now = new Date(), timeZone = process.env.PRISM_RELEASE_TZ || 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts.replace(/-/g, '');
}

/** 清单行:按字节序(= LC_ALL=C sort)排好的 `md5  ./相对路径`。`entries` = [{ rel, content }]。 */
export function manifestLines(entries) {
  return [...entries]
    .sort((a, b) => Buffer.compare(Buffer.from(`./${a.rel}`), Buffer.from(`./${b.rel}`)))
    .map(({ rel, content }) => `${md5(content)}  ./${rel}`);
}

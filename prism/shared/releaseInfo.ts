/**
 * 版本号与发布信息(v2.0.0 起)—— 服务端、前端、打包脚本共用的纯函数,不碰文件系统。
 *
 * 规则见项目文档《版本号规范》:版本号只用「主.次.修」三个数字(不再用两个字母的代号),
 * 按**部署方要付出的代价**跳号:
 * - 主:要人工介入的升级(换 Node / 换随包 CLI / 必须改 settings.json 或 .env / 不可回滚的迁移 /
 *   删功能或改默认行为、可能让现有用法失败);
 * - 次:可回滚的迁移、依赖变了要 `npm install`、新增可选配置、用户看得见的新功能;
 * - 修:只改代码,库、依赖、配置都不动。
 *
 * 唯一来源是 `package.json` 的 `version`;打包时 `scripts/release.mjs` 在包根写一份 `RELEASE.json`
 * (发布日期、git 提交、指纹、组件版本)。从源码直接跑(没有 RELEASE.json)时只有版本号。
 */

/** 只认三段纯数字,不带前导零、不带预发布 / 构建后缀。 */
export const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_VERSION_PATTERN.test(value);
}

export interface ReleaseMeta {
  /** 发布日期 YYYY-MM-DD(打包那天)。 */
  date: string | null;
  /** git 短提交号。 */
  commit: string | null;
}

export interface ReleaseLabelInput extends Partial<ReleaseMeta> {
  version?: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * 从 RELEASE.json 的内容里取出日期与提交号。
 * `expectedVersion` 给了的话,RELEASE.json 里的版本号对不上就整份不认 —— 那是上一个包留下的,
 * 或有人手改了 package.json;这时宁可只显示版本号,也不显示一个错的提交号。
 */
export function pickReleaseMeta(raw: unknown, expectedVersion?: string | null): ReleaseMeta {
  const empty: ReleaseMeta = { date: null, commit: null };
  if (!raw || typeof raw !== 'object') return empty;
  const record = raw as Record<string, unknown>;
  if (expectedVersion !== undefined && record.version !== expectedVersion) return empty;
  return {
    date: typeof record.date === 'string' && DATE_PATTERN.test(record.date) ? record.date : null,
    commit: typeof record.commit === 'string' && COMMIT_PATTERN.test(record.commit) ? record.commit.slice(0, 12) : null,
  };
}

/** 「v2.0.0 · 2026-10-01 · 3c84d6c」;缺的部分省掉。版本号都没有时返回 null。 */
export function formatReleaseLabel({ version, date, commit }: ReleaseLabelInput): string | null {
  if (!version) return null;
  return [`v${version}`, date, commit].filter(Boolean).join(' · ');
}

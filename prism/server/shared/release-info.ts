import fs from 'node:fs';
import path from 'node:path';

import { formatReleaseLabel, pickReleaseMeta } from '../../shared/releaseInfo.js';

/**
 * 运行中的这份代码是哪个版本:package.json 的版本号 + 包里 RELEASE.json 的日期与提交号。
 * 规则与字段见 shared/releaseInfo.ts;RELEASE.json 由 scripts/release.mjs 打包时生成(不进 git)。
 */
export interface ReleaseInfo {
  version: string | null;
  date: string | null;
  commit: string | null;
  /** 形如「v1.2.3 · 2026-10-01 · 3c84d6c」;没有版本号时 null。 */
  label: string | null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readReleaseInfo(appRoot: string): ReleaseInfo {
  const pkg = readJson(path.join(appRoot, 'package.json')) as { version?: unknown } | null;
  const version = typeof pkg?.version === 'string' && pkg.version ? pkg.version : null;
  const meta = version ? pickReleaseMeta(readJson(path.join(appRoot, 'RELEASE.json')), version) : { date: null, commit: null };
  return { version, ...meta, label: formatReleaseLabel({ version, ...meta }) };
}

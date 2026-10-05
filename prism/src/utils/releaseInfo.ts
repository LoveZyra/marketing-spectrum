import { version as packageVersion } from '../../package.json';
import { formatReleaseLabel, pickReleaseMeta } from '../../shared/releaseInfo';

/**
 * v2.0.0:这份前端是哪个版本 —— 构建时从 package.json 与包里的 RELEASE.json 取(见 vite.config.js)。
 * 测试 / 没走 vite 构建时没有注入值,只有版本号。
 */
const injected: unknown = typeof __PRISM_RELEASE__ !== 'undefined' ? __PRISM_RELEASE__ : null;

export const BUILD_RELEASE = {
  version: packageVersion,
  ...pickReleaseMeta(injected, packageVersion),
};

/** 「v2.0.0 · 2026-10-01 · 3c84d6c」 */
export const BUILD_RELEASE_LABEL = formatReleaseLabel(BUILD_RELEASE);

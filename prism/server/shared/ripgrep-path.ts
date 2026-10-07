import { existsSync } from 'node:fs';

import { rgPath as bundledRgPath } from '@vscode/ripgrep';

/**
 * 找到一个真实存在的 ripgrep 可执行文件。
 *
 * `@vscode/ripgrep` 导出的路径指向它 postinstall 阶段下载的二进制;安装机器没有外网(内网部署)
 * 或用了 `npm ci --ignore-scripts` 时 postinstall 不会执行,`rgPath` 指向不存在的文件,
 * spawn 抛出用户看不懂的「spawn …/rg ENOENT」。
 *
 * 所以先用自带的,不在就回落到 PATH 里的 `rg`;两者都没有时由调用方给出 RIPGREP_MISSING_MESSAGE。
 */
export function resolveRipgrepPath(): string | null {
  try {
    if (bundledRgPath && existsSync(bundledRgPath)) return bundledRgPath;
  } catch {
    // 路径解析本身出错(不该发生)也照常回落
  }
  // 交给 PATH 解析。spawn 找不到时会抛 ENOENT,调用方已经在处理这条路径。
  return 'rg';
}

/** 两者都没有时给用户的那句话。 */
export const RIPGREP_MISSING_MESSAGE =
  '服务器上找不到 ripgrep(rg)。安装后重试:Debian/Ubuntu `apt install ripgrep`,'
  + 'RHEL/CentOS `dnf install ripgrep`,或重新安装依赖让 @vscode/ripgrep 下载自带版本。';

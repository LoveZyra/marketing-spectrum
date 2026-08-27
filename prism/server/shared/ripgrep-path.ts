import { existsSync } from 'node:fs';

import { rgPath as bundledRgPath } from '@vscode/ripgrep';

/**
 * 找到一个**真实存在**的 ripgrep 可执行文件。
 *
 * `@vscode/ripgrep` 导出的路径指向它 postinstall 阶段下载的二进制。而
 * postinstall 会在两种常见情况下不跑:安装机器没有外网(内网部署),或者用了
 * `npm ci --ignore-scripts`(不少安全基线要求这么做)。这时 `rgPath` 是一个
 * 指向**不存在的文件**的路径,spawn 抛 ENOENT —— 用户看到的是"搜索启动失败:
 * spawn …/rg ENOENT",既看不懂也不知道该装什么。
 *
 * 所以:先用自带的,不在就回落到 PATH 里的 `rg`(多数 Linux 发行版一条命令就能
 * 装上),两者都没有时由调用方给一句人话。
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

// Load environment variables from .env before other imports execute.
import fs from 'fs';
import path from 'path';

// libuv 线程池大小。默认只有 4,而 Prism 是单进程多用户:所有 fs.promises、
// 转录流式读、文件树 stat 全挤在这 4 条线程上,两三个用户同时做点文件操作就互相
// 排队。文件树自己开了 64 并发(file-tree.service.ts),池只有 4 时那 64 是空头
// 支票。这里抬到 16(可被外部环境覆盖)。
//
// 必须在任何异步 fs/dns/crypto 触发线程池初始化之前设 —— load-env 是
// server/index.js 的第一个 import,而它上面只有同步 readFileSync(同步 fs 不走
// 线程池),所以这里是进程内能设的最早时机。prism.sh 里也 export 了一份作为更
// 稳妥的兜底(那是在 node 启动前设,一定生效)。
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

// `process.report.getReport()` 默认会对每个 TCP 句柄做反向 DNS(同步、卡事件循环)。
// Prism 自己判 glibc / musl 要调它(claude-cli-path.ts),SDK 在没给可执行文件路径时也调;
// 只要 header 里的 glibc 版本,不要网络段。
if (process.report && 'excludeNetwork' in process.report) {
  process.report.excludeNetwork = true;
}

import { parseDotEnv } from './utils/dotenv-parse.js';
import { findAppRoot, getModuleDir, getDataDir } from './utils/runtime-paths.js';
import { scrubInheritedSessionMarkers } from './shared/claude-runtime-env.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  // 解析规则在 utils/dotenv-parse.js(行内注释与引号在那里剥),prism.sh 的 read_env 按同一套规则。
  // 环境里已有的键优先于文件(部署脚本 export 的赢)。
  for (const [key, value] of Object.entries(parseDotEnv(envFile))) {
    if (!process.env[key]) process.env[key] = value;
  }
} catch (e) {
  // 这一行刻意不走 logger:load-env.js 是整个进程的第一个 import,
  // 它跑完之前 `PRISM_LOG_LEVEL` 还没进 process.env —— 用 logger 的话,
  // 部署方把档位设在 .env 里时这条永远按默认档位判定,行为反而不可预期。
  console.error('No .env file found or error reading it:', e.message);
}

/**
 * 删掉从 claude 的 Bash 里继承来的会话标记。
 *
 * agent 在对话里跑 `bash prism.sh restart` 时,Prism 是在 CLI 的 shell 里起的,带着
 * `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` 等;它起的每个 claude
 * 都会继承,而 `CLAUDE_CODE_CHILD_SESSION` 会让 CLI 不写 transcript。在这里对 process.env 删一次,
 * 之后所有子进程(SDK、终端、SkillWhet、营销诊断、Jupyter)都从干净的 env 起。删了什么由
 * index.js 打一行 info(这里刻意不走 logger,理由同上面 .env 那段)。
 */
scrubInheritedSessionMarkers(process.env, { recordAsStartup: true });

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(getDataDir(), 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

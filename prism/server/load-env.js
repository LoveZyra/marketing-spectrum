// Load environment variables from .env before other imports execute.
import fs from 'fs';
import path from 'path';

// libuv 线程池大小。默认只有 4,而 Prism 是单进程多用户:所有 fs.promises、
// 转录流式读、文件树 stat 全挤在这 4 条线程上,两三个用户同时做点文件操作就互相
// 排队。文件树自己开了 64 并发(file-tree.service.ts),池只有 4 时那 64 是空头
// 支票。这里抬到 16(可被外部环境覆盖)。
//
// 必须在任何异步 fs/dns/crypto 触发线程池初始化**之前**设 —— load-env 是
// server/index.js 的第一个 import,而它上面只有同步 readFileSync(同步 fs 不走
// 线程池),所以这里是进程内能设的最早时机。prism.sh 里也 export 了一份作为更
// 稳妥的兜底(那是在 node 启动前设,一定生效)。
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

import { findAppRoot, getModuleDir, getDataDir, migrateLegacyDataDir } from './utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
  console.error('No .env file found or error reading it:', e.message);
}

// Migrate the legacy ~/.cloudcli data folder to the new location BEFORE any
// default path below is computed and before any module opens files inside the
// data dir (middleware/auth.js opens the auth DB at import time, and this file
// is the first import evaluated by server/index.js).
migrateLegacyDataDir();

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(getDataDir(), 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

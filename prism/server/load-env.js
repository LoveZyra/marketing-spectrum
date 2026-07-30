// Load environment variables from .env before other imports execute.
import fs from 'fs';
import path from 'path';

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

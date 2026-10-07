import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

/**
 * 翻译文件里不许攒死键。
 *
 * 改名时改了代码、没删旧文案就会留下死键。单条无害,但它们乘以语种数(一次漏删 = 每个语种文件
 * 各多一条),而且下一个人看到那个键还以为它在用。
 *
 * 判据:字面量 + 动态前缀,两条都要认。只搜字面量会把 `t(\`tabs.${id}\`)` 这类动态键全判成死键,
 * 所以还要往上逐级缩短前缀,匹配模板构造。反过来,只认前缀又会漏 —— `mainContent.export` 是
 * `mainContent.exportSession` 的前缀,单看前缀它"有命中"。两条一起,才既不误杀也不漏网。
 *
 * 测试文件也算"用处":扫描不排除 `.test.` 文件。`common:buttons.save` 只被 i18n 接线测试当探针用,
 * 把测试排除在外的话它会被判成死键、删掉,接着那条接线测试就红。
 *
 * 例外:`notifications.codes.*` 白名单放行。服务端确实在发这些 code,但前端还没拿 code 去查 i18n;
 * 这些文案是翻好了等前端接线的,不是改名残留。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(HERE, 'locales');
const SRC_DIR = path.resolve(HERE, '..');
const SERVER_DIR = path.resolve(HERE, '../../server');

/** 已知的"有意保留"的键前缀。加白名单要写清楚理由(见文件头)。 */
const ALLOWED_UNUSED_PREFIXES = ['notifications.codes.'];

const flatten = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flatten(nested, prefix ? `${prefix}.${key}` : key),
  );
};

const readSources = (dir: string, skip: (p: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || skip(full)) continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        out.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(dir);
  return out;
};

describe('i18n 死键', () => {
  test('en 侧每个键都能在源码里找到用处', () => {
    const blob = [
      ...readSources(SRC_DIR, (p) => p.includes(`${path.sep}locales`)),
      ...readSources(SERVER_DIR, () => false),
    ].join('\n');
    assert.ok(blob.length > 100_000, '源码没扫全,判据失效');

    const dead: string[] = [];
    for (const file of fs.readdirSync(path.join(LOCALES_DIR, 'en'))) {
      if (!file.endsWith('.json')) continue;
      const namespace = file.slice(0, -5);
      const keys = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en', file), 'utf8')));
      for (const key of keys) {
        if (ALLOWED_UNUSED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        // 字面量:'k' / "k" / `k` / 'ns:k'
        const literals = [`'${key}'`, `"${key}"`, `\`${key}\``, `'${namespace}:${key}'`, `"${namespace}:${key}"`];
        if (literals.some((candidate) => blob.includes(candidate))) continue;
        // 动态前缀:t(`pre.${…}`)
        const parts = key.split('.');
        let dynamic = false;
        for (let i = parts.length - 1; i > 0; i -= 1) {
          if (blob.includes(`${parts.slice(0, i).join('.')}.\${`)) { dynamic = true; break; }
        }
        if (!dynamic) dead.push(`${namespace}:${key}`);
      }
    }

    assert.deepEqual(
      dead, [],
      `这些翻译键没有任何代码在用(多半是改名时漏删的,记得×10 个语种):\n  ${dead.join('\n  ')}`,
    );
  });
});

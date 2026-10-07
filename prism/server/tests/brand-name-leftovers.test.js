import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * 旧品牌名不许出现在产品代码与文案里,但许可证要求的署名一个字都不能动。两面都要守:
 *
 *   1. 署名是许可证义务:`LICENSE` 的 AGPL §7 附加条款要求在文档、README 或法律声明里保留
 *      「CloudCLI UI (https://github.com/siteboon/claudecodeui)」这句署名,并标明是修改版;
 *      源自 Claude Code Web 的文件按 Apache-2.0 要带 NOTICE 与修改声明。第二条测试反向断言它们必须在。
 *   2. `src/` 与 `server/` 里不该出现旧品牌名,这类才是该改的。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** 旧品牌的各种写法(小写比较)。 */
const UPSTREAM_BRANDS = ['claudecodeui', 'claude-code-ui', 'claude code ui', 'cloudcli'];

/**
 * `src/` 与 `server/` 里允许出现的地方,连同为什么。只有这个测试自己:它要写出旧品牌名才能查。
 */
const ALLOWED = new Map([
  ['server/tests/brand-name-leftovers.test.js', '白名单、断言与说明本身'],
]);

/** 部分实现源自 Claude Code Web(Apache-2.0)的文件:每个都要带修改声明。 */
const APACHE_DERIVED_FILES = [
  'server/claude-sdk.js',
  'server/routes/checkpoints.js',
  'server/routes/documents.js',
  'server/services/agent-loop.js',
  'server/services/git-checkpoint.js',
];
const APACHE_FILE_NOTICE = '部分实现源自 Claude Code Web(Apache-2.0),已修改;版权与许可见 NOTICE。';

const SCANNED_DIRS = ['src', 'server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', '.git']);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|json|md)$/.test(entry)) out.push(full);
  }
  return out;
};

describe('旧品牌名与许可证署名', () => {
  test('src/ 与 server/ 里没有未登记的旧品牌名', () => {
    const offenders = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walk(path.join(root, dir))) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        const lower = readFileSync(file, 'utf8').toLowerCase();
        const hit = UPSTREAM_BRANDS.find((brand) => lower.includes(brand));
        if (hit) offenders.push(`${rel}  ← "${hit}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些文件里有旧品牌名。确实该留的写进 ALLOWED 并注明理由,\n'
      + '其余改成 prism:\n  ' + offenders.join('\n  ')
    );
  });

  test('署名没被"清理"掉 —— 许可证要求的几处必须还在', () => {
    // 这一条和上一条方向相反,故意的:一边防旧品牌名回流,一边防有人把署名当残留删掉。
    const attribution = /CloudCLI UI \(https:\/\/github\.com\/siteboon\/claudecodeui\)/;
    const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    assert.match(license, attribution, 'LICENSE 里 AGPL §7 要求的署名不见了 —— 这是许可证义务,不是品牌残留');
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, attribution, 'README 的「许可与署名」一节里要有 §7(b) 要求的署名原文');
    assert.match(readme, /不是 CloudCLI UI 原版软件/, 'README 要标明这是修改版(§7(c))');
    const notice = readFileSync(path.join(root, 'NOTICE'), 'utf8');
    assert.match(notice, /siteboon\/claudecodeui/, 'NOTICE 里 CloudCLI UI 的归属不见了');
    assert.match(notice, /Claude Code Web \(claude-web-ui\)\nCopyright \(c\) 2025-present heng1234/, 'NOTICE 里 Claude Code Web 的版权声明不见了(Apache-2.0 §4(d))');
    const apache = readFileSync(path.join(root, 'LICENSES', 'Apache-2.0.txt'), 'utf8');
    assert.match(apache, /Apache License\s+Version 2\.0, January 2004/, 'LICENSES/Apache-2.0.txt 要是 Apache-2.0 全文(§4(a))');
    for (const file of APACHE_DERIVED_FILES) {
      assert.ok(readFileSync(path.join(root, file), 'utf8').includes(APACHE_FILE_NOTICE), `${file} 少了修改声明(Apache-2.0 §4(b))`);
    }
  });
});

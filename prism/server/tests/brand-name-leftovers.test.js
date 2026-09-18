import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * **上游品牌名不许回流到产品文案里 —— 但归属必须一个字不动。**
 *
 * Prism 是 claudecodeui(CloudCLI)的分支,走 AGPL。这件事有两面,而且**两面都要守**:
 *
 *   1. **归属是许可证义务**:`LICENSE` 的 §7 附加条款明确要求保留
 *      「CloudCLI UI (https://github.com/siteboon/claudecodeui)」这行署名,
 *      `NOTICE` 与 `README.upstream.md` 同理。**改掉它们等于违反许可证** ——
 *      所以这些路径在下面是白名单,测试不碰,也提醒后来人别去"清理"。
 *   2. **产品文案里不该再出现上游品牌**:界面上那句 `claude-code-ui` 是包名的兜底值,
 *      用户看到的是别人的产品名。这类才是该改的。
 *
 * 另外 `.cloudcli` 这个名字有第三种身份:**旧数据目录**。
 * `runtime-paths.js` 靠 `LEGACY_DATA_DIR_NAME = '.cloudcli'` 把 `~/.cloudcli`
 * 一次性迁到 `~/.prism`。**改掉它,老部署的数据就迁不过来了** —— 也在白名单里。
 *
 * 所以这道守卫的判据是:**src/ 与 server/ 的非白名单文件里,不许出现上游品牌名。**
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** 上游品牌的各种写法(小写比较)。`.cloudcli` 另有身份,见下面的白名单。 */
const UPSTREAM_BRANDS = ['claudecodeui', 'claude-code-ui', 'claude code ui', 'cloudcli'];

/**
 * 允许出现的地方,连同**为什么**。删掉任何一条之前先读上面那段。
 */
const ALLOWED = new Map([
  // ——— 许可证义务:动不得 ———
  ['LICENSE', 'AGPL §7 附加条款要求保留上游署名'],
  ['NOTICE', '上游归属声明'],
  ['README.upstream.md', '上游 README 原件,整份保留'],
  ['README.md', '「基于 claudecodeui 构建」是归属声明,不是品牌残留'],
  ['package.json', 'description 里的 "built on claudecodeui" 同为归属'],
  // ——— 功能性:旧数据目录迁移 ———
  ['server/utils/runtime-paths.js', 'LEGACY_DATA_DIR_NAME —— ~/.cloudcli → ~/.prism 的迁移来源'],
  ['server/load-env.js', '描述上面那条迁移的注释'],
  ['server/index.js', '同上'],
  ['server/shared/image-attachments.ts', '同上'],
  ['.env.example', '文档化那条迁移'],
  ['.gitignore', '历史文件名的忽略规则'],
  // ——— 历史说明:记录"以前写死过 ~/.cloudcli,于是测试形同虚设" ———
  ['server/shared/tests/image-attachments.test.ts', '注释记录一次真实的测试失效,是"为什么这么写"的证据'],
  ['server/modules/assets/tests/image-assets.service.test.ts', '同上'],
  // 这个文件自己
  ['server/tests/brand-name-leftovers.test.js', '白名单与说明本身'],
]);

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

describe('上游品牌名', () => {
  test('src/ 与 server/ 里没有未登记的上游品牌名', () => {
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
      '这些文件里有上游品牌名。确实该留的(归属 / 旧数据目录迁移)写进 ALLOWED 并注明理由,\n'
      + '其余改成 prism:\n  ' + offenders.join('\n  ')
    );
  });

  test('**归属没被"清理"掉** —— 许可证要求的那几处必须还在', () => {
    // 这一条和上一条方向相反,故意的:一边防品牌回流,一边防有人把归属当残留删掉。
    const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    assert.match(license, /CloudCLI UI \(https:\/\/github\.com\/siteboon\/claudecodeui\)/,
      'LICENSE 里 AGPL §7 要求的署名不见了 —— 这是许可证义务,不是品牌残留');
    const notice = readFileSync(path.join(root, 'NOTICE'), 'utf8');
    assert.match(notice, /siteboon\/claudecodeui/, 'NOTICE 的上游归属不见了');
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /claudecodeui/, 'README 里「基于 claudecodeui 构建」不见了');
  });
});

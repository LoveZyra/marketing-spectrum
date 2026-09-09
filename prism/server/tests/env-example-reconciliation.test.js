import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * `.env.example` 与代码里真正读的变量,双向对账(审计 A-5)。
 *
 * ## 为什么要有这条
 *
 * `.env.example` 开头写着"只列代码真正读的变量"。审计时这句话**是假的**:
 * 12 个变量代码在读、文档里没有(其中就有 `WORKSPACES_ROOT` —— 不配就是整个
 * 服务账号家目录,`~/.ssh` / `~/.aws` / `~/.claude` 全在边界内);
 * 反向还有一行**没注释掉的** `VITE_CONTEXT_WINDOW=160000` 全仓无人读,
 * 而它上一行就是真正生效的 `CONTEXT_WINDOW` —— 两行几乎一样并排放着,
 * 运维只改一个必然踩坑。
 *
 * 这两种漂移的共同点是:**在 diff 里完全看不出来**。加一个变量时忘了写文档,
 * 删一个变量时忘了删文档,都不会让任何东西变红。所以只能靠一条对账测试。
 *
 * ## 两个方向都要查
 *
 * - 代码读了、文档没写 → 运维不知道有这个旋钮,排查时也想不到它可能被设过;
 * - 文档写了、代码不读 → 运维配了以为生效,实际什么都没发生(比 1 更难查,
 *   因为它看起来是"配了但没用",人会去怀疑别的地方)。
 */

const ROOT = process.cwd();

/**
 * 操作系统自己的变量,不是 Prism 的配置项 —— 不该出现在 `.env.example` 里。
 * 名单要短:每加一条都是在放弃一点对账能力,所以只放**明确不是 Prism 旋钮**的。
 */
const OS_PROVIDED = new Set(['HOME', 'USERPROFILE', 'PATH', 'NODE_ENV', 'TMPDIR', 'TEMP']);

/**
 * 文档里写了、但运行时**读不到**的变量。每一条必须写明为什么。
 *
 * 现在是空的 —— 我写第一版时凭印象往里塞了六个 `VITE_*`,以为它们都是 Vite
 * 构建期专用。逐个查过之后:`VITE_PORT` 和 `VITE_IS_PLATFORM` 服务端确实用
 * `process.env` 读;另外四个**早就不在 .env.example 里了**(前几轮清掉的)。
 * 也就是说那六条白名单全是我编的。删干净。
 *
 * 留着这个空 Map 是为了给下一个人一个明确的去处:往 .env.example 里加一行
 * 没人读的变量,测试会红,他要么删掉它,要么来这里写清楚理由。
 * **空名单比一份没核实过的名单有用得多** —— 后者会把真问题一起放过去。
 */
const DOCUMENTED_BUT_NOT_READ = new Map([
  // ['SOME_VAR', '为什么它写在文档里却读不到'],
]);

const readEnvExample = () => fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-server') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    // 测试文件不算:测试里设 process.env.X 是造夹具,不是"应用读这个配置"。
    // (这条也防止本文件扫到自己注释里提到的变量名 —— 第一版就是这么红的。)
    if (entry.name.includes('.test.') || full.includes(`${path.sep}tests${path.sep}`)) continue;
    if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const collectReadVariables = () => {
  const found = new Map();
  for (const dir of ['server', 'src', 'scripts']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        const name = match[1];
        if (!found.has(name)) found.set(name, path.relative(ROOT, file));
      }
      for (const match of source.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) {
        const name = match[1];
        if (!found.has(name)) found.set(name, path.relative(ROOT, file));
      }
    }
  }
  return found;
};

/**
 * 宽松扫描:变量名在非测试源码里**以任何形式出现过**。
 *
 * 严格的 `process.env.X` 扫描漏掉一大片,因为这个仓库读环境变量有四种写法:
 *   1. `process.env.PRISM_X`                      —— 直接读
 *   2. `envInt('PRISM_LOGIN_MAX_ATTEMPTS', 5)`    —— 经封装,名字是字符串字面量
 *   3. `env.PRISM_APPROVAL_REQUIRED`              —— 依赖注入,`env` 是个参数
 *   4. `import.meta.env.VITE_PRISM_API_KEY`       —— Vite 前端
 * 再加上 `prism.sh` 里的 shell 变量(`PRISM_LOG_KEEP`)。
 *
 * 我前两版分别只覆盖了 1 和 1+2,于是把十几个**真的在用**的变量报成"没人读"。
 * 与其继续追加模式,不如直接**子串匹配** —— 这些名字都是 `PRISM_` / `VITE_` /
 * `CLAUDE_` 打头的长名,撞车概率可以忽略。
 *
 * 两个方向用不同的严格度是刻意的,因为误判的代价不对称:
 * - 「代码读了→文档要有」用**严格**扫描:宁可漏报,也不能因为某个字符串碰巧同名,
 *   就逼人往 .env.example 里加一行根本不存在的旋钮;
 * - 「文档写了→代码要读」用**宽松**扫描:这边误判会让人删掉一行其实有用的文档,
 *   比留着一行死配置更糟。
 */
const collectMentionedNames = () => {
  const chunks = [];
  for (const dir of ['server', 'src', 'scripts']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) chunks.push(fs.readFileSync(file, 'utf8'));
  }
  // 部署脚本也算:PRISM_LOG_KEEP 只有 prism.sh 读,但它确实是个真旋钮。
  for (const extra of ['prism.sh', 'vite.config.ts', 'vite.config.js', 'Dockerfile', 'docker-compose.yml']) {
    const abs = path.join(ROOT, extra);
    if (fs.existsSync(abs)) chunks.push(fs.readFileSync(abs, 'utf8'));
  }
  return chunks.join('\n');
};

const collectDocumentedVariables = (text) => {
  const names = new Set();
  for (const line of text.split('\n')) {
    // 认 `FOO=` 和注释掉的 `# FOO=`,不认散文里提到的变量名
    const match = /^#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
};

describe('.env.example 与代码双向对账', () => {
  test('代码读的每个变量都要在 .env.example 里有一行', () => {
    const read = collectReadVariables();
    const documented = collectDocumentedVariables(readEnvExample());

    const missing = [...read.entries()]
      .filter(([name]) => !documented.has(name) && !OS_PROVIDED.has(name))
      .map(([name, file]) => `${name}  (${file})`);

    assert.deepEqual(
      missing, [],
      '这些变量代码在读、.env.example 里没有 —— 运维不知道有这个旋钮,\n'
      + '排查时也想不到它可能被谁设过。补一行说明(可以是注释掉的):\n  '
      + missing.join('\n  '),
    );
  });

  test('.env.example 里的每一行都要真有人读(或在白名单里说明理由)', () => {
    const haystack = collectMentionedNames();
    const documented = collectDocumentedVariables(readEnvExample());

    const dead = [...documented].filter(
      (name) => !haystack.includes(name) && !DOCUMENTED_BUT_NOT_READ.has(name),
    );

    assert.deepEqual(
      dead, [],
      '这些变量 .env.example 里写了但全仓没人读 —— 运维配了会以为生效。\n'
      + '要么删掉,要么在 DOCUMENTED_BUT_NOT_READ 里写明为什么(比如 Vite 构建期变量):\n  '
      + dead.join('\n  '),
    );
  });

  test('没注释掉的那几行,必须是运行时真的会生效的变量', () => {
    /*
     * `.env.example` 里有意留了几行**没注释掉**的(`SERVER_PORT` / `HOST` /
     * `PRISM_ROOT_USERS` 等)—— 那是新部署必须设的东西,直接抄成 .env 就能跑。
     * 这条设计没问题,不该被这个测试判违规。
     *
     * 真正的陷阱是审计抓到的那一行:`VITE_CONTEXT_WINDOW=160000` 没注释掉,
     * 看着像生效的默认值,而它是 **Vite 构建期**变量 —— 写在运行时的 .env 里
     * 什么都不会发生。它上一行才是真正生效的 `CONTEXT_WINDOW`,两行几乎一样
     * 并排放着,运维只改一个必然踩坑。
     *
     * 所以判据不是"不许有没注释的行",而是**没注释的行必须运行时真的读得到**。
     */
    const documentedButNotRuntime = DOCUMENTED_BUT_NOT_READ;
    const offenders = readEnvExample().split('\n')
      .map((line, index) => [index + 1, line])
      .filter(([, line]) => /^[A-Z_][A-Z0-9_]*\s*=/.test(line))
      .filter(([, line]) => documentedButNotRuntime.has(/^([A-Z_][A-Z0-9_]*)/.exec(line)[1]))
      .map(([lineNumber, line]) => `${lineNumber}: ${line}  ← ${documentedButNotRuntime.get(/^([A-Z_][A-Z0-9_]*)/.exec(line)[1])}`);

    assert.deepEqual(
      offenders, [],
      '这些行没注释掉,看着像"生效的默认值",但它们运行时根本读不到 ——\n'
      + '运维改了不会有任何反应,而且会以为自己改对了。注释掉它们:\n  '
      + offenders.join('\n  '),
    );
  });
});

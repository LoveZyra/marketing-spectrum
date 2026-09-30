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
      // hl:依赖注入写法 `env.PRISM_X`(skillwhet / ma-service / budget 都这么读)。只收 PRISM_ 前缀 ——
      // `env` 这个名字太常见,别的前缀误报面太大。PRISM_SKILLWHET_MODEL_ALLOWLIST 就是这样漏过文档的。
      for (const match of source.matchAll(/\benv\??\.(PRISM_[A-Z0-9_]*)/g)) {
        const name = match[1];
        if (!found.has(name)) found.set(name, path.relative(ROOT, file));
      }
    }
  }
  return found;
};

/**
 * 「文档写了 → 代码要读」这一侧的扫描:变量名必须以**读环境变量的形状**出现过。
 *
 * 这个仓库读环境变量有这几种写法,全部认:
 *   1. `process.env.X` / `process.env['X']`          —— 直接读
 *   2. `env.X` / `env['X']` / `env?.X`              —— 依赖注入,`env` 是个参数
 *   3. `envInt('X', 5)` 之类 —— 名字作为**字符串字面量**出现(引号包着)
 *   4. `import.meta.env.X`                           —— Vite 前端
 *   5. shell:`read_env X`、`$X`、`${X}`、`${X:-默认}` —— prism.sh / deploy.sh / Dockerfile
 *
 * hl(静态 P3「死配置」):此前这一侧是**子串匹配** —— 名字在源码里任何地方出现过就算"有人读"。
 * 结果 `PRISM_CREDENTIAL_HEADERS`(其实是 proxy-kit.js 里一个**常量**的名字)和
 * `PRISM_DATA_DIR_EXPLICIT_GUARD`(只出现在一行**注释**里)都被放了过去,运维配了没有任何效果。
 * 现在只认上面五种形状(shell 文件先剥掉 `#` 注释行)。JS 注释**不剥**:按字符剥注释要
 * 同时懂字符串、模板串和正则字面量,字符串里的 glob(src 下两个星号那种)就会被误当成块注释开头、
 * 吞掉后面整段代码 —— 第一版就这样把三个真在读的变量报成了死配置。五种形状本身已经够严:
 * 注释里裸写的名字、同名常量都不匹配。
 */
const stripShellComments = (source) => source
  .split('\n')
  .map((line) => (/^\s*#/.test(line) ? '' : line))
  .join('\n');

const collectReadNames = () => {
  const names = new Set();
  const add = (regex, text) => { for (const m of text.matchAll(regex)) names.add(m[1]); };
  const NAME = '([A-Z_][A-Z0-9_]*)';
  const jsPatterns = [
    new RegExp(`\\benv\\??\\.${NAME}\\b`, 'g'),                       // process.env.X / env.X / env?.X / import.meta.env.X
    new RegExp(`\\benv\\??\\.?\\[\\s*['"\`]${NAME}['"\`]\\s*\\]`, 'g'), // env['X']
    new RegExp(`['"\`]${NAME}['"\`]`, 'g'),                               // 'X'(经封装读取)
  ];
  const shellPatterns = [
    new RegExp(`read_env\\s+${NAME}\\b`, 'g'),
    new RegExp(`\\$\\{?${NAME}\\b`, 'g'),
  ];

  for (const dir of ['server', 'src', 'scripts']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of jsPatterns) add(re, text);
    }
  }
  for (const extra of ['vite.config.ts', 'vite.config.js']) {
    const abs = path.join(ROOT, extra);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const re of jsPatterns) add(re, text);
  }
  for (const extra of ['prism.sh', 'deploy.sh', 'Dockerfile', 'docker-compose.yml']) {
    const abs = path.join(ROOT, extra);
    if (!fs.existsSync(abs)) continue;
    const text = stripShellComments(fs.readFileSync(abs, 'utf8'));
    for (const re of shellPatterns) add(re, text);
    // compose 文件里 `- X=...` / `X: ...` 形式的环境项
    if (extra === 'docker-compose.yml') add(new RegExp(`^\\s*-?\\s*${NAME}\\s*[=:]`, 'gm'), text);
  }
  return names;
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
    const readNames = collectReadNames();
    const documented = collectDocumentedVariables(readEnvExample());

    const dead = [...documented].filter(
      (name) => !readNames.has(name) && !DOCUMENTED_BUT_NOT_READ.has(name),
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

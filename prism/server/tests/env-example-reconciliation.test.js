import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * `.env.example` 与代码里真正读的变量双向对账。
 *
 * `.env.example` 承诺"只列代码真正读的变量"。漂移在 diff 里看不出来:加变量忘了写文档、删变量忘了删文档,
 * 都不会让任何东西变红,只能靠对账测试。两个方向都要查:
 * - 代码读了、文档没写:运维不知道有这个旋钮(例如 `WORKSPACES_ROOT` 不配就是整个服务账号家目录,
 *   `~/.ssh` / `~/.aws` / `~/.claude` 全在边界内),排查时也想不到它可能被设过;
 * - 文档写了、代码不读:运维配了以为生效,实际什么都没发生。这种更难查,看起来是"配了但没用",
 *   人会去怀疑别的地方。
 */

const ROOT = process.cwd();

/**
 * 操作系统自己的变量,不是 Prism 的配置项,不该出现在 `.env.example` 里。
 * 名单要短:每加一条都是在放弃一点对账能力,所以只放明确不是 Prism 旋钮的。
 */
const OS_PROVIDED = new Set(['HOME', 'USERPROFILE', 'PATH', 'NODE_ENV', 'TMPDIR', 'TEMP']);

/**
 * 文档里写了、但 Prism 运行时读不到的变量。每一条都要写明理由,并且逐条核实过:
 * 没核实的名单会把真问题一起放过去。
 *
 * 往 .env.example 里加一行没人读的变量会让测试变红:要么删掉它,要么在这里写清楚理由。
 */
const DOCUMENTED_BUT_NOT_READ = new Map([
  // ['SOME_VAR', '为什么它写在文档里却读不到'],
  // Prism 不读它,原样透传给 CLI 子进程(buildClaudeSdkEnv 拷整个 process.env);读它的是 CLI(需 ≥ 2.1.273)。
  ['CLAUDE_CODE_GATEWAY_HINT_HEADERS', 'CLI 读;Prism 透传'],
]);

const readEnvExample = () => fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-server') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    // 测试文件不算:测试里设 process.env.X 是造夹具,不是"应用读这个配置";
    // 这也避免本文件扫到自己注释里提到的变量名。
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
      // 依赖注入写法 `env.PRISM_X`(skillwhet / ma-service / budget 都这么读),不收就会漏过对账。
      // 只收 PRISM_ 前缀:`env` 这个名字太常见,放开别的前缀误报面太大。
      for (const match of source.matchAll(/\benv\??\.(PRISM_[A-Z0-9_]*)/g)) {
        const name = match[1];
        if (!found.has(name)) found.set(name, path.relative(ROOT, file));
      }
    }
  }
  return found;
};

/**
 * 「文档写了 → 代码要读」这一侧的扫描:变量名必须以读环境变量的形状出现过。
 *
 * 这个仓库读环境变量有这几种写法,全部认:
 *   1. `process.env.X` / `process.env['X']`          —— 直接读
 *   2. `env.X` / `env['X']` / `env?.X`              —— 依赖注入,`env` 是个参数
 *   3. `envInt('X', 5)` 之类 —— 名字作为字符串字面量出现(引号包着)
 *   4. `import.meta.env.X`                           —— Vite 前端
 *   5. shell:`read_env X`、`$X`、`${X}`、`${X:-默认}` —— prism.sh / deploy.sh / Dockerfile
 *
 * 不能用子串匹配:同名常量(如 proxy-kit.js 里的 `PRISM_CREDENTIAL_HEADERS`)和只在注释里出现的名字
 * 都会被当成"有人读",运维配了却没有任何效果。shell 文件先剥掉 `#` 注释行;JS 注释不剥:按字符剥注释
 * 要同时懂字符串、模板串和正则字面量,否则字符串里的 glob(src 下两个星号那种)会被误当成块注释开头、
 * 吞掉后面整段代码。五种形状本身已经够严,注释里裸写的名字、同名常量都不匹配。
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
     * `.env.example` 有意留了几行没注释掉的(`SERVER_PORT` / `HOST` / `PRISM_ROOT_USERS` 等):
     * 新部署必须设,直接抄成 .env 就能跑,不算违规。
     * 要拦的是没注释掉、看着像生效的默认值、运行时却读不到的行(例如 Vite 构建期变量写进运行时 .env),
     * 尤其是和一个真正生效的变量长得几乎一样、并排放着时,运维只改一个必然踩坑。
     * 所以判据不是"不许有没注释的行",而是没注释的行必须运行时真的读得到。
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

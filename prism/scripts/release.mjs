#!/usr/bin/env node
/**
 * Prism 发版脚本(v2.0.0 起)。规则见 scripts/release-lib.mjs 与项目文档《版本号规范》。
 *
 *   node scripts/release.mjs fingerprint [--root <目录>]
 *       打印一棵树的三个指纹(依赖 / schema / migrations)。部署前在服务器上对一下,就知道要不要装依赖、备份库。
 *
 *   node scripts/release.mjs check
 *       按上一个 v* 标签,校验 package.json 的版本号跳得对不对(不打包)。
 *
 *   node scripts/release.mjs pack --out <目录> [--date YYYYMMDD]
 *       从 HEAD 打包(工作区必须是干净的):
 *       <目录>/prism/                         解出来的树(含生成的 RELEASE.json)
 *       <目录>/v<版本>-manifest.txt            逐文件清单(它的 md5 = 清单指纹)
 *       <目录>/prism-<日期>-v<版本>.tar.gz     包
 *       打完、落盘之后再打 git 标签:git tag v<版本>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINGERPRINT_FILES,
  checkBump,
  isValidReleaseDate,
  md5,
  manifestLines,
  parseVersion,
  pickPreviousTag,
  releaseDate,
  treeFingerprints,
} from './release-lib.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFail) return null;
    fail(`git ${args.join(' ')} 失败:${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

const readAtRev = (rev) => (rel) => git(['show', `${rev}:${rel}`], { allowFail: true });

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  // 复审(P3):`--date` 后面忘了写值时,别把下一个参数吞进来、也别悄悄当没给
  if (value === undefined || value.startsWith('--')) fail(`${name} 后面要跟一个值`);
  return value;
}

/**
 * 上一个已发布的版本:已合进 HEAD 的 v* 标签里版本号最大的那个(不含这一版自己的标签 —— HEAD 自己带着它 = 重打同一版)。
 * 见 release-lib 的 pickPreviousTag(为什么不用 git describe)。
 */
function previousRelease(version) {
  const tag = `v${version}`;
  const tagged = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFail: true })?.trim() || null;
  const head = git(['rev-parse', 'HEAD']).trim();
  if (tagged && tagged !== head) fail(`${tag} 已经发过(标签指着 ${tagged.slice(0, 7)},不是 HEAD)—— 号不复用,换一个版本号`);
  // 复审(P3):浅克隆 / 标签没拉全时会悄悄当成「第一个版本」放行(上一版、升级标记都成 null)—— 直接拦下
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') fail('这是浅克隆,找不全上一版 —— 先 git fetch --unshallow --tags');
  const merged = git(['tag', '--merged', 'HEAD', '--list', 'v*']).split('\n').filter(Boolean);
  const previousTag = pickPreviousTag(merged, version);
  if (!previousTag) {
    const anyRelease = pickPreviousTag(git(['tag', '--list', 'v*']).split('\n').filter(Boolean), version);
    if (anyRelease) fail(`仓库里有发布标签(比如 ${anyRelease}),但 HEAD 一个都没合进来 —— 分支拉错了?`);
    return null;
  }
  const previousVersion = previousTag.slice(1);
  return {
    version: previousVersion,
    commit: git(['rev-parse', '--short', `${previousTag}^{commit}`]).trim(),
    fingerprints: treeFingerprints(readAtRev(previousTag)),
  };
}

function versionAt(rev) {
  const pkg = JSON.parse(readAtRev(rev)('package.json') ?? '{}');
  const lock = JSON.parse(readAtRev(rev)(FINGERPRINT_FILES.deps) ?? '{}');
  const version = pkg.version;
  if (!parseVersion(version)) fail(`package.json 的版本号「${version}」不是「主.次.修」三个数字`);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`package-lock.json 根上的版本号(${lock.version} / ${lock.packages?.['']?.version})与 package.json(${version})对不上 —— 跑一次 npm install --package-lock-only`);
  }
  return { version, engines: pkg.engines ?? null, lock };
}

function evaluate(rev) {
  const { version, engines, lock } = versionAt(rev);
  const fingerprints = treeFingerprints(readAtRev(rev));
  const previous = previousRelease(version);
  const changed = previous
    ? Object.fromEntries(Object.keys(fingerprints).map((key) => [key, fingerprints[key] !== previous.fingerprints[key]]))
    : null;
  const verdict = checkBump({ previous: previous?.version ?? null, next: version, changed });
  return { version, engines, lock, fingerprints, previous, changed, verdict };
}

function report({ version, previous, changed, verdict }) {
  console.log(`版本号      ${version}`);
  if (!previous) {
    console.log('上一版      (没有 v* 标签 —— 这是第一个按数字编号的版本)');
  } else {
    console.log(`上一版      ${previous.version}(${previous.commit})→ 跳的是 ${verdict.kind}`);
    console.log(`与上一版比  依赖 ${changed.deps ? '变了' : '没变'} · schema ${changed.schema ? '变了' : '没变'} · migrations ${changed.migrations ? '变了' : '没变'}`);
    console.log(`至少要跳    ${verdict.required === 'minor' ? '次版本号' : '修订号'}`);
  }
  console.log('「主」要人判:换 Node / 换随包 CLI / 必须改 settings.json 或 .env / 不可回滚的迁移 / 删功能或改默认行为 → 跳主版本号');
  for (const problem of verdict.problems) console.error(`✗ ${problem}`);
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function componentVersions(lock) {
  const sdk = lock.packages?.['node_modules/@anthropic-ai/claude-agent-sdk']?.version ?? null;
  let claudeCode = null;
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
    if (installed.version === sdk) claudeCode = installed.claudeCodeVersion ?? null;
  } catch {
    // 没装依赖:只记 SDK 版本
  }
  return { claudeAgentSdk: sdk, claudeCode };
}

function pack() {
  const outArg = argValue('--out');
  if (!outArg) fail('pack 要 --out <目录>');
  const date = argValue('--date') ?? releaseDate();
  if (!isValidReleaseDate(date)) fail(`--date 要一个真实的日子 YYYYMMDD,收到「${date}」`);
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) fail(`工作区不干净(包从 HEAD 打,没提交的改动不会进包):\n${dirty}`);

  const result = evaluate('HEAD');
  report(result);
  if (!result.verdict.ok) process.exit(1);

  const out = path.resolve(outArg);
  const tree = path.join(out, 'prism');
  if (fs.existsSync(tree)) fail(`${tree} 已经存在 —— 换一个空目录`);
  fs.mkdirSync(out, { recursive: true });
  const archive = path.join(out, '.src.tar');
  git(['archive', '--format=tar', '--prefix=prism/', '-o', archive, 'HEAD']);
  const untar = spawnSync('tar', ['-xf', archive, '-C', out], { encoding: 'utf8' });
  fs.rmSync(archive);
  if (untar.status !== 0) fail(`解 git archive 失败:${untar.stderr}`);

  const commit = git(['rev-parse', '--short', 'HEAD']).trim();
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const filesBefore = walk(tree);
  const release = {
    version: result.version,
    date: isoDate,
    commit,
    files: filesBefore.length + 1,
    fingerprints: result.fingerprints,
    previous: result.previous ? { version: result.previous.version, commit: result.previous.commit } : null,
    upgrade: result.changed
      ? { npmInstall: result.changed.deps, migration: result.changed.schema || result.changed.migrations }
      : null,
    components: { node: result.engines?.node ?? null, ...componentVersions(result.lock) },
  };
  fs.writeFileSync(path.join(tree, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);

  const files = walk(tree);
  for (const rel of files) {
    if (/[\n\\]/.test(rel)) fail(`文件名里有换行或反斜杠,md5sum 会转义,清单对不上:${rel}`);
  }
  const lines = manifestLines(files.map((rel) => ({ rel, content: fs.readFileSync(path.join(tree, rel)) })));
  const manifestName = `v${result.version}-manifest.txt`;
  const manifestPath = path.join(out, manifestName);
  fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`);

  const tarName = `prism-${date}-v${result.version}.tar.gz`;
  const tarPath = path.join(out, tarName);
  const tarred = spawnSync('tar', [
    `--mtime=${isoDate} 00:00`, '--owner=root', '--group=root', '--sort=name', '-czf', tarPath, '-C', out, 'prism',
  ], { encoding: 'utf8' });
  if (tarred.status !== 0) fail(`打包失败:${tarred.stderr}`);

  const lockText = fs.readFileSync(path.join(tree, FINGERPRINT_FILES.deps));
  console.log('');
  console.log(`包          ${tarName}  md5 ${md5(fs.readFileSync(tarPath))}`);
  console.log(`清单        ${manifestName}  md5(清单指纹)${md5(fs.readFileSync(manifestPath))}`);
  console.log(`文件数      ${files.length}`);
  console.log(`提交        ${commit}`);
  console.log(`依赖指纹    ${result.fingerprints.deps}(package-lock.json 整份 md5 ${md5(lockText)})`);
  console.log(`schema.ts   ${result.fingerprints.schema}`);
  console.log(`migrations  ${result.fingerprints.migrations}`);
  console.log(`落盘之后:git tag v${result.version}`);
}

function fingerprint() {
  const root = path.resolve(argValue('--root') ?? process.cwd());
  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  // 复审(P3):在子目录里跑(或 --root 指错)时别悄悄打出一排 null
  if (readFile('package.json') == null) fail(`${root} 下没有 package.json —— 在 Prism 的安装目录里跑,或用 --root 指过去`);
  const prints = treeFingerprints(readFile);
  let version = null;
  try {
    version = JSON.parse(readFile('package.json') ?? '{}').version ?? null;
  } catch {
    // 忽略
  }
  console.log(JSON.stringify({ root, version, ...prints }, null, 2));
}

const command = process.argv[2];
if (command === 'pack') pack();
else if (command === 'check') {
  const result = evaluate('HEAD');
  report(result);
  process.exit(result.verdict.ok ? 0 : 1);
} else if (command === 'fingerprint') fingerprint();
else {
  console.log('用法:node scripts/release.mjs fingerprint [--root <目录>] | check | pack --out <目录> [--date YYYYMMDD]');
  process.exit(command ? 1 : 0);
}

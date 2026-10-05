import assert from 'node:assert/strict';
import fsNode from 'node:fs';
import { createRequire } from 'node:module';
import pathNode from 'node:path';

import { test } from 'vitest';

import {
  bundledClaudeBinaryCandidates,
  configuredClaudeCliPath,
  resetBundledClaudeBinaryCacheForTests,
  resolveBundledClaudeBinary,
  resolveClaudeCodeExecutablePath,
  resolveClaudeCommandForShell,
  sdkExecutableOption,
  shellQuote,
  withBundledClaudeOnPath,
  type ResolveClaudeCodeExecutablePathDependencies,
} from '@/shared/claude-cli-path.js';

test('resolveClaudeCodeExecutablePath resolves the npm Claude wrapper to its native exe on Windows', () => {
  const wrapperDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${wrapperDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => '') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicit JavaScript launcher path unchanged', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
  });

  assert.equal(resolved, scriptPath);
});

test('resolveClaudeCodeExecutablePath can parse a wrapper file path containing letters r and n before claude.exe', () => {
  const wrapperPath = 'C:\\tools\\claude';
  const nativePath = 'C:\\tools\\custom\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const readFileSync = (() => `exec "$basedir/custom/bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"`) as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(wrapperPath, {
    platform: 'win32',
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath falls back to the configured command when PATH lookup fails', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
  });

  assert.equal(resolved, 'claude');
});

/* ---------------- hm(A2):随包二进制 ---------------- */


test('hm:CLAUDE_CLI_PATH 没配 → 传随包二进制的绝对路径(不让 SDK 每次自己挑);找不到 → claude;配了照旧解析', () => {
  const bundled = { platform: 'linux', arch: 'x64', preferMusl: false, resolve: (id: string) => `/app/node_modules/${id}`, exists: () => true };
  assert.equal(sdkExecutableOption(undefined, bundled), '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  assert.equal(sdkExecutableOption('   ', bundled), '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  const missing = { platform: 'linux', arch: 'x64', preferMusl: false, resolve: () => { throw new Error('nope'); } };
  assert.equal(sdkExecutableOption(undefined, missing), 'claude', '平台包没装:退回 PATH 上的 claude,而不是让 SDK 抛错');
  assert.equal(sdkExecutableOption('"/opt/c/claude"', { platform: 'linux' }), '/opt/c/claude');
  assert.equal(configuredClaudeCliPath('claude'), 'claude');
});

test('hm:候选顺序与 SDK 一致 —— glibc 先 glibc,musl 先 musl,其它平台一个', () => {
  assert.deepEqual(bundledClaudeBinaryCandidates('linux', 'x64', false), [
    '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  ]);
  assert.deepEqual(bundledClaudeBinaryCandidates('linux', 'arm64', true), [
    '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude',
    '@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
  ]);
  assert.deepEqual(bundledClaudeBinaryCandidates('win32', 'x64', false), ['@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']);
  assert.deepEqual(bundledClaudeBinaryCandidates('darwin', 'arm64', false), ['@anthropic-ai/claude-agent-sdk-darwin-arm64/claude']);
});

test('hm:**漂移守卫** —— SDK 包里的选择逻辑仍是我们照抄的那一段(换版改了顺序就红)', () => {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const bundle = fsNode.readFileSync(sdkEntry, 'utf8');
  // 默认不传路径时用随包二进制
  assert.match(bundle, /pathToClaudeCodeExecutable;if\(!\w+\)\{let \w+=\w+\(import\.meta\.url\)/);
  // musl 探测:没有 glibcVersionRuntime = musl
  assert.match(bundle, /header\?\.glibcVersionRuntime===void 0/);
  // linux:musl 优先时 -musl 在前,否则 glibc 在前;路径是 <包>/claude<exe>
  assert.match(bundle, /\?\[`\$\{\w+\}-linux-\$\{\w+\}-musl`,`\$\{\w+\}-linux-\$\{\w+\}`\]:\[`\$\{\w+\}-linux-\$\{\w+\}`,`\$\{\w+\}-linux-\$\{\w+\}-musl`\]/);
  assert.match(bundle, /`\$\{\w+\}\/claude\$\{\w+\}`/);
});

test('hm:本机(容器)解析到的就是 SDK 会用的那个平台包里的 claude,且真实存在', () => {
  resetBundledClaudeBinaryCacheForTests();
  const found = resolveBundledClaudeBinary();
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.ok(found, '没解析到随包二进制');
    assert.match(found!, /claude-agent-sdk-linux-x64(-musl)?[\\/]claude$/);
    assert.ok(fsNode.existsSync(found!));
  }
});

test('hm:解析不到任何平台包 → null;终端命令回落 PATH 上的 claude', () => {
  const deps = { platform: 'linux', arch: 'x64', preferMusl: false, resolve: () => { throw new Error('nope'); } };
  assert.equal(resolveBundledClaudeBinary(deps), null);
  assert.deepEqual(resolveClaudeCommandForShell(undefined, deps), { command: 'claude', source: 'path' });
});

test('hm:终端命令 —— 配了用配的(路径加引号),没配用随包路径', () => {
  const deps = { platform: 'linux', arch: 'x64', preferMusl: false, resolve: (id: string) => `/app/node_modules/${id}`, exists: () => true };
  assert.deepEqual(resolveClaudeCommandForShell(undefined, deps), {
    command: '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', source: 'bundled',
  });
  assert.deepEqual(resolveClaudeCommandForShell('/opt/my claude/claude', deps), { command: "'/opt/my claude/claude'", source: 'configured' });
  assert.deepEqual(resolveClaudeCommandForShell('claude', deps), { command: 'claude', source: 'configured' });
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('hm:PATH 前置随包目录;CLAUDE_CLI_PATH 配成路径就前置它的目录,配成裸命令名就不动;不重复', () => {
  const deps = { platform: 'linux', arch: 'x64', preferMusl: false, resolve: (id: string) => `/app/node_modules/${id}`, exists: () => true };
  const dir = pathNode.posix.dirname('/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  const env = withBundledClaudeOnPath({ PATH: `/usr/bin:${dir}:/bin`, HOME: '/h' }, { ...deps, configuredPath: undefined });
  assert.equal(env.PATH, `${dir}:/usr/bin:/bin`);
  assert.equal(env.HOME, '/h');
  const untouched = withBundledClaudeOnPath({ PATH: '/usr/bin' }, { ...deps, configuredPath: 'claude' });
  assert.equal(untouched.PATH, '/usr/bin');
  // 复审:配成路径时终端与 SkillWhet 也要用它(原来不动 PATH,只有对话 / 接管 / 登录用上)
  const configured = withBundledClaudeOnPath({ PATH: '/usr/bin:/opt/claude/bin' }, { ...deps, configuredPath: '/opt/claude/bin/claude' });
  assert.equal(configured.PATH, '/opt/claude/bin:/usr/bin');
  // 相对路径不进 PATH
  assert.equal(withBundledClaudeOnPath({ PATH: '/usr/bin' }, { ...deps, configuredPath: 'node_modules/.bin/claude' }).PATH, '/usr/bin');
});

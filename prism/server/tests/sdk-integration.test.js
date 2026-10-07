import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import {
  applyServerToolPolicy,
  classifySetModelError,
  classifyTurnResult,
  cliEchoesUserMessageUuid,
  mapCliOptionsToSDK,
  runtimeSettingsFromOptions,
} from '../claude-sdk.js';
import {
  CLI_SESSION_MARKER_KEYS,
  CROSS_SESSION_TOOLS,
  buildClaudeSdkEnv,
  scrubInheritedSessionMarkers,
} from '../shared/claude-runtime-env.js';
import { checkClaudeUserSettings } from '../modules/providers/list/claude/claude-settings-selfcheck.js';
import {
  buildShellCommand,
  normalizeTakeoverPermissionMode,
} from '../modules/websocket/services/shell-websocket.service.js';

/**
 * 适配 SDK 0.3.285(随包 CLI 2.1.285)所需的行为:跨会话工具禁用、子进程 env 与可执行文件、继承会话标记清理、
 * result 归属判定、getContextUsage 的 summary 模式、setModel 失败分类、终端接管的权限档位、settings.json 自检。
 * 涉及 CLI / SDK 外部行为的断言可以用 scripts/sdk-probe 复测。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'claude-sdk.js'), 'utf8');
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

const withEnv = (vars, run) => {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const baseOptions = {
  cwd: '/tmp/x',
  toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
};

describe('跨会话消息', () => {
  test('两个工具无条件进 disallowedTools —— 客户端不给、强制名单没配也一样', () => {
    withEnv({ PRISM_FORCED_DENY_TOOLS: undefined }, () => {
      const policed = applyServerToolPolicy('default', [], 'alice', []);
      for (const tool of CROSS_SESSION_TOOLS) assert.ok(policed.disallowedTools.includes(tool), `${tool} 没被禁`);
      const sdk = mapCliOptionsToSDK(baseOptions);
      for (const tool of CROSS_SESSION_TOOLS) assert.ok(sdk.disallowedTools.includes(tool));
      const persistent = runtimeSettingsFromOptions(baseOptions);
      for (const tool of CROSS_SESSION_TOOLS) assert.ok(persistent.disallowedTools.includes(tool));
    });
  });

  test('客户端把它们放进预批清单也放不出来(禁用压过预批)', () => {
    withEnv({ PRISM_ALLOW_BYPASS_USERS: undefined }, () => {
      const policed = applyServerToolPolicy('default', [], 'alice', ['SendMessage', 'Read']);
      assert.deepEqual(policed.allowedTools, ['Read']);
    });
  });

  test('两条 SDK 路径的 settings 都带 crossSessionInbound: refuse', () => {
    const sdk = mapCliOptionsToSDK(baseOptions);
    assert.equal(sdk.settings?.crossSessionInbound, 'refuse');
  });
});

describe('子进程 env 与可执行文件', () => {
  test('没配 CLAUDE_CLI_PATH:传 SDK 随包的那一份的绝对路径(Prism 挑好并缓存;SDK 自己挑每次都跑 process.report)', () => {
    withEnv({ CLAUDE_CLI_PATH: undefined }, () => {
      const sdk = mapCliOptionsToSDK(baseOptions);
      // 平台包在(CI 可能是别的架构)→ 随包路径;平台包没装 → 退回 'claude'
      assert.match(String(sdk.pathToClaudeCodeExecutable), /(@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)?|^claude)$/);
    });
  });

  test('显式配了就用它(写 claude 等于退回全局 CLI)', () => {
    withEnv({ CLAUDE_CLI_PATH: '/opt/claude/bin/claude' }, () => {
      assert.equal(mapCliOptionsToSDK(baseOptions).pathToClaudeCodeExecutable, '/opt/claude/bin/claude');
    });
    withEnv({ CLAUDE_CLI_PATH: 'claude' }, () => {
      assert.equal(mapCliOptionsToSDK(baseOptions).pathToClaudeCodeExecutable, 'claude');
    });
  });

  test('env:整份拷 process.env,另带 CLAUDE_CODE_ENABLE_TODO_TOOLS=1 与 DISABLE_AUTOUPDATER=1', () => {
    withEnv({ PRISM_HM_PROBE_VAR: 'x' }, () => {
      const env = mapCliOptionsToSDK(baseOptions).env;
      assert.equal(env.PRISM_HM_PROBE_VAR, 'x');
      assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1');
      assert.equal(env.DISABLE_AUTOUPDATER, '1');
    });
  });

  test('buildClaudeSdkEnv:extra 里 undefined 的键会被删掉', () => {
    const env = buildClaudeSdkEnv({ A: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '9' }, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: undefined, B: '2' });
    assert.equal(env.A, '1');
    assert.equal(env.B, '2');
    assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env, false);
  });

  test('常驻路径与一次性 / 实测路径同一份 env 与可执行文件规则', () => {
    const persistent = codeOnly.slice(codeOnly.indexOf('function buildPersistentSdkOptions('), codeOnly.indexOf('async function readPersistentRuntime('));
    // 两条路径写法相同:按模型窗口补 env(modelWindowEnv),再并上子代理模型的 env。
    // 子代理 env 优先用按这一轮的人与网关筛过的 options.subagentEnv(见 modelRuntimeSettings),没给才退回全局的 subagentModelEnv()。
    assert.match(persistent, /sdkOptions\.env = buildClaudeSdkEnv\(process\.env, \{ \.\.\.modelWindowEnv\(options\.contextWindow\), \.\.\.\(options\.subagentEnv \?\? subagentModelEnv\(\)\) \}\)/);
    assert.equal((codeOnly.match(/sdkOptions\.env = buildClaudeSdkEnv\(process\.env, \{ \.\.\.modelWindowEnv\(options\.contextWindow\), \.\.\.\(options\.subagentEnv \?\? subagentModelEnv\(\)\) \}\)/g) ?? []).length, 2, '一次性与常驻两处');
    assert.match(persistent, /sdkExecutableOption\(\)/);
    assert.equal(/resolveClaudeCodeExecutablePath/.test(codeOnly), false, 'claude-sdk.js 里不该再有恒传 claude 的老写法');
    const probe = readFileSync(path.join(here, '..', 'modules', 'providers', 'list', 'claude', 'claude-model-probe.service.ts'), 'utf8');
    assert.match(probe, /env: buildClaudeSdkEnv\(process\.env\)/);
  });
});

describe('不设 CLAUDE_CODE_STREAM_CLOSE_TIMEOUT', () => {
  test('代码里不再往 process.env 写它', () => {
    assert.equal(/process\.env\.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT/.test(codeOnly), false);
  });
});

describe('继承来的会话标记', () => {
  test('从 CLI 的 shell 里起:标记与四个通用名一起删', () => {
    const env = {
      CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_SESSION_ATTENDED: '0',
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '42', CLAUDE_EFFORT: 'high', AI_AGENT: 'x', TRACEPARENT: 't',
      ANTHROPIC_BASE_URL: 'http://gw', PATH: '/bin',
    };
    const removed = scrubInheritedSessionMarkers(env);
    assert.equal(removed.length, 9);
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_BASE_URL', 'PATH']);
  });

  test('不是从 CLI 里起的:通用名(TRACEPARENT 等)留着,只删 CLI 专属的', () => {
    const env = { TRACEPARENT: 't', AI_AGENT: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    scrubInheritedSessionMarkers(env);
    assert.deepEqual(env, { TRACEPARENT: 't', AI_AGENT: 'x' });
  });

  test('清单里有让 CLI 不写 transcript 的那个', () => {
    assert.ok(CLI_SESSION_MARKER_KEYS.includes('CLAUDE_CODE_CHILD_SESSION'));
    assert.ok(CLI_SESSION_MARKER_KEYS.includes('CLAUDECODE'));
  });
});

describe('result 归属', () => {
  const turn = { userMessageUuids: new Set(['u-mine', 'u-merged']) };

  test('CLI 版本门槛:2.1.259 起回显 uuid', () => {
    assert.equal(cliEchoesUserMessageUuid('2.1.285'), true);
    assert.equal(cliEchoesUserMessageUuid('2.1.259'), true);
    assert.equal(cliEchoesUserMessageUuid('2.1.258'), false);
    assert.equal(cliEchoesUserMessageUuid('2.1.165'), false);
    assert.equal(cliEchoesUserMessageUuid('3.0.0'), true);
    assert.equal(cliEchoesUserMessageUuid(undefined), false);
    assert.equal(cliEchoesUserMessageUuid('garbage'), false);
  });

  test('回显含本回合的 uuid(首条或合流的)→ own', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 1, user_message_uuid: 'u-mine' }, { uuidEcho: true }), 'own');
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 2, user_message_uuid: 'x', user_message_uuids: ['x', 'u-merged'] }, { uuidEcho: true }), 'own');
  });

  test('本地命令(/context /compact)num_turns 为 0 但回显了 uuid → own(实测 2.1.285)', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 0, local_command: 'compact', user_message_uuid: 'u-mine' }, { uuidEcho: true }), 'own');
  });

  test('回显的全是别人的 uuid → foreign', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 1, user_message_uuid: 'other' }, { uuidEcho: true }), 'foreign');
  });

  test('后台任务收尾的空结果(没带 uuid、num_turns 0、成功、不是本地命令)→ foreign', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'success', is_error: false, num_turns: 0 }, { uuidEcho: true }), 'foreign');
  });

  test('没带 uuid 的出错结果(崩溃这类会话级失败)→ unknown,交给原判据收掉用户回合', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'error_during_execution', is_error: true, num_turns: 0 }, { uuidEcho: true }), 'unknown');
    assert.equal(classifyTurnResult(turn, { subtype: 'success', is_error: true, num_turns: 0 }, { uuidEcho: true }), 'unknown');
  });

  test('老 CLI(不回显)→ 一律 unknown;没带 uuid 的非空成功也 unknown', () => {
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 0 }, { uuidEcho: false }), 'unknown');
    assert.equal(classifyTurnResult(turn, { subtype: 'success', num_turns: 3 }, { uuidEcho: true }), 'unknown');
  });

  test('本回合还没有 uuid(不该发生)→ unknown', () => {
    assert.equal(classifyTurnResult({ userMessageUuids: new Set() }, { subtype: 'success', num_turns: 0, user_message_uuid: 'x' }, { uuidEcho: true }), 'unknown');
  });

  test('接线:回合推消息带 uuid、合流的 uuid 记进本回合、读循环先按 uuid 判', () => {
    const turnBlock = codeOnly.slice(codeOnly.indexOf('async function runPersistentTurn('), codeOnly.indexOf('async function readRuntimeContextUsage('));
    assert.match(turnBlock, /uuid: userMessageUuid/);
    assert.match(turnBlock, /turn\.userMessageUuids\.add\(userMessageUuid\)/);
    const mergeBlock = codeOnly.slice(codeOnly.indexOf('export async function mergeUserMessage('));
    assert.match(mergeBlock.slice(0, 2000), /runtime\.turn\?\.userMessageUuids\?\.add\(uuid\)/);
    const reader = codeOnly.slice(codeOnly.indexOf('async function readPersistentRuntime('), codeOnly.indexOf('function rekeyRuntime('));
    assert.match(reader, /classifyTurnResult\(turn, message/);
    assert.match(reader, /noteCliInit\(runtime, message/);
  });
});

describe('getContextUsage 用 summary', () => {
  test('回合结束 / 回填 / loop 收尾传 summary,REST 保持 full', () => {
    const calls = [...codeOnly.matchAll(/readRuntimeContextUsage\(runtime(, \{ detail: 'summary' \})?\)/g)];
    assert.equal(calls.filter((m) => m[1]).length, 3, '三处内部调用应当传 summary');
    const rest = codeOnly.slice(codeOnly.indexOf('async function getClaudeContextUsage('));
    assert.match(rest.slice(0, 300), /return readRuntimeContextUsage\(runtime\);/);
  });
});

describe('setModel 被拒与超时分开', () => {
  test('超时打标记;拒绝走专用错误、调度器不退回一次性路径', () => {
    assert.match(codeOnly, /timeout\.prismControlTimeout = true/);
    assert.match(codeOnly, /rejected\.prismModelRejected = true/);
    const dispatch = codeOnly.slice(codeOnly.indexOf('async function queryClaudeSDKDispatch('));
    const rejectedAt = dispatch.indexOf('error?.prismModelRejected');
    const fallbackAt = dispatch.indexOf("falling back to one-shot mode");
    assert.ok(rejectedAt > 0 && rejectedAt < fallbackAt, '专用分支要排在通用回退之前');
  });
});

describe('终端接管带权限档位', () => {
  const resume = { ok: true, sessionId: 'sess-1' };

  test('白名单:auto → default,认不出的 → default', () => {
    assert.equal(normalizeTakeoverPermissionMode('plan'), 'plan');
    assert.equal(normalizeTakeoverPermissionMode('acceptEdits'), 'acceptEdits');
    assert.equal(normalizeTakeoverPermissionMode('bypassPermissions'), 'bypassPermissions');
    assert.equal(normalizeTakeoverPermissionMode('auto'), 'default');
    assert.equal(normalizeTakeoverPermissionMode('plan; rm -rf /'), 'default');
    assert.equal(normalizeTakeoverPermissionMode(undefined), 'default');
  });

  test('接管命令显式带 --permission-mode,用的是给定的 claude', () => {
    assert.equal(
      buildShellCommand({ takeover: true }, resume, { permissionMode: 'plan', claudeCommand: '/x/claude' }),
      '/x/claude --resume "sess-1" --permission-mode plan',
    );
    assert.equal(
      buildShellCommand({ takeover: true }, resume, { permissionMode: 'auto', claudeCommand: 'claude' }),
      'claude --resume "sess-1" --permission-mode default',
    );
  });

  test('登录命令开头的 claude 换成 Prism 实际用的那一个,其余命令原样', () => {
    assert.equal(
      buildShellCommand({ initialCommand: 'claude --dangerously-skip-permissions /login' }, { ok: false, reason: 'no_session' }, { claudeCommand: '/x/claude' }),
      '/x/claude --dangerously-skip-permissions /login',
    );
    assert.equal(buildShellCommand({ initialCommand: 'claudette run' }, { ok: false, reason: 'no_session' }, { claudeCommand: '/x/claude' }), 'claudette run');
    assert.equal(buildShellCommand({ initialCommand: 'ls -la' }, { ok: false, reason: 'no_session' }, { claudeCommand: '/x/claude' }), 'ls -la');
  });

  test('普通终端(不接管)仍是空串 = 登录 shell', () => {
    assert.equal(buildShellCommand({}, resume, { claudeCommand: '/x/claude' }), '');
  });
});

describe('settings.json 启动自检', () => {
  test('三项都在、env 干净 → 没有发现', () => {
    assert.deepEqual(checkClaudeUserSettings({
      env: { ANTHROPIC_BASE_URL: 'http://gw' },
      permissions: { deny: ['SendMessage', 'ListAgents', 'Bash(rm:*)'] },
      crossSessionInbound: 'refuse',
      cleanupPeriodDays: 3650,
    }), []);
  });

  test('env 里有 Prism 自己传的变量 / 缺三项 → 各一条 warn', () => {
    const findings = checkClaudeUserSettings({
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000' },
      permissions: { deny: ['SendMessage'] },
    });
    const text = findings.map((f) => f.message).join('\n');
    assert.match(text, /CLAUDE_CODE_MAX_CONTEXT_TOKENS/);
    assert.match(text, /crossSessionInbound/);
    assert.match(text, /ListAgents/);
    assert.match(text, /cleanupPeriodDays/);
    assert.equal(findings.every((f) => f.level === 'warn'), true);
  });

  test('读不到文件 → 一条 warn;保留期偏短 → info', () => {
    assert.equal(checkClaudeUserSettings(null).length, 1);
    const short = checkClaudeUserSettings({ crossSessionInbound: 'refuse', permissions: { deny: ['SendMessage', 'ListAgents'] }, cleanupPeriodDays: 30 });
    assert.deepEqual(short.map((f) => f.level), ['info']);
  });
});

describe('setModel 失败分类、压缩后的用量、进程报告与终端任务清单', () => {
  test('setModel 失败分类:网关明确拒 → rejected;超时 / 429 / 5xx / 通道断 → retry(重建)', () => {
    assert.equal(classifySetModelError(Object.assign(new Error('x'), { prismControlTimeout: true })), 'retry');
    assert.equal(classifySetModelError(new Error('API error: 529 {"type":"overloaded_error"} model not changed')), 'retry');
    assert.equal(classifySetModelError(new Error('API Error: 429 rate limited')), 'retry');
    assert.equal(classifySetModelError(new Error('ProcessTransport is not ready for writing / transport closed')), 'retry');
    assert.equal(classifySetModelError(new Error('API error: 400 unknown model glm-9')), 'rejected');
    assert.equal(classifySetModelError(new Error("There's an issue with the selected model (x). It may not exist or you may not have access to it.")), 'rejected');
  });

  test('压缩之后第一次读用量用 full(summary 在下一次模型调用前还是压缩前的数,实测)', () => {
    assert.match(codeOnly, /if \(ok && runtime\) runtime\.compactedSinceUsageRead = true;/);
    assert.match(codeOnly, /subtype === 'compact_boundary'\) \{\s*const meta = message\.compact_metadata \|\| \{\};\s*runtime\.compactedSinceUsageRead = true;/);
    assert.match(codeOnly, /const afterCompaction = detail === 'summary' && runtime\.compactedSinceUsageRead;\s*if \(afterCompaction\) detail = 'full';/);
    assert.match(codeOnly, /runtime\.lastContextUsage = normalized;\s*if \(afterCompaction\) runtime\.compactedSinceUsageRead = false;/, '读成了才清标记');
  });

  test('进程报告不做反向 DNS(load-env 最早设 excludeNetwork)', () => {
    const loadEnv = readFileSync(path.join(here, '..', 'load-env.js'), 'utf8');
    assert.match(loadEnv, /process\.report\.excludeNetwork = true;/);
  });

  test('终端 PTY 也开任务清单工具(接管后不丢 TaskCreate)', () => {
    const shell = readFileSync(path.join(here, '..', 'modules', 'websocket', 'services', 'shell-websocket.service.ts'), 'utf8');
    assert.match(shell, /CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',/);
  });
});

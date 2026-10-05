import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, test, vi } from 'vitest';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  modelTurnStatsDb,
  sessionMessagesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  claudeModelCatalog,
  invalidateCatalogCache,
  subagentModelEnv,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import { readTaskApprovalPolicy } from '@/modules/tasks/services/scheduled-tasks.service.js';

import {
  apiRetryStatusFrame,
  cliNoticeFrame,
  describeOneShotResultError,
  describeTerminalReason,
  frameAnswersMerged,
  mapCliOptionsToSDK,
  noteBackgroundTasks,
  recordModelTurnStat,
  modelUsageSnapshot,
  turnModelFromUsage,
  releaseRuntimeSideState,
  noteMergedDelivered,
  withdrawMergedBeforeInterrupt,
  runtimeIsIdle,
  setBackgroundTasksHook,
  setMergedMessageHook,
  settleMergedAfterInterrupt,
  stopInterruptBackgroundedTask,
} from '../claude-sdk.js';

/**
 * ho:用好 SDK 0.3.285 / CLI 2.1.285(方案 285 能力提升 ho / hp / hq)。
 * 行为部分在容器假网关上实测过(见方案附录),这里钉的是 Prism 这一侧的判据与接线。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

async function freshDb() {
  tempDir = await mkdtemp(path.join(tmpdir(), 'ho-285-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
  invalidateCatalogCache();
}

afterEach(async () => {
  setMergedMessageHook(null);
  setBackgroundTasksHook(null);
  closeConnection();
  invalidateCatalogCache();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const fakeRuntime = (extra: Record<string, unknown> = {}) => ({
  key: 'rt-1',
  disposed: false,
  turn: null,
  orphanTurnOpen: false,
  pendingToolUses: new Set<string>(),
  appSessionId: 'app-1',
  mergedUuids: new Map<string, { appSessionId: string; at: number }>(),
  query: {} as Record<string, unknown>,
  ...extra,
});

describe('ho-1 停止 = 真停', () => {
  test('回执里 cancelled 的合流消息 → 报"已撤回"', async () => {
    const runtime = fakeRuntime();
    runtime.mergedUuids.set('m-1', { appSessionId: 'app-1', at: Date.now() });
    const events: unknown[] = [];
    setMergedMessageHook((event: unknown) => events.push(event));
    const withdrawn = await settleMergedAfterInterrupt(runtime, runtime.query, { still_queued: [], cancelled: ['m-1', 'not-ours'] });
    assert.deepEqual(withdrawn, ['m-1']);
    assert.deepEqual(events, [{ type: 'withdrawn', appSessionId: 'app-1', uuids: ['m-1'], reason: 'aborted' }]);
    assert.equal(runtime.mergedUuids.size, 0);
  });

  test('只有 still_queued(没带 cancelQueued 的老能力位)→ 逐条 cancelAsyncMessage,返回 true 才算撤到', async () => {
    const runtime = fakeRuntime();
    runtime.mergedUuids.set('m-1', { appSessionId: 'app-1', at: Date.now() });
    runtime.mergedUuids.set('m-2', { appSessionId: 'app-1', at: Date.now() });
    const cancelAsyncMessage = vi.fn(async (uuid: string) => uuid === 'm-1');
    runtime.query = { cancelAsyncMessage };
    const withdrawn = await settleMergedAfterInterrupt(runtime, runtime.query, { still_queued: ['m-1', 'm-2', 'cli-own'] });
    assert.deepEqual(withdrawn, ['m-1']);
    assert.deepEqual(cancelAsyncMessage.mock.calls.map((call) => call[0]), ['m-1', 'm-2']);
    assert.ok(runtime.mergedUuids.has('m-2'), '没撤到的留着(之后由送达 / 回收清)');
  });

  test('老 CLI 没回执:什么都不做', async () => {
    const runtime = fakeRuntime();
    runtime.mergedUuids.set('m-1', { appSessionId: 'app-1', at: Date.now() });
    assert.deepEqual(await settleMergedAfterInterrupt(runtime, runtime.query, undefined), []);
    assert.equal(runtime.mergedUuids.size, 1);
  });

  test('中断后窗口内、tool_use_id 命中的 task_started → stopTask;窗口外 / 别的工具不碰', () => {
    const stopTask = vi.fn(async () => undefined);
    const runtime = fakeRuntime({
      query: { stopTask },
      interruptStopWindow: { toolUseIds: new Set(['toolu_fg']), until: Date.now() + 5000 },
    });
    assert.equal(stopInterruptBackgroundedTask(runtime, { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_other' }), false);
    assert.equal(stopInterruptBackgroundedTask(runtime, { type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 'toolu_fg' }), true);
    // 同一个 tool_use 只停一次
    assert.equal(stopInterruptBackgroundedTask(runtime, { type: 'system', subtype: 'task_started', task_id: 'b3', tool_use_id: 'toolu_fg' }), false);
    const expired = fakeRuntime({ query: { stopTask }, interruptStopWindow: { toolUseIds: new Set(['toolu_x']), until: Date.now() - 1 } });
    assert.equal(stopInterruptBackgroundedTask(expired, { type: 'system', subtype: 'task_started', task_id: 'b4', tool_use_id: 'toolu_x' }), false);
    assert.equal(expired.interruptStopWindow, null);
  });

  test('源码:三处对常驻 runtime 的中断都走 interruptRuntime;**不带** cancelQueued(那会清空整个主线程队列)', async () => {
    const source = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    assert.equal((source.match(/await interruptRuntime\(/g) ?? []).length, 3);
    const fn = source.slice(source.indexOf('async function interruptRuntime('), source.indexOf('export function stopInterruptBackgroundedTask'));
    assert.match(fn, /await interruptWithTimeout\(queryLike, label, INTERRUPT_TIMEOUT_MS\);/);
    assert.doesNotMatch(fn, /cancelQueued: true/);
    assert.match(source, /stopInterruptBackgroundedTask\(runtime, message\);/);
    assert.match(source, /rememberMergedUuid\(runtime, uuid, appSessionId\);/);
  });
});

describe('ho-2 后台任务在跑就不算闲', () => {
  test('background_tasks_changed 全量替换;ambient 不算;报给 hook', () => {
    const runtime = fakeRuntime();
    const seen: unknown[] = [];
    setBackgroundTasksHook((payload: unknown) => seen.push(payload));
    assert.equal(runtimeIsIdle(runtime), true);
    noteBackgroundTasks(runtime, {
      type: 'system', subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' },
        { task_id: 'w1', task_type: 'watch', description: 'watcher', ambient: true },
      ],
    });
    assert.equal(runtimeIsIdle(runtime), false, '后台 Bash 在跑:不能被回收 / 淘汰 / 接管释放');
    assert.deepEqual(seen.at(-1), { appSessionId: 'app-1', tasks: [{ taskId: 'b1', taskType: 'local_bash', description: 'sleep 40' }] });
    noteBackgroundTasks(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    assert.equal(runtimeIsIdle(runtime), true);
    assert.equal(noteBackgroundTasks(runtime, { type: 'system', subtype: 'task_started' }), false);
  });
});

describe('ho-4 无人值守:审批立刻拒', () => {
  test('unattended → permissionPrompts: none;其余不带', () => {
    assert.equal(mapCliOptionsToSDK({ unattended: true, permissionMode: 'bypassPermissions' }).permissionPrompts, 'none');
    assert.equal(mapCliOptionsToSDK({}).permissionPrompts, undefined);
  });

  test('定时任务默认 deny,PRISM_TASK_APPROVAL=wait 回到等人批', () => {
    assert.equal(readTaskApprovalPolicy({} as NodeJS.ProcessEnv), 'deny');
    assert.equal(readTaskApprovalPolicy({ PRISM_TASK_APPROVAL: 'WAIT' } as NodeJS.ProcessEnv), 'wait');
    assert.equal(readTaskApprovalPolicy({ PRISM_TASK_APPROVAL: 'whatever' } as NodeJS.ProcessEnv), 'deny');
  });

  test('源码:/api/agent 两条路径与定时任务都带 unattended', async () => {
    const agent = await readFile(path.join(here, '..', 'routes', 'agent.js'), 'utf8');
    assert.equal((agent.match(/unattended: true,/g) ?? []).length, 2);
    const tasks = await readFile(path.join(here, '..', 'modules', 'tasks', 'services', 'scheduled-tasks.service.ts'), 'utf8');
    assert.match(tasks, /unattended: readTaskApprovalPolicy\(\) === 'deny',/);
  });
});

describe('hp 简化', () => {
  test('hp-1 effort 不在签名里,运行中 applyFlagSettings', async () => {
    const source = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    const signature = source.slice(source.indexOf('function persistentRuntimeSignature'), source.indexOf('function buildPersistentSdkOptions'));
    assert.doesNotMatch(signature, /\beffort: options\.resolvedEffort/);
    assert.match(source, /runtime\.query\.applyFlagSettings\(\{ effortLevel: targetEffort \}\)/);
  });

  test('hp-2 这一帧回答的是不是合流消息(user_message_uuid / user_message_uuids)', () => {
    const runtime = fakeRuntime();
    runtime.mergedUuids.set('m-1', { appSessionId: 'app-1', at: Date.now() });
    assert.equal(frameAnswersMerged(runtime, { type: 'assistant', user_message_uuid: 'm-1' }), true);
    assert.equal(frameAnswersMerged(runtime, { type: 'result', user_message_uuids: ['x', 'm-1'] }), true);
    assert.equal(frameAnswersMerged(runtime, { type: 'assistant', user_message_uuid: 'other' }), false);
  });

  test('hp-3 观测回合不再记 TTL', async () => {
    const observed = await readFile(path.join(here, '..', 'modules', 'websocket', 'services', 'observed-run.service.ts'), 'utf8');
    assert.doesNotMatch(observed, /mergedSends|takeMergedSend|MERGED_SEND_TTL_MS/);
  });
});

describe('hq-3 / hq-4 看得见的重试、失败原因', () => {
  test('api_retry → 一行状态;no_response 单独说', () => {
    const frame = apiRetryStatusFrame({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 8000, error_status: 529 }, 's1') as Record<string, unknown>;
    assert.equal(frame.kind, 'status');
    assert.equal(frame.text, '网关繁忙(529),第 2/10 次重试,8 秒后');
    const slow = apiRetryStatusFrame({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: null, no_response: { waited_ms: 1, retry_wait_ms: 1 } }, 's1') as Record<string, unknown>;
    assert.equal(slow.text, '网关迟迟没有响应,第 1/1 次重试');
    assert.equal(apiRetryStatusFrame({ type: 'system', subtype: 'status' }, 's1'), null);
  });

  test('informational 只要 warning / suggestion', () => {
    assert.equal(cliNoticeFrame({ type: 'system', subtype: 'informational', level: 'info', content: 'x' }, 's'), null);
    const notice = cliNoticeFrame({ type: 'system', subtype: 'informational', level: 'warning', content: ' Stop hook prevented continuation ' }, 's') as Record<string, unknown>;
    assert.equal(notice.status, 'cli_notice');
    assert.equal(notice.content, 'Stop hook prevented continuation');
  });

  test('terminal_reason → 人话,原文跟在后面', () => {
    assert.match(describeTerminalReason('malformed_tool_use_exhausted') ?? '', /工具调用不稳/);
    assert.equal(describeTerminalReason('completed'), null);
    assert.equal(
      describeOneShotResultError({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'prompt_too_long', result: 'Prompt is too long' }),
      '上下文超过了网关 / 模型的上限 —— 先发 /compact,或换一个窗口更大的模型(Prompt is too long)',
    );
    assert.equal(describeOneShotResultError({ is_error: true, result: 'boom' }), 'boom');
  });

  test('每模型健康度:按 modelUsage 里输出最多的模型记;中止与本地命令不记;汇总失败率与 p50', async () => {
    await freshDb();
    recordModelTurnStat({ type: 'result', subtype: 'success', modelUsage: { 'glm-5.2': { outputTokens: 50 }, 'kimi-k2.5': { outputTokens: 3 } }, ttft_ms: 900, duration_ms: 3000 }, { model: 'default' });
    recordModelTurnStat({ type: 'result', subtype: 'success', modelUsage: { 'glm-5.2': { outputTokens: 10 } }, ttft_ms: 1100 }, {});
    recordModelTurnStat({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'malformed_tool_use_exhausted', modelUsage: {} }, { model: 'glm-5.2' });
    recordModelTurnStat({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }, { model: 'glm-5.2' });
    recordModelTurnStat({ type: 'result', subtype: 'success', local_command: '/cost' }, { model: 'glm-5.2' });
    const [glm] = modelTurnStatsDb.summarize(7);
    assert.equal(glm.model, 'glm-5.2');
    assert.equal(glm.turns, 3);
    assert.equal(glm.errors, 1);
    assert.equal(Math.round(glm.errorRate * 100), 33);
    assert.equal(glm.ttftP50Ms, 900);
    assert.deepEqual(glm.reasons, [{ reason: 'malformed_tool_use_exhausted', count: 1 }]);
  });

  test('常驻 runtime 的 modelUsage 是累计的:换模型后按差值记到新模型上', async () => {
    await freshDb();
    // 实测形状:两轮 glm 之后 setModel(deepseek-v4),第三轮的 result 仍带着 glm 的累计
    const turn1 = modelUsageSnapshot({ 'glm-5.2': { outputTokens: 20, inputTokens: 900 } });
    const turn2 = modelUsageSnapshot({ 'glm-5.2': { outputTokens: 40, inputTokens: 1800 } });
    recordModelTurnStat({ type: 'result', subtype: 'success', modelUsage: { 'glm-5.2': { outputTokens: 40 }, 'deepseek-v4': { outputTokens: 20 } } }, { model: 'deepseek-v4', previousUsage: turn2 });
    // 失败的一轮没有输出:按输入增量认
    recordModelTurnStat({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', modelUsage: { 'glm-5.2': { outputTokens: 20, inputTokens: 1500 } } }, { model: 'default', previousUsage: turn1 });
    const rows = modelTurnStatsDb.summarize(7);
    assert.deepEqual(rows.map((row) => [row.model, row.turns, row.errors]).sort(), [['deepseek-v4', 1, 0], ['glm-5.2', 1, 1]]);
    assert.equal(turnModelFromUsage(turn2, turn2), null, '一个都没动 → 交给请求的模型名');
  });
});

describe('ho-1 显示日志:撤回的那一行标 withdrawn', () => {
  test('markWithdrawn 只改 payload,刷新后读得到', async () => {
    await freshDb();
    sessionsDb.createAppSession('s-w', 'claude', path.join(tempDir!, 'proj'), 1);
    sessionMessagesDb.append('s-w', { id: 'u-1', sessionId: 's-w', timestamp: new Date().toISOString(), provider: 'claude', kind: 'text', role: 'user', content: 'hi', turnUuid: 'x' } as never);
    assert.equal(sessionMessagesDb.markWithdrawn('s-w', 'u-1'), true);
    const [row] = sessionMessagesDb.listForSession('s-w') as Array<Record<string, unknown>>;
    assert.equal(row.withdrawn, true);
    assert.equal(row.content, 'hi');
    assert.equal(sessionMessagesDb.markWithdrawn('s-w', 'nope'), false);
  });
});

describe('子代理模型', () => {
  test('没设 → 不写任何变量(CLI 默认跟随主模型);设了目录模型 → 写;强制 → 再加 FORCE;下架 → 不写', async () => {
    await freshDb();
    assert.deepEqual(subagentModelEnv(), {});
    claudeModelCatalog.create({ modelId: 'glm-5.2', label: 'GLM 5.2' }, null);
    claudeModelCatalog.setSubagentPolicy({ model: 'glm-5.2', force: true });
    assert.deepEqual(subagentModelEnv(), { CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.2', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    claudeModelCatalog.setSubagentPolicy({ model: 'haiku' });
    assert.deepEqual(subagentModelEnv(), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
    assert.throws(() => claudeModelCatalog.setSubagentPolicy({ model: 'not-in-catalog' }), /不在模型目录里/);
    claudeModelCatalog.setSubagentPolicy({ model: 'glm-5.2' });
    const entry = claudeModelCatalog.lookup('glm-5.2')!;
    claudeModelCatalog.update(entry.id, { enabled: false }, null);
    assert.deepEqual(subagentModelEnv(), {}, '下架了就别让子代理打过去');
    // 坏数据按跟随主模型
    getConnection().prepare("UPDATE app_config SET value = '{oops' WHERE key = 'claude_subagent_model'").run();
    invalidateCatalogCache();
    assert.deepEqual(claudeModelCatalog.subagentPolicy(), { model: null, force: false });
  });
});


describe('ho 复审修正(服务端)', () => {
  test('进程没了:后台任务表清空并报空表;还排着的插话按"没执行"撤回;幂等', () => {
    const runtime = fakeRuntime({ liveBackgroundTasks: new Map([['t-1', { taskId: 't-1' }]]) });
    runtime.mergedUuids.set('m-9', { appSessionId: 'app-1', at: Date.now() });
    const tasks: unknown[] = [];
    const merged: unknown[] = [];
    setBackgroundTasksHook((event: unknown) => tasks.push(event));
    setMergedMessageHook((event: unknown) => merged.push(event));
    releaseRuntimeSideState(runtime, 'process_ended');
    releaseRuntimeSideState(runtime, 'process_ended');
    assert.deepEqual(tasks, [{ appSessionId: 'app-1', tasks: [], reason: 'process_ended' }]);
    assert.deepEqual(merged, [{ type: 'delivered', appSessionId: 'app-1', uuids: ['m-9'], reason: 'process_ended' }]);
    assert.equal(runtime.mergedUuids.size, 0);
  });

  test('源码:读循环结束的 finally 与 dispose 都走 releaseRuntimeSideState', async () => {
    const source = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    assert.match(source, /releaseRuntimeSideState\(runtime, 'process_ended'\);\n\s*runtime\.disposed = true;/);
    assert.match(source, /releaseRuntimeSideState\(runtime, 'disposed'\);/);
  });

  test('源码:只剩后台任务时释放给单独的原因;删除 / 接管 / 一次性调用各有说法', async () => {
    const sdk = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    assert.match(sdk, /reason: onlyBackground \? 'background_tasks' : 'turn_in_flight'/);
    const sessions = await readFile(path.join(here, '..', 'modules', 'providers', 'services', 'sessions.service.ts'), 'utf8');
    assert.match(sessions, /release\.reason === 'background_tasks'/);
    const shell = await readFile(path.join(here, '..', 'modules', 'websocket', 'services', 'shell-websocket.service.ts'), 'utf8');
    assert.match(shell, /released\.reason === 'background_tasks'/);
  });

  test('源码:文件撤销接口与预热 / 检查点还原同一套闸门,并落 files_reverted', async () => {
    const index = await readFile(path.join(here, '..', 'index.js'), 'utf8');
    const route = index.slice(index.indexOf("'/api/providers/:provider/sessions/:sessionId/runtime/rewind-files'"), index.indexOf('// Preview ticket endpoint'));
    assert.match(route, /if \(currentHolder\(session\.session_id\)\)/);
    assert.match(route, /isClaudeSDKSessionActive\(session\.provider_session_id\)/);
    assert.match(route, /findActiveRunForCwd\(session\.project_path\)/);
    assert.match(route, /kind: 'files_reverted'/);
  });

  test('源码:签名按实际写进 env 的子代理模型算;换模型且档位跟默认时不补发 effort:null', async () => {
    const source = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    assert.match(source, /const env = options\.subagentEnv \?\? subagentModelEnv\(\);\n\s*return env\.CLAUDE_CODE_SUBAGENT_MODEL/); // hq:按人按网关筛过的那份
    assert.match(source, /\(modelChanged && targetEffort !== null\)/);
  });
});


describe('ho 复审修正(二轮)', () => {
  test('停止前先撤插话:撤到的报 aborted,撤不到的留在账上', async () => {
    const runtime = fakeRuntime();
    runtime.mergedUuids.set('m-a', { appSessionId: 'app-1', at: Date.now() });
    runtime.mergedUuids.set('m-b', { appSessionId: 'app-1', at: Date.now() });
    const events: unknown[] = [];
    setMergedMessageHook((event: unknown) => events.push(event));
    const query = { cancelAsyncMessage: async (uuid: string) => uuid === 'm-a' };
    const withdrawn = await withdrawMergedBeforeInterrupt(runtime, query);
    assert.deepEqual(withdrawn, ['m-a']);
    assert.deepEqual(events, [{ type: 'withdrawn', appSessionId: 'app-1', uuids: ['m-a'], reason: 'aborted' }]);
    assert.equal(runtime.mergedUuids.has('m-b'), true);
  });

  test('插话在 Prism 的回合里被回显 = 折进去了;回合已结束才被读到 = 自己成了一轮(own_turn)', () => {
    const events: Array<Record<string, unknown>> = [];
    setMergedMessageHook((event: Record<string, unknown>) => events.push(event));
    const inTurn = fakeRuntime({ turn: { id: 't' } });
    inTurn.mergedUuids.set('m-1', { appSessionId: 'app-1', at: Date.now() });
    noteMergedDelivered(inTurn, { type: 'result', user_message_uuids: ['m-1'] });
    const afterTurn = fakeRuntime();
    afterTurn.mergedUuids.set('m-2', { appSessionId: 'app-1', at: Date.now() });
    noteMergedDelivered(afterTurn, { type: 'command_lifecycle', state: 'started', command_uuid: 'm-2' });
    assert.deepEqual(events.map((event) => [event.uuids, event.reason]), [[['m-1'], null], [['m-2'], 'own_turn']]);
  });

});

describe('ho:settings.json 不是合法 JSON 时说清楚(用户抄了带 // 注释的片段)', () => {
  test('带 // 注释:指出注释;URL 里的 // 不算注释', async () => {
    const { describeSettingsParseError, readClaudeSettingsParseProblem } = await import('../modules/providers/list/claude/claude-settings-selfcheck.js');
    const jsonc = '{\n  "cleanupPeriodDays": 3650,   // 保留期\n  "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com" }\n}';
    let parseError: unknown;
    try { JSON.parse(jsonc); } catch (error) { parseError = error; }
    const message = describeSettingsParseError(jsonc, parseError);
    assert.match(message, /CLI 会整份忽略它/);
    assert.match(message, /文件里有 \/\/ 注释/);
    const strictButBroken = '{ "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com" }, }';
    try { JSON.parse(strictButBroken); } catch (error) { parseError = error; }
    assert.doesNotMatch(describeSettingsParseError(strictButBroken, parseError), /文件里有 \/\/ 注释/);

    tempDir = await mkdtemp(path.join(tmpdir(), 'ho-settings-'));
    const file = path.join(tempDir, 'settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, jsonc);
    assert.match((await readClaudeSettingsParseProblem(file)) ?? '', /不是合法 JSON/);
    await writeFile(file, '{"cleanupPeriodDays": 3650}');
    assert.equal(await readClaudeSettingsParseProblem(file), null);
    assert.equal(await readClaudeSettingsParseProblem(path.join(tempDir, 'missing.json')), null);
  });
});

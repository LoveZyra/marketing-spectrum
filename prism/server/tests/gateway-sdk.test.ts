import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, test, vi } from 'vitest';

/**
 * 模型网关在 claude-sdk 一侧的接线:补丁并进 flag 层(不丢压缩 / 跨会话旋钮)、认出这一轮是谁、
 * 常驻 runtime 的签名带网关指纹。换 key / 换网关要重建;网关 0 上换模型就地 setModel,别的网关上别名映射
 * 钉在模型上,换模型也要重建(后台任务在跑时改为就地换);后台任务在跑时拒绝换 key / 换网关(GATEWAY_SWITCH_BLOCKED)。
 *
 * SDK 的 `query` 换成脚本(同 compaction-lifecycle.test.js),不起子进程、不花钱。
 */

type QueryCall = { options: Record<string, any>; settingsContent?: Record<string, any> | null };
const calls: QueryCall[] = [];
let script: Array<Record<string, unknown>> = [];
let stopTaskImpl: (taskId: string) => Promise<void> = async () => {};
const flagSettingsApplied: Array<Record<string, unknown>> = [];
let applyFlagSettingsImpl: (value: Record<string, unknown>) => Promise<void> = async (value) => { flagSettingsApplied.push(value); };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    // 带 key 的 flag 设置是文件 —— 起进程的那一刻读下来(一次性回合结束后文件就删了)
    let settingsContent: Record<string, any> | null = null;
    if (typeof options.settings === 'string') {
      const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      settingsContent = JSON.parse(nodeFs.readFileSync(options.settings as string, 'utf8'));
    }
    calls.push({ options, settingsContent });
    return {
      async *[Symbol.asyncIterator]() {
        // 每收到一条用户输入,吐一遍当时的脚本
        for await (const _message of prompt) {
          void _message;
          for (const frame of script) yield frame;
        }
      },
      interrupt: async () => {},
      close: () => {},
      getContextUsage: async () => null,
      setPermissionMode: async () => {},
      setModel: async () => {},
      // 与真 CLI 一致:任务早没了也回成功;个别用例换成抛错
      stopTask: async (taskId: string) => stopTaskImpl(taskId),
      applyFlagSettings: async (value: Record<string, unknown>) => applyFlagSettingsImpl(value),
      supportedCommands: async () => [],
    };
  },
}));

const sdk = await import('../claude-sdk.js');
const { applyGatewaySettings, queryClaudeSDK, disposeAllRuntimes, getPersistentRuntime } = sdk;
// claude-sdk.js 是 JS,推出来的参数 / 返回类型太窄,这里放宽
type SdkOptionsShape = { settings: Record<string, any>; env: Record<string, string> };
const mapCliOptionsToSDK = sdk.mapCliOptionsToSDK as unknown as (options: Record<string, unknown>) => SdkOptionsShape;
const turnViewer = sdk.turnViewer as unknown as (options: Record<string, unknown>, ws?: { userId: number } | null) => { userId: number | null; isRoot: boolean };
const db = await import('@/modules/database/index.js');
const gateways = await import('@/modules/providers/list/claude/claude-gateways.service.js');
const catalog = await import('@/modules/providers/list/claude/claude-model-catalog.service.js');
const crypto = await import('@/shared/crypto-box.js');

const ENV_KEYS = [
  'DATABASE_PATH', 'HOME', 'PRISM_ROOT_USERS', 'PRISM_ENCRYPTION_KEY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDir = mkdtempSync(path.join(tmpdir(), 'hq-gw-sdk-'));
const cwd = mkdtempSync(path.join(tmpdir(), 'hq-gw-sdk-cwd-'));
let users: { alice: number; bob: number; boss: number };

beforeAll(async () => {
  db.closeConnection();
  crypto.resetEncryptionKey();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.HOME = tempDir;
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_ENCRYPTION_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  await mkdir(path.join(tempDir, '.claude'), { recursive: true });
  await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
  }));
  await db.initializeDatabase();
  catalog.invalidateCatalogCache();
  const id = (name: string) => Number(db.userDb.createUser(name, 'hash').id);
  users = { alice: id('alice'), bob: id('bob'), boss: id('boss') };
});

afterAll(async () => {
  await disposeAllRuntimes();
  db.closeConnection();
  crypto.resetEncryptionKey();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(tempDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/* ================================================================== */

/** 带 key 的 flag 设置写成 0600 文件,options.settings 只给路径(key 不进 CLI 命令行)。读回来比内容。 */
const readFlagSettings = (value: unknown): Record<string, any> => {
  assert.equal(typeof value, 'string', 'options.settings 应该是文件路径');
  const file = value as string;
  assert.equal(statSync(file).mode & 0o777, 0o600, 'flag 设置文件是 0600');
  return JSON.parse(readFileSync(file, 'utf8'));
};

describe('hq applyGatewaySettings', () => {
  const patch = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-new', ANTHROPIC_API_KEY: '' }, apiKeyHelper: '' };

  test('没有补丁(网关 0 没有个人 key)→ 原样不动,不写文件', () => {
    const settings = { crossSessionInbound: 'refuse' };
    const options: Record<string, unknown> = { settings };
    assert.equal(applyGatewaySettings(options, null), null);
    assert.equal(options.settings, settings);
    applyGatewaySettings(options, { settingsPatch: null });
    assert.deepEqual(options.settings, { crossSessionInbound: 'refuse' });
    const bare: Record<string, unknown> = {};
    applyGatewaySettings(bare, undefined);
    assert.equal('settings' in bare, false);
  });

  test('并进已有的 flag 设置:压缩 / 跨会话旋钮保留,env 逐键合并(补丁优先),apiKeyHelper 写空串;整份进 0600 文件', () => {
    const options: Record<string, unknown> = {
      settings: { autoCompactWindow: 120000, autoCompactEnabled: false, crossSessionInbound: 'refuse', env: { KEEP_ME: '1', ANTHROPIC_AUTH_TOKEN: 'old' } },
    };
    const file = applyGatewaySettings(options, { settingsPatch: patch });
    assert.equal(options.settings, file);
    assert.equal(String(options.settings).includes('sk-new'), false, '路径里没有 key');
    assert.deepEqual(readFlagSettings(options.settings), {
      autoCompactWindow: 120000,
      autoCompactEnabled: false,
      crossSessionInbound: 'refuse',
      apiKeyHelper: '',
      env: { KEEP_ME: '1', ANTHROPIC_AUTH_TOKEN: 'sk-new', ANTHROPIC_API_KEY: '' },
    });
    const empty: Record<string, unknown> = {};
    applyGatewaySettings(empty, { settingsPatch: patch });
    assert.deepEqual(readFlagSettings(empty.settings), { apiKeyHelper: '', env: patch.env });
    for (const written of [file, empty.settings as string]) {
      sdk.removeFlagSettingsFileForTest(written);
      assert.equal(existsSync(written), false);
    }
  });

  test('settings 是路径字符串 → 抛错(带 prismModelRejected),不静默用错网关', () => {
    assert.throws(() => applyGatewaySettings({ settings: '/tmp/settings.json' }, { settingsPatch: patch }), (error: unknown) => (error as { prismModelRejected?: boolean }).prismModelRejected === true);
  });

  test('一次性路径(mapCliOptionsToSDK):补丁进 options.settings,与 crossSessionInbound 并存;key 不进子进程的进程环境', () => {
    const gateway = gateways.buildGatewaySettingsPatch({ gatewayId: 3, baseUrl: 'https://g.example.com', authType: 'x-api-key', key: 'sk-oneshot-key', model: 'kimi-k2' });
    const sdkOptions = mapCliOptionsToSDK({ cwd, model: 'kimi-k2', gateway: { settingsPatch: gateway, fingerprint: 'f' } });
    const written = readFlagSettings(sdkOptions.settings);
    assert.equal(written.crossSessionInbound, 'refuse');
    assert.equal(written.apiKeyHelper, '');
    assert.equal(written.env.ANTHROPIC_API_KEY, 'sk-oneshot-key');
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, '');
    assert.equal(written.env.ANTHROPIC_CUSTOM_HEADERS, '');
    assert.equal(written.env.ANTHROPIC_BASE_URL, 'https://g.example.com');
    assert.equal(JSON.stringify(sdkOptions.env).includes('sk-oneshot-key'), false, 'key 只走 flag 层,不进 options.env');
    assert.equal(JSON.stringify(sdkOptions).includes('sk-oneshot-key'), false, 'key 不在 SDK 选项里(不会进 CLI 命令行)');
    // 一次性路径拿走文件、回合结束删
    const file = sdk.takeFlagSettingsFile(sdkOptions);
    assert.equal(file, sdkOptions.settings);
    assert.equal(sdk.takeFlagSettingsFile(sdkOptions), null, '拿走即解除登记');
    sdk.removeFlagSettingsFileForTest(file);
    const noGateway = mapCliOptionsToSDK({ cwd });
    assert.equal('apiKeyHelper' in noGateway.settings, false);
    assert.equal('env' in noGateway.settings, false);
  });
});

describe('hq 任务清单引导(系统提示追加)', () => {
  const presetSystemPrompt = sdk.presetSystemPrompt as unknown as (env?: Record<string, string | undefined>) => { type: string; preset: string; append?: string };
  test('默认追加「开工先列全任务清单」,PRISM_TASKLIST_GUIDANCE=0 关掉;一次性路径用的就是它', () => {
    const on = presetSystemPrompt({});
    assert.equal(on.preset, 'claude_code');
    assert.equal(on.append, sdk.TASKLIST_GUIDANCE);
    assert.match(String(on.append), /TaskCreate/);
    assert.equal('append' in presetSystemPrompt({ PRISM_TASKLIST_GUIDANCE: '0' }), false);
    const sdkOptions = mapCliOptionsToSDK({ cwd }) as unknown as { systemPrompt: { append?: string } };
    assert.equal(sdkOptions.systemPrompt.append, sdk.TASKLIST_GUIDANCE);
  });
});

describe('hq turnViewer', () => {
  test('actorUserId > ownerUserId > ws.userId;非正数忽略;root 按用户名判', () => {
    assert.deepEqual(turnViewer({ actorUserId: users.alice, ownerUserId: users.bob }, { userId: users.boss }), { userId: users.alice, isRoot: false });
    assert.deepEqual(turnViewer({ ownerUserId: users.bob }, { userId: users.boss }), { userId: users.bob, isRoot: false });
    assert.deepEqual(turnViewer({ actorUserId: 0 }, { userId: users.boss }), { userId: users.boss, isRoot: true }, '没给名字时按 id 查库判 root');
    assert.deepEqual(turnViewer({ actorUserId: users.boss, actorUsername: 'boss' }), { userId: users.boss, isRoot: true });
    assert.deepEqual(turnViewer({}, null), { userId: null, isRoot: false });
  });
});

/* ================================================================== */

describe('hq 常驻 runtime:网关指纹进签名', () => {
  const SESSION = 'bbbbbbbb-0000-4000-8000-000000000001';
  const frames = (extra: Array<Record<string, unknown>> = []) => [
    { type: 'system', subtype: 'init', session_id: SESSION },
    ...extra.map((frame) => ({ session_id: SESSION, ...frame })),
    { type: 'assistant', session_id: SESSION, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: SESSION },
  ];
  const writer = (userId: number) => {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, userId, send: (frame: Record<string, unknown>) => { sent.push(frame); }, setSessionId: () => {} };
  };
  const turn = async (who: 'alice' | 'bob', options: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) => {
    script = frames(extra);
    const ws = writer(users[who]);
    await queryClaudeSDK('hi', {
      cwd, projectPath: cwd, runId: `run-${Math.random()}`, permissionMode: 'default',
      actorUserId: users[who], actorUsername: who, model: 'sonnet', ...options,
    }, ws);
    return ws.sent;
  };
  const errors = (sent: Array<Record<string, unknown>>) => sent.filter((frame) => frame.kind === 'error').map((frame) => String(frame.content));

  test('换 key → 重建(新进程拿到新 key);同网关换模型 → 不重建;后台任务在跑时换 key → GATEWAY_SWITCH_BLOCKED;换人 → 各用各的', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    // 1) 网关 0、没有个人 key:不传任何网关设置
    const first = await turn('alice', { sessionId: undefined });
    assert.deepEqual(errors(first), []);
    assert.equal(calls.length, 1);
    assert.equal('apiKeyHelper' in (calls[0].options.settings ?? {}), false);
    const runtime = getPersistentRuntime(SESSION);
    assert.ok(runtime, 'runtime 按 session id 记下了');

    // 2) alice 填了个人 key → 指纹变 → 重建,新进程的 flag 层带着她的 key
    gateways.setPersonalKey(0, users.alice, 'sk-alice-zero-1', users.alice);
    assert.deepEqual(errors(await turn('alice', { sessionId: SESSION })), []);
    assert.equal(calls.length, 2, '换 key = 重建');
    const rebuilt = calls[1].options;
    // 带 key 的 flag 设置是 0600 文件(命令行里只有路径)
    const rebuiltSettings = readFlagSettings(rebuilt.settings);
    assert.equal(JSON.stringify(rebuilt).includes('sk-alice-zero-1'), false, 'key 不在 SDK 选项里(不进 CLI 命令行)');
    assert.equal(rebuiltSettings.env.ANTHROPIC_AUTH_TOKEN, 'sk-alice-zero-1');
    assert.equal(rebuiltSettings.env.ANTHROPIC_API_KEY, '');
    assert.equal(rebuiltSettings.apiKeyHelper, '');
    assert.equal(rebuiltSettings.crossSessionInbound, 'refuse', '压缩 / 跨会话旋钮还在');
    assert.equal(rebuilt.resume, SESSION, '重建 = resume 同一段对话');
    assert.equal(JSON.stringify(rebuilt.env).includes('sk-alice-zero-1'), false);
    const second = getPersistentRuntime(SESSION);
    assert.notEqual(second, runtime);

    // 3) 同一把 key、同一个网关,换模型:不重建(setModel 就地换)
    assert.deepEqual(errors(await turn('alice', { sessionId: SESSION, model: 'opus' })), []);
    assert.equal(calls.length, 2, '指纹不随模型变');
    assert.equal(getPersistentRuntime(SESSION), second);

    // 4) 这一轮起了一个后台任务(还没结束)
    assert.deepEqual(errors(await turn('alice', { sessionId: SESSION, model: 'opus' }, [
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: '后台子代理' }] },
    ])), []);
    assert.equal(second?.liveBackgroundTasks?.size, 1);

    // 5) 换 key:后台任务还在 → 拒这一条,不重建、不杀进程
    gateways.setPersonalKey(0, users.alice, 'sk-alice-zero-2', users.alice);
    const blocked = await turn('alice', { sessionId: SESSION, model: 'opus' });
    assert.equal(errors(blocked).length, 1, JSON.stringify(blocked));
    assert.match(errors(blocked)[0], /后台任务/);
    assert.equal(calls.length, 2);
    assert.equal(getPersistentRuntime(SESSION), second);
    assert.equal(second?.disposed, false);
    // 共享会话里换一个人(用 settings.json 那一套,指纹不同)同样被挡
    const bobBlocked = await turn('bob', { sessionId: SESSION });
    assert.match(errors(bobBlocked)[0] ?? '', /后台任务/);
    assert.equal(calls.length, 2);

    // 6) key 换回来 → 指纹一致 → 照常复用
    gateways.setPersonalKey(0, users.alice, 'sk-alice-zero-1', users.alice);
    assert.deepEqual(errors(await turn('alice', { sessionId: SESSION, model: 'opus' })), []);
    assert.equal(calls.length, 2);

    // 7) 后台任务结束 → bob 发:重建,bob 的进程不带 alice 的 key
    assert.deepEqual(errors(await turn('alice', { sessionId: SESSION, model: 'opus' }, [
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ])), []);
    assert.equal(second?.liveBackgroundTasks?.size, 0);
    assert.deepEqual(errors(await turn('bob', { sessionId: SESSION })), []);
    assert.equal(calls.length, 3, '换人(各用各的 key)= 重建');
    assert.equal(existsSync(rebuilt.settings), false, '旧进程收尾时它的 flag 设置文件删掉了');
    assert.equal(JSON.stringify(calls[2].options.settings ?? {}).includes('sk-alice-zero'), false, 'bob 的进程里不能有 alice 的 key');
    assert.equal('apiKeyHelper' in (calls[2].options.settings ?? {}), false, 'bob 没有个人 key:走 settings.json');

    // 整个过程的日志里没有任何一把 key(网关解析只记来源)
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    assert.equal(logged.includes('sk-alice-zero'), false);
    assert.match(logged, /key 来源 personal/);
    for (const spy of spies) spy.mockRestore();
  });
});

describe('hq 子进程环境清洗的依赖自检', () => {
  test('没开不查;开了缺 bwrap / socat → error 级说明;都在 → 无', async () => {
    const { checkSubprocessScrubDeps } = await import('@/modules/providers/list/claude/claude-settings-selfcheck.js');
    assert.equal(checkSubprocessScrubDeps({}, () => false), null);
    const missing = checkSubprocessScrubDeps({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, (bin) => bin === 'bwrap');
    assert.equal(missing?.level, 'error');
    assert.match(String(missing?.message), /socat/);
    assert.doesNotMatch(String(missing?.message), /bwrap \//);
    assert.equal(checkSubprocessScrubDeps({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, () => true), null);
  });
});

describe('别名与子代理模型的限人校验', () => {
  test('别名映射到限人的目录模型 → 不在名单里的人用别名也发不出', async () => {
    // settings.json 里 opus → team-only(这个测试文件的 settings 没有映射,临时写一份)
    await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: 'settings-token', ANTHROPIC_DEFAULT_OPUS_MODEL: 'team-only' },
    }));
    const entry = catalog.claudeModelCatalog.create({ modelId: 'team-only', allowedUsers: [users.alice] }, users.boss);
    try {
      const sentBy = async (who: 'alice' | 'bob') => {
        const ws = { userId: users[who], sent: [] as Array<Record<string, unknown>>, send(frame: Record<string, unknown>) { this.sent.push(frame); } };
        const before = calls.length;
        await queryClaudeSDK('hi', { cwd, projectPath: cwd, permissionMode: 'default', actorUserId: users[who], actorUsername: who, model: 'opus', oneShot: true }, ws);
        return { errors: ws.sent.filter((f) => f.kind === 'error').map((f) => String(f.content)), spawned: calls.length - before };
      };
      const bob = await sentBy('bob');
      assert.equal(bob.spawned, 0, 'bob 用别名也起不了进程');
      assert.match(bob.errors[0] ?? '', /不在模型目录里|可用人员|不能用|opus/);
      const alice = await sentBy('alice');
      assert.equal(alice.spawned, 1);
    } finally {
      catalog.claudeModelCatalog.remove(entry.id);
      await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
      }));
    }
  });

  test('别的网关上,子代理模型两个变量进 flag 层(没设 = 空串,压过 settings.json 里可能写着的)', async () => {
    const g = gateways.createSharedGateway({ name: 'G-sub', baseUrl: 'https://g-sub.example.com', authType: 'bearer', defaultKey: 'sk-g-sub' }, users.boss);
    const entry = catalog.claudeModelCatalog.create({ modelId: 'g-sub-model', gatewayId: g.id }, users.boss);
    try {
      const ws = { userId: users.alice, sent: [] as Array<Record<string, unknown>>, send(frame: Record<string, unknown>) { this.sent.push(frame); } };
      const before = calls.length;
      await queryClaudeSDK('hi', { cwd, projectPath: cwd, permissionMode: 'default', actorUserId: users.alice, actorUsername: 'alice', model: 'g-sub-model', oneShot: true }, ws);
      assert.equal(calls.length, before + 1);
      const options = calls[calls.length - 1].options;
      assert.equal(typeof options.settings, 'string', '带 key → 文件路径');
      // 一次性回合已经结束 → 文件已删,读不到;所以查 SDK 选项里没有 key、回合没报错,内容看 mock 起进程时读下的那份
      assert.equal(existsSync(options.settings), false, '一次性回合结束后 flag 设置文件删掉了');
      assert.equal(JSON.stringify(options).includes('sk-g-sub'), false);
      assert.deepEqual(ws.sent.filter((f) => f.kind === 'error'), []);
      const written = calls[calls.length - 1].settingsContent;
      assert.equal(written?.env.ANTHROPIC_AUTH_TOKEN, 'sk-g-sub');
      assert.equal(written?.env.CLAUDE_CODE_SUBAGENT_MODEL, '');
      assert.equal(written?.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '');
    } finally {
      catalog.claudeModelCatalog.remove(entry.id);
      gateways.deleteSharedGateway(g.id);
    }
  });
});


describe('后台任务在跑时换模型、启动清扫与可用性判断', () => {
  const SESSION2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  const frames2 = (extra: Array<Record<string, unknown>> = []) => [
    { type: 'system', subtype: 'init', session_id: SESSION2 },
    ...extra.map((frame) => ({ session_id: SESSION2, ...frame })),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION2, usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const send = async (who: 'alice' | 'bob', model: string, extra: Array<Record<string, unknown>> = []) => {
    script = frames2(extra);
    const ws = { userId: users[who], sent: [] as Array<Record<string, unknown>>, send(frame: Record<string, unknown>) { this.sent.push(frame); } };
    await queryClaudeSDK('hi', {
      cwd, projectPath: cwd, runId: `run-${Math.random()}`, permissionMode: 'default', sessionId: SESSION2,
      actorUserId: users[who], actorUsername: who, model,
    }, ws);
    return ws.sent.filter((frame) => frame.kind === 'error').map((frame) => String(frame.content));
  };

  test('别的网关上,后台任务在跑时同网关换模型 → 不重建、不拒(就地 setModel);换 key 才拒', async () => {
    const g = gateways.createSharedGateway({ name: 'G-two', baseUrl: 'https://g-two.example.com', authType: 'bearer', defaultKey: 'sk-g-two' }, users.boss);
    const m1 = catalog.claudeModelCatalog.create({ modelId: 'g-two-a', gatewayId: g.id }, users.boss);
    const m2 = catalog.claudeModelCatalog.create({ modelId: 'g-two-b', gatewayId: g.id }, users.boss);
    try {
      assert.deepEqual(await send('alice', 'g-two-a'), []);
      const first = getPersistentRuntime(SESSION2);
      const before = calls.length;
      // 没有后台任务:同网关换模型 = 重建(别名映射钉在模型上)
      assert.deepEqual(await send('alice', 'g-two-b'), []);
      assert.equal(calls.length, before + 1);
      const second = getPersistentRuntime(SESSION2);
      assert.notEqual(second, first);
      // 起一个后台任务,再换回 a:不重建、不报错
      assert.deepEqual(await send('alice', 'g-two-b', [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-2', task_type: 'local_agent', description: '后台' }] },
      ]), []);
      assert.deepEqual(await send('alice', 'g-two-a'), []);
      assert.equal(calls.length, before + 1, '后台任务在跑:只换模型不重建');
      assert.equal(getPersistentRuntime(SESSION2), second);
      // 换 key(alice 在 G-two 上填了个人 key)→ 后台任务在跑,拒
      gateways.setPersonalKey(g.id, users.alice, 'sk-alice-g-two', users.alice);
      const blocked = await send('alice', 'g-two-a');
      assert.match(blocked[0] ?? '', /后台任务/);
      assert.equal(calls.length, before + 1);
    } finally {
      gateways.clearPersonalKey(g.id, users.alice);
      await disposeAllRuntimes();
      catalog.claudeModelCatalog.remove(m1.id);
      catalog.claudeModelCatalog.remove(m2.id);
      gateways.deleteSharedGateway(g.id);
    }
  });

  test('后台任务在跑时,共享会话里别人换模型 —— 起进程时钉的模型他不能用 → 拒,不就地换', async () => {
    const g = gateways.createSharedGateway({ name: 'G-three', baseUrl: 'https://g-three.example.com', authType: 'bearer', defaultKey: 'sk-g-three' }, users.boss);
    const mine = catalog.claudeModelCatalog.create({ modelId: 'g-three-alice', gatewayId: g.id, allowedUsers: [users.alice] }, users.boss);
    const open = catalog.claudeModelCatalog.create({ modelId: 'g-three-open', gatewayId: g.id }, users.boss);
    try {
      assert.deepEqual(await send('alice', 'g-three-alice', [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-3', task_type: 'local_agent', description: '后台' }] },
      ]), []);
      const before = calls.length;
      const blocked = await send('bob', 'g-three-open');
      assert.match(blocked[0] ?? '', /后台任务/);
      assert.equal(calls.length, before, '没有重建');
      assert.equal(getPersistentRuntime(SESSION2)?.disposed, false, '后台任务没被停掉');
    } finally {
      await disposeAllRuntimes();
      catalog.claudeModelCatalog.remove(mine.id);
      catalog.claudeModelCatalog.remove(open.id);
      gateways.deleteSharedGateway(g.id);
    }
  });

  test('启动清扫按"本进程的随机前缀"认,别的(含同 pid 的上一次)一律删', async () => {
    const files = await import('@/modules/providers/list/claude/claude-flag-settings-file.js');
    const mine = files.writeFlagSettingsFile({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-mine' } });
    const dir = path.dirname(mine);
    const stale = path.join(dir, `${process.pid}-leftover.json`);
    await writeFile(stale, '{}');
    assert.equal(files.sweepStaleFlagSettingsFiles() >= 1, true);
    assert.equal(existsSync(stale), false, '上一次(哪怕 pid 相同)留下的删了');
    assert.equal(existsSync(mine), true, '本进程的留着');
    files.removeFlagSettingsFile(mine);
  });

  test('isUsable / assertUsable —— 别名映射到限人模型时,不在名单里的人不能用', async () => {
    await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: 'settings-token', ANTHROPIC_DEFAULT_SONNET_MODEL: 'team-two' },
    }));
    const entry = catalog.claudeModelCatalog.create({ modelId: 'team-two', allowedUsers: [users.alice] }, users.boss);
    try {
      const v = (id: number) => ({ userId: id, isRoot: false });
      assert.equal(await catalog.claudeModelCatalog.isUsable('sonnet', v(users.alice)), true);
      assert.equal(await catalog.claudeModelCatalog.isUsable('sonnet', v(users.bob)), false);
      assert.equal(catalog.claudeModelCatalog.isAllowed('sonnet', v(users.bob)), true, '同步的 isAllowed 仍对别名放行(只做前置检查)');
      await assert.rejects(catalog.claudeModelCatalog.assertUsable('sonnet', v(users.bob)), /可用人员/);
      assert.equal(await catalog.claudeModelCatalog.isUsable('sonnet', { userId: users.bob, isRoot: true }), true, 'root 不受限');
    } finally {
      catalog.claudeModelCatalog.remove(entry.id);
      await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
      }));
    }
  });
});


describe('切回默认模型与签名变化说明', () => {
  const SESSION4 = 'bbbbbbbb-0000-4000-8000-000000000004';
  const frames4 = (extra: Array<Record<string, unknown>> = []) => [
    { type: 'system', subtype: 'init', session_id: SESSION4 },
    ...extra.map((frame) => ({ session_id: SESSION4, ...frame })),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION4, usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const send4 = async (model: string, extra: Array<Record<string, unknown>> = []) => {
    script = frames4(extra);
    const ws = { userId: users.alice, sent: [] as Array<Record<string, unknown>>, send(frame: Record<string, unknown>) { this.sent.push(frame); } };
    await queryClaudeSDK('hi', {
      cwd, projectPath: cwd, runId: `run-${Math.random()}`, permissionMode: 'default', sessionId: SESSION4,
      actorUserId: users.alice, actorUsername: 'alice', model,
    }, ws);
    return ws.sent.filter((frame) => frame.kind === 'error').map((frame) => String(frame.content));
  };

  test('后台任务在跑时切回「默认」模型 → 拒(说清楚),不悄悄重建;CLI 说任务已不在 → 从账上划掉,之后照常重建', async () => {
    try {
      assert.deepEqual(await send4('sonnet', [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-gone', task_type: 'local_bash', description: 'dev server' }] },
      ]), []);
      const runtime = getPersistentRuntime(SESSION4);
      const before = calls.length;
      const refused = await send4('default');
      assert.match(refused[0] ?? '', /后台任务/);
      assert.match(refused[0] ?? '', /切回「默认」模型/);
      assert.equal(calls.length, before);
      assert.equal(runtime?.disposed, false);
      // 停掉那个任务:真 CLI 对已经没了的任务也回成功 → 当场划掉
      const stopped = await sdk.stopClaudeBackgroundTask(SESSION4, 'bg-gone');
      assert.equal(stopped.stopped, true);
      assert.equal(runtime?.liveBackgroundTasks?.size, 0);
      // 现在切回默认 = 正常重建
      assert.deepEqual(await send4('default'), []);
      assert.equal(calls.length, before + 1);
    } finally {
      await disposeAllRuntimes();
    }
  });

  test('describeSignatureChange:说出是哪项改了', () => {
    const base = { cwd: '/p', bypass: false, allowedTools: [], disallowedTools: [], contextWindow: null, subagent: null, gateway: null };
    const describe = sdk.describeSignatureChange as unknown as (a: string, b: string) => string;
    assert.match(describe(JSON.stringify(base), JSON.stringify({ ...base, contextWindow: 128000 })), /模型窗口/);
    assert.match(describe(JSON.stringify(base), JSON.stringify({ ...base, allowedTools: ['Read'] })), /工具权限/);
    assert.equal(describe(JSON.stringify(base), JSON.stringify(base)), '这次的改动');
    assert.equal(describe('not json', '{}'), '这次的改动');
  });
});

describe('后台任务账目、settings.json 变更与被拒消息的归属', () => {
  const SESSION5 = 'bbbbbbbb-0000-4000-8000-000000000005';
  const BG = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'dev server' }] };
  const frames5 = (extra: Array<Record<string, unknown>> = []) => [
    { type: 'system', subtype: 'init', session_id: SESSION5 },
    ...extra.map((frame) => ({ session_id: SESSION5, ...frame })),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION5, usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const send5 = async (model: string, extra: Array<Record<string, unknown>> = [], who: 'alice' | 'bob' = 'alice', more: Record<string, unknown> = {}) => {
    script = frames5(extra);
    const ws = { userId: users[who], sent: [] as Array<Record<string, unknown>>, send(frame: Record<string, unknown>) { this.sent.push(frame); } };
    await queryClaudeSDK('hi', {
      cwd, projectPath: cwd, runId: `run-${Math.random()}`, permissionMode: 'default', sessionId: SESSION5,
      actorUserId: users[who], actorUsername: who, model, ...more,
    }, ws);
    return ws.sent.filter((frame) => frame.kind === 'error').map((frame) => String(frame.content));
  };
  const resetMocks = () => {
    stopTaskImpl = async () => {};
    applyFlagSettingsImpl = async (value) => { flagSettingsApplied.push(value); };
  };

  test('stopTask:CLI 抛 "No task found" → 划掉;抛 "not running (status: pending)" / 别的错 → 留着(可能还活着)', async () => {
    try {
      assert.deepEqual(await send5('sonnet', [BG]), []);
      const runtime = getPersistentRuntime(SESSION5);
      stopTaskImpl = async () => { throw new Error('Task bg-1 is not running (status: pending)'); };
      assert.equal((await sdk.stopClaudeBackgroundTask(SESSION5, 'bg-1')).stopped, false);
      stopTaskImpl = async () => { throw new Error('Unknown error'); };
      assert.equal((await sdk.stopClaudeBackgroundTask(SESSION5, 'bg-1')).stopped, false);
      assert.equal(runtime?.liveBackgroundTasks?.size, 1);
      stopTaskImpl = async () => { throw new Error('No task found with ID: bg-1'); };
      const gone = await sdk.stopClaudeBackgroundTask(SESSION5, 'bg-1');
      assert.equal(gone.stopped, true);
      assert.equal(gone.reason, 'already_gone');
      assert.equal(runtime?.liveBackgroundTasks?.size, 0);
    } finally {
      resetMocks();
      await disposeAllRuntimes();
    }
  });

  test('后台任务 / CLI 自己的一轮在跑时 settings.json 变了 → 不拒、不重建(沿用老进程);都完了的下一条再重建', async () => {
    // settings.json 的路径在模块加载时按真 HOME 定死了 —— 直接钉探针模拟"管理员改了它"
    const prime = sdk.primeSettingsMtimeForTest as unknown as (mtimeMs: number | null) => void;
    try {
      assert.deepEqual(await send5('sonnet', [BG]), []);
      const runtime = getPersistentRuntime(SESSION5);
      assert.ok(runtime && runtime.userSettingsMtimeMs !== undefined);
      const before = calls.length;
      const changed = Number(runtime.userSettingsMtimeMs) + 60_000;
      // 探针有 3 秒节流 —— 每一条前都重新钉一下,慢机器上也不会回去读真文件
      prime(changed);
      assert.deepEqual(await send5('sonnet'), []);
      assert.equal(calls.length, before, '后台任务在跑:不重建');
      assert.equal(getPersistentRuntime(SESSION5), runtime);
      // 后台任务跑完(CLI 发来空表)
      prime(changed);
      assert.deepEqual(await send5('sonnet', [{ type: 'system', subtype: 'background_tasks_changed', tasks: [] }]), []);
      assert.equal(calls.length, before);
      // CLI 正在跑它自己那一轮(汇报后台结果)—— 也先不重建
      runtime.orphanTurnOpen = true;
      prime(changed);
      assert.deepEqual(await send5('sonnet'), []);
      assert.equal(calls.length, before, 'CLI 自己的一轮在跑:不重建');
      // 那一轮的 result 到了就清掉(别手动清 —— 那样会盖住"标记卡住"的 bug)
      assert.equal(runtime.orphanTurnOpen, false);
      // 下一条:按新的 settings.json 重建
      prime(changed);
      assert.deepEqual(await send5('sonnet'), []);
      assert.equal(calls.length, before + 1);
      assert.equal(runtime?.disposed, true);
    } finally {
      prime(null);
      resetMocks();
      await disposeAllRuntimes();
    }
  });

  test('被拒的一条不改 runtime 的归属(appSessionId);就地改档位失败被拒后,下一条照样补发档位', async () => {
    // 同一个人发(换人的话前面用例给过个人 key,会先撞上 GATEWAY_SWITCH_BLOCKED)
    try {
      // 同一档位、换模型:setModel 成功 → 补发档位失败 → 拒;此时模型已经换过去了
      assert.deepEqual(await send5('sonnet', [BG], 'alice', { effort: 'high' }), []);
      const runtime = getPersistentRuntime(SESSION5);
      assert.ok(runtime);
      const appSessionBefore = runtime.appSessionId;
      assert.ok(appSessionBefore);
      applyFlagSettingsImpl = async () => { throw new Error('control request timed out'); };
      const refused = await send5('opus', [], 'alice', { effort: 'high' });
      assert.match(refused[0] ?? '', /改推理档位没成功/);
      assert.equal(runtime.disposed, false);
      assert.equal(runtime.appSessionId, appSessionBefore, '被拒的这一条不接手归属');
      // 恢复正常:同样的档位再发一次 —— 记号是"不确定",一定补发
      resetMocks();
      flagSettingsApplied.length = 0;
      assert.deepEqual(await send5('opus', [], 'alice', { effort: 'high' }), []);
      assert.ok(flagSettingsApplied.some((value) => 'effortLevel' in value), '档位补发了');
      assert.notEqual(runtime.appSessionId, appSessionBefore);
    } finally {
      resetMocks();
      await disposeAllRuntimes();
    }
  });
});

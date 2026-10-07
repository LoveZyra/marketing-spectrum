import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, test, vi } from 'vitest';

import {
  closeConnection,
  gatewayUserKeysDb,
  getConnection,
  initializeDatabase,
  modelCatalogDb,
  modelGatewaysDb,
  userDb,
  userModelsDb,
} from '@/modules/database/index.js';
import {
  GatewayError,
  buildGatewaySettingsPatch,
  clearPersonalKey,
  createMyModel,
  createPrivateGateway,
  createSharedGateway,
  deletePrivateGateway,
  deleteSharedGateway,
  gatewayFingerprint,
  normalizeBaseUrl,
  normalizeKey,
  resolveTurnGateway,
  setPersonalKey,
  setPrivateGatewayKey,
  setSharedGatewayDefaultKey,
  testGatewayConnection,
  testGatewayFor,
  testUnsavedGateway,
  updateSharedGateway,
  validateGatewayInput,
  type GatewayAuthType,
} from '@/modules/providers/list/claude/claude-gateways.service.js';
import {
  claudeModelCatalog,
  invalidateCatalogCache,
  type ModelViewer,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import { resetEncryptionKey } from '@/shared/crypto-box.js';

/**
 * 模型网关与 key:设置补丁(防串)、key 优先级、加密落库、校验、级联删除、测试连接。
 *
 * SDK 的 flag 层 env 对 settings.json 的 env 是逐键覆盖。所以转到别的网关时,补丁必须把另一种鉴权变量、
 * apiKeyHelper('' 而不是 null)、自定义头都清成空串,否则 settings.json 里默认网关的 token / helper / 头
 * 会跟着发到别的网关去。
 */

const ENV_KEYS = [
  'DATABASE_PATH', 'HOME', 'PRISM_ROOT_USERS', 'PRISM_ENCRYPTION_KEY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDir: string | null = null;

type Users = { alice: number; bob: number; boss: number };

async function fresh(settings: Record<string, unknown> | null = null): Promise<Users> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'hq-gw-keys-'));
  closeConnection();
  resetEncryptionKey();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.HOME = tempDir;
  process.env.PRISM_ROOT_USERS = 'boss';
  // 进程环境是 settings.json 的兜底来源 —— 本机(以及 CI)上可能真有,清掉才是隔离的
  delete process.env.PRISM_ENCRYPTION_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  if (settings) {
    await mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  await initializeDatabase();
  invalidateCatalogCache();
  const id = (name: string) => Number(userDb.createUser(name, 'hash').id);
  return { alice: id('alice'), bob: id('bob'), boss: id('boss') };
}

afterEach(async () => {
  closeConnection();
  invalidateCatalogCache();
  resetEncryptionKey();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.restoreAllMocks();
});

const viewer = (userId: number | null, isRoot = false): ModelViewer => ({ userId, isRoot });

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GatewayError, `expected GatewayError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.equal(error.prismModelRejected, true, '调度器靠它直接报错、不退回一次性路径');
    return true;
  });
}

function throwsCode(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof GatewayError || (error as { code?: string })?.code !== undefined, String(error));
    assert.equal((error as { code?: string }).code, code);
    if (status !== undefined) assert.equal((error as { status?: number }).status, status);
    return true;
  });
}

const SETTINGS_TOKEN = 'settings-token-0000';
const SETTINGS_BEARER = { env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_AUTH_TOKEN: SETTINGS_TOKEN } };

const ALIAS_VARS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

/* ================================================================== */

describe('hq 补丁:防串(每种鉴权方式 × 网关 0 / 别的网关)', () => {
  const cases: Array<{ authType: GatewayAuthType; mine: string; other: string }> = [
    { authType: 'bearer', mine: 'ANTHROPIC_AUTH_TOKEN', other: 'ANTHROPIC_API_KEY' },
    { authType: 'x-api-key', mine: 'ANTHROPIC_API_KEY', other: 'ANTHROPIC_AUTH_TOKEN' },
  ];

  for (const { authType, mine, other } of cases) {
    test(`${authType} · 网关 0 + 个人 key:只换鉴权变量与 apiKeyHelper,地址 / 自定义头 / 别名沿用 settings.json`, () => {
      const patch = buildGatewaySettingsPatch({ gatewayId: 0, baseUrl: null, authType, key: 'sk-personal', model: 'glm-5.2' });
      assert.equal(patch.env[mine], 'sk-personal');
      assert.equal(patch.env[other], '', '另一种鉴权变量必须清成空串,否则 settings.json 里的那个也一起发出去');
      assert.equal(patch.apiKeyHelper, '', 'apiKeyHelper 必须是空串(null 会让整份 flag 设置失效)');
      assert.equal('ANTHROPIC_BASE_URL' in patch.env, false, '网关 0 沿用 settings.json 的地址');
      assert.equal('ANTHROPIC_CUSTOM_HEADERS' in patch.env, false, '网关 0 沿用 settings.json 的自定义头');
      for (const name of ALIAS_VARS) assert.equal(name in patch.env, false, `${name} 沿用 settings.json 的映射`);
      assert.deepEqual(Object.keys(patch.env).sort(), [mine, other].sort());
    });

    test(`${authType} · 别的网关:地址 + key,另一种鉴权变量 / apiKeyHelper / 自定义头清空,别名全指向这一轮的模型`, () => {
      const patch = buildGatewaySettingsPatch({ gatewayId: 7, baseUrl: 'https://other.example.com', authType, key: 'sk-other', model: 'kimi-k2' });
      assert.equal(patch.env[mine], 'sk-other');
      assert.equal(patch.env[other], '');
      assert.equal(patch.apiKeyHelper, '');
      assert.equal(patch.env.ANTHROPIC_BASE_URL, 'https://other.example.com');
      assert.equal(patch.env.ANTHROPIC_CUSTOM_HEADERS, '', 'settings.json 的自定义头不能跟到别的网关');
      for (const name of ALIAS_VARS) assert.equal(patch.env[name], 'kimi-k2', name);
      // flag 层里不能出现 null / undefined —— 每个值都是字符串
      for (const [name, value] of Object.entries(patch.env)) assert.equal(typeof value, 'string', name);
      assert.equal(typeof patch.apiKeyHelper, 'string');
    });
  }

  test('别的网关、没给模型:不写别名(写空串会把别名映射清掉)', () => {
    const patch = buildGatewaySettingsPatch({ gatewayId: 7, baseUrl: 'https://other.example.com', authType: 'bearer', key: 'k', model: null });
    for (const name of ALIAS_VARS) assert.equal(name in patch.env, false, name);
  });

  test('指纹:同输入同值;key / 地址 / 鉴权方式 / 网关 id 任一不同就不同;不含 key 明文', () => {
    const base = { gatewayId: 3, baseUrl: 'https://a.example.com', authType: 'bearer' as GatewayAuthType, key: 'sk-secret-AAAA' };
    const fp = gatewayFingerprint(base);
    assert.match(fp, /^[0-9a-f]{16}$/);
    assert.equal(gatewayFingerprint({ ...base }), fp);
    assert.notEqual(gatewayFingerprint({ ...base, key: 'sk-secret-BBBB' }), fp);
    assert.notEqual(gatewayFingerprint({ ...base, baseUrl: 'https://b.example.com' }), fp);
    assert.notEqual(gatewayFingerprint({ ...base, authType: 'x-api-key' }), fp);
    assert.notEqual(gatewayFingerprint({ ...base, gatewayId: 4 }), fp);
    // 网关 0 的两个人各用各的个人 key → 指纹不同(共享会话换人发消息要重建)
    assert.notEqual(
      gatewayFingerprint({ gatewayId: 0, baseUrl: null, authType: 'bearer', key: 'sk-alice' }),
      gatewayFingerprint({ gatewayId: 0, baseUrl: null, authType: 'bearer', key: 'sk-bob' }),
    );
    assert.equal(fp.includes('AAAA'), false);
  });
});

/* ================================================================== */

describe('hq key 优先级(resolveTurnGateway)', () => {
  test('网关 0:没有个人 key → 什么都不传(CLI 读 settings.json);有个人 key → 只换 key', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const before = await resolveTurnGateway({ model: 'sonnet', viewer: viewer(users.alice) });
    assert.equal(before.gatewayId, 0);
    assert.equal(before.keySource, 'settings');
    assert.equal(before.settingsPatch, null);
    assert.equal(before.fingerprint, null);

    setPersonalKey(0, users.alice, 'sk-alice-0000', users.alice);
    const after = await resolveTurnGateway({ model: 'sonnet', viewer: viewer(users.alice) });
    assert.equal(after.keySource, 'personal');
    assert.deepEqual(after.settingsPatch, { env: { ANTHROPIC_AUTH_TOKEN: 'sk-alice-0000', ANTHROPIC_API_KEY: '' }, apiKeyHelper: '' });
    assert.ok(after.fingerprint);

    // 别人(没填)不受影响
    const bob = await resolveTurnGateway({ model: 'sonnet', viewer: viewer(users.bob) });
    assert.equal(bob.settingsPatch, null);
    // 不带 viewer 的调用方 = settings.json
    assert.equal((await resolveTurnGateway({ model: 'sonnet', viewer: null })).settingsPatch, null);
  });

  test('网关 0 的 settings.json 用 x-api-key:个人 key 进 ANTHROPIC_API_KEY,AUTH_TOKEN 清空', async () => {
    const users = await fresh({ env: { ANTHROPIC_BASE_URL: 'https://gw0.example.com', ANTHROPIC_API_KEY: 'settings-api-key' } });
    setPersonalKey(0, users.alice, 'sk-alice-xkey', users.alice);
    const turn = await resolveTurnGateway({ model: null, viewer: viewer(users.alice) });
    assert.deepEqual(turn.settingsPatch?.env, { ANTHROPIC_API_KEY: 'sk-alice-xkey', ANTHROPIC_AUTH_TOKEN: '' });
    assert.equal(turn.settingsPatch?.apiKeyHelper, '');
  });

  test('别名 / 空模型 / 不认识的模型 → 一律网关 0', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const shared = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-g-default' }, users.boss);
    claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: shared.id }, users.boss);
    for (const model of ['sonnet', 'opus', 'haiku', 'default', '', null, undefined, 'not-in-catalog']) {
      const turn = await resolveTurnGateway({ model, viewer: viewer(users.alice) });
      assert.equal(turn.gatewayId, 0, String(model));
    }
  });

  test('共享网关:个人 key > 网关默认 key;两者都没有 → GATEWAY_KEY_MISSING', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com/v1/', authType: 'x-api-key', defaultKey: 'sk-g-default' }, users.boss);
    assert.equal(g.baseUrl, 'https://g.example.com', '末尾 /v1/ 去掉');
    claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: g.id }, users.boss);

    const alice = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) });
    assert.equal(alice.gatewayId, g.id);
    assert.equal(alice.gatewayName, 'G');
    assert.equal(alice.keySource, 'gateway_default');
    assert.equal(alice.settingsPatch?.env.ANTHROPIC_API_KEY, 'sk-g-default');
    assert.equal(alice.settingsPatch?.env.ANTHROPIC_AUTH_TOKEN, '', 'settings.json 的 token 不能跟到网关 G');
    assert.equal(alice.settingsPatch?.env.ANTHROPIC_BASE_URL, 'https://g.example.com');
    assert.equal(alice.settingsPatch?.env.ANTHROPIC_CUSTOM_HEADERS, '');
    assert.equal(alice.settingsPatch?.apiKeyHelper, '');
    for (const name of ALIAS_VARS) assert.equal(alice.settingsPatch?.env[name], 'kimi-k2');
    assert.equal(JSON.stringify(alice).includes(SETTINGS_TOKEN), false);

    setPersonalKey(g.id, users.bob, 'sk-bob-own', users.bob);
    const bob = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.bob) });
    assert.equal(bob.keySource, 'personal');
    assert.equal(bob.settingsPatch?.env.ANTHROPIC_API_KEY, 'sk-bob-own');
    assert.notEqual(bob.fingerprint, alice.fingerprint);

    // 清掉默认 key:alice 没有任何 key → 拒;bob 仍用自己的
    setSharedGatewayDefaultKey(g.id, null, users.boss);
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) }), 'GATEWAY_KEY_MISSING', 400);
    assert.equal((await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.bob) })).keySource, 'personal');

    // bob 清掉个人 key → 同样拒
    assert.equal(clearPersonalKey(g.id, users.bob), true);
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.bob) }), 'GATEWAY_KEY_MISSING');
    // 不带 viewer 的调用方:只能用默认 key,没有 → 拒(不会退回 settings.json 的 token)
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: null }), 'GATEWAY_KEY_MISSING');
  });

  test('root 代填的个人 key 与本人填的效果完全一样(补丁、指纹)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: g.id }, users.boss);

    setPersonalKey(g.id, users.bob, 'sk-bob-same', users.boss);
    const byRoot = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.bob) });
    assert.equal(gatewayUserKeysDb.listForGateway(g.id)[0].set_by_username, 'boss');

    setPersonalKey(g.id, users.bob, 'sk-bob-same', users.bob);
    const bySelf = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.bob) });
    assert.equal(gatewayUserKeysDb.listForGateway(g.id)[0].set_by_username, 'bob');

    assert.equal(byRoot.keySource, 'personal');
    assert.deepEqual(byRoot.settingsPatch, bySelf.settingsPatch);
    assert.equal(byRoot.fingerprint, bySelf.fingerprint);
    // 网关 0 同理
    setPersonalKey(0, users.bob, 'sk-bob-zero', users.boss);
    const zero = await resolveTurnGateway({ model: 'opus', viewer: viewer(users.bob) });
    assert.equal(zero.keySource, 'personal');
    assert.equal(zero.settingsPatch?.env.ANTHROPIC_AUTH_TOKEN, 'sk-bob-zero');
  });

  test('别的网关上指纹随模型变(别名映射钉在模型上,换模型要重建);补丁里的别名随模型变', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-g' }, users.boss);
    claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: g.id }, users.boss);
    claudeModelCatalog.create({ modelId: 'kimi-k3', gatewayId: g.id }, users.boss);
    const a = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) });
    const b = await resolveTurnGateway({ model: 'kimi-k3', viewer: viewer(users.alice) });
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.equal((await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) })).fingerprint, a.fingerprint, '同模型同 key 稳定');
    assert.equal(a.settingsPatch?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k2');
    assert.equal(b.settingsPatch?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3');

    // 改了网关地址 / 鉴权方式 → 指纹变(常驻进程要重建)
    updateSharedGateway(g.id, { baseUrl: 'https://g2.example.com' }, users.boss);
    const moved = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) });
    assert.notEqual(moved.fingerprint, a.fingerprint);
    updateSharedGateway(g.id, { authType: 'x-api-key' }, users.boss);
    const reauth = await resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) });
    assert.notEqual(reauth.fingerprint, moved.fingerprint);
    assert.equal(reauth.settingsPatch?.env.ANTHROPIC_API_KEY, 'sk-g');
    assert.equal(reauth.settingsPatch?.env.ANTHROPIC_AUTH_TOKEN, '');
  });

  test('网关停用 → GATEWAY_DISABLED;网关不见了 → GATEWAY_MISSING', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-g' }, users.boss);
    claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: g.id }, users.boss);
    updateSharedGateway(g.id, { enabled: false }, users.boss);
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) }), 'GATEWAY_DISABLED');
    // 个人 key 也救不了停用的网关
    setPersonalKey(g.id, users.alice, 'sk-alice', users.alice);
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) }), 'GATEWAY_DISABLED');

    // 目录条目指向一个不存在的网关(库被手改 / 竞态)
    getConnection().prepare('UPDATE model_catalog SET gateway_id = 999 WHERE model_id = ?').run('kimi-k2');
    invalidateCatalogCache();
    await rejectsWith(resolveTurnGateway({ model: 'kimi-k2', viewer: viewer(users.alice) }), 'GATEWAY_MISSING');
  });

  test('私有网关:主人用自己的 key;没 key → GATEWAY_KEY_MISSING;别人用 → GATEWAY_FORBIDDEN(403)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' });
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'alice-model' });
    await rejectsWith(resolveTurnGateway({ model: 'alice-model', viewer: viewer(users.alice) }), 'GATEWAY_KEY_MISSING');

    setPrivateGatewayKey(users.alice, p.id, 'sk-alice-private');
    const turn = await resolveTurnGateway({ model: 'alice-model', viewer: viewer(users.alice) });
    assert.equal(turn.gatewayId, p.id);
    assert.equal(turn.keySource, 'personal');
    assert.equal(turn.settingsPatch?.env.ANTHROPIC_AUTH_TOKEN, 'sk-alice-private');
    assert.equal(turn.settingsPatch?.env.ANTHROPIC_BASE_URL, 'https://alice.example.com');

    // bob 拿同一个名字:他没有这个私有模型 → 落到目录(没有)→ 网关 0,闸口也不放行
    const bob = await resolveTurnGateway({ model: 'alice-model', viewer: viewer(users.bob) });
    assert.equal(bob.gatewayId, 0);
    assert.equal(bob.settingsPatch, null);
    assert.equal(claudeModelCatalog.isAllowed('alice-model', viewer(users.bob)), false);
    // root 也不行(私有模型只有主人能用)
    assert.equal(claudeModelCatalog.isAllowed('alice-model', viewer(users.boss, true)), false);

    // 目录条目被手改成挂在 alice 的私有网关上:bob 发 → 403,而且绝不能拿到 alice 的 key
    modelCatalogDb.insert({
      modelId: 'hijacked', label: 'hijacked', vendor: null, description: null, contextWindow: null, effortLevels: null,
      effortDefault: null, recommended: false, sortOrder: 0, enabled: true, isDefault: false, gatewayId: p.id, allowedUsers: null,
    }, users.boss);
    invalidateCatalogCache();
    await rejectsWith(resolveTurnGateway({ model: 'hijacked', viewer: viewer(users.bob) }), 'GATEWAY_FORBIDDEN', 403);
    await rejectsWith(resolveTurnGateway({ model: 'hijacked', viewer: viewer(users.boss, true) }), 'GATEWAY_FORBIDDEN', 403);
    await rejectsWith(resolveTurnGateway({ model: 'hijacked', viewer: null }), 'GATEWAY_FORBIDDEN', 403);
  });

  test('私有网关上不能填"个人 key"(key 属于网关本身)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' });
    throwsCode(() => setPersonalKey(p.id, users.alice, 'sk-x', users.alice), 'PRIVATE_GATEWAY');
    // 别人(含 root)的调用一律当"不存在"(404)—— 不泄露这个 id 是某人的私有网关
    throwsCode(() => setPersonalKey(p.id, users.bob, 'sk-x', users.boss), 'NOT_FOUND', 404);
    throwsCode(() => setPersonalKey(4242, users.bob, 'sk-x', users.boss), 'NOT_FOUND', 404);
    throwsCode(() => setPersonalKey(0, 4242, 'sk-x', users.boss), 'NOT_FOUND', 404);
    assert.equal(gatewayUserKeysDb.listForUser(users.alice).length, 0);
  });
});

/* ================================================================== */

describe('hq key 加密落库', () => {
  test('三处 key(共享默认 key / 个人 key / 私有网关 key)都是 v1 密文 + 末四位;读接口解密;行里不带密文', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const shared = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-shared-default-1234' }, users.boss);
    setPersonalKey(shared.id, users.alice, 'sk-alice-personal-5678', users.alice);
    setPersonalKey(0, users.bob, 'sk-bob-zero-9012', users.boss);
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'x-api-key', key: 'sk-alice-private-3456' });

    const db = getConnection();
    const gatewayRows = db.prepare('SELECT id, default_key, default_key_last4 FROM model_gateways ORDER BY id').all() as Array<{ id: number; default_key: string; default_key_last4: string }>;
    const byId = new Map(gatewayRows.map((row) => [row.id, row]));
    for (const [id, key] of [[shared.id, 'sk-shared-default-1234'], [p.id, 'sk-alice-private-3456']] as const) {
      const row = byId.get(id)!;
      assert.match(row.default_key, /^v1:[\w-]+:[\w-]+:[\w-]+$/);
      assert.equal(row.default_key.includes(key), false);
      assert.equal(row.default_key_last4, key.slice(-4));
      assert.equal(modelGatewaysDb.readDefaultKey(id), key);
    }
    const keyRows = db.prepare('SELECT gateway_id, user_id, key_enc, key_last4 FROM gateway_user_keys').all() as Array<{ gateway_id: number; user_id: number; key_enc: string; key_last4: string }>;
    assert.equal(keyRows.length, 2);
    for (const row of keyRows) {
      const key = row.user_id === users.alice ? 'sk-alice-personal-5678' : 'sk-bob-zero-9012';
      assert.match(row.key_enc, /^v1:/);
      assert.equal(row.key_enc.includes(key), false);
      assert.equal(row.key_last4, key.slice(-4));
      assert.equal(gatewayUserKeysDb.readKey(row.gateway_id, row.user_id), key);
    }
    // 同一把 key 两次加密不同(随机 IV)
    setPersonalKey(0, users.alice, 'sk-bob-zero-9012', users.alice);
    const twice = db.prepare('SELECT key_enc FROM gateway_user_keys WHERE gateway_id = 0').all() as Array<{ key_enc: string }>;
    assert.notEqual(twice[0].key_enc, twice[1].key_enc);

    // list / get 的行里不带密文列
    for (const row of [...modelGatewaysDb.listAll(), modelGatewaysDb.get(shared.id)!]) {
      assert.equal('default_key' in row, false);
      assert.equal(JSON.stringify(row).includes('v1:'), false);
    }
    for (const row of [...gatewayUserKeysDb.listForGateway(shared.id), ...gatewayUserKeysDb.listForUser(users.alice)]) {
      assert.equal('key_enc' in row, false);
    }

    // 整个库文件里找不到任何一把明文 key
    closeConnection();
    const dbPath = process.env.DATABASE_PATH!;
    const bytes = Buffer.concat([await readFile(dbPath), await readFile(`${dbPath}-wal`).catch(() => Buffer.alloc(0))]);
    for (const key of ['sk-shared-default-1234', 'sk-alice-personal-5678', 'sk-bob-zero-9012', 'sk-alice-private-3456']) {
      assert.equal(bytes.includes(Buffer.from(key)), false, `${key} 以明文出现在库文件里`);
    }
  });

  test('清掉默认 key:密文与末四位一起清;readDefaultKey → null', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-zzzz' }, users.boss);
    const cleared = setSharedGatewayDefaultKey(g.id, null, users.boss);
    assert.equal(cleared.hasDefaultKey, false);
    assert.equal(cleared.defaultKeyLast4, null);
    assert.equal(modelGatewaysDb.readDefaultKey(g.id), null);
    const row = getConnection().prepare('SELECT default_key, default_key_last4 FROM model_gateways WHERE id = ?').get(g.id) as Record<string, unknown>;
    assert.deepEqual(row, { default_key: null, default_key_last4: null });
  });
});

/* ================================================================== */

describe('hq 校验:网关地址 / key / 网关字段', () => {
  test('地址:去末尾 /、去末尾 /v1(大小写不敏感)、保留中间路径', () => {
    assert.equal(normalizeBaseUrl('https://gw.example.com'), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('  https://gw.example.com/  '), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('https://gw.example.com///'), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('https://gw.example.com/v1'), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('https://gw.example.com/v1/'), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('https://gw.example.com/V1'), 'https://gw.example.com');
    assert.equal(normalizeBaseUrl('https://gw.example.com/tenant/abc/v1'), 'https://gw.example.com/tenant/abc');
    assert.equal(normalizeBaseUrl('https://gw.example.com/apiv1'), 'https://gw.example.com/apiv1', '不是 /v1 段的不动');
    assert.equal(normalizeBaseUrl('http://10.0.0.5:8080/anthropic/'), 'http://10.0.0.5:8080/anthropic');
  });

  test('地址:拒绝账号密码、非 http(s)、#、空、非 URL、超长', () => {
    for (const bad of [
      'https://user:pass@gw.example.com',
      'https://user@gw.example.com',
      'ftp://gw.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://gw.example.com/#frag',
      'https://gw.example.com/path#x',
      '',
      '   ',
      'gw.example.com',
      `https://gw.example.com/${'a'.repeat(500)}`,
      null,
      42,
    ]) {
      throwsCode(() => normalizeBaseUrl(bad), 'BAD_BASE_URL');
    }
  });

  // 只有一个 `#`(空片段)时 `new URL(...).hash === ''`,只看 hash 会放行并存下 `https://gw.example.com/#`;
  // CLI 拼成 `https://gw.example.com/#/v1/messages`,片段被丢掉,请求打到网关根路径。所以原文里出现 `#` 就拒。
  test('地址:只有一个 #(空片段)也要拒', () => {
    throwsCode(() => normalizeBaseUrl('https://gw.example.com/#'), 'BAD_BASE_URL');
  });

  test('key:去首尾空白;中间有空白 / 换行 / 控制字符、空、非字符串、超长 → BAD_KEY', () => {
    assert.equal(normalizeKey('  sk-abc  '), 'sk-abc');
    assert.equal(normalizeKey('sk-abc\n'), 'sk-abc', '末尾换行是粘贴带的,去掉');
    for (const bad of ['', '   ', '\n', 'sk abc', 'sk-a\nbc', 'sk-a\r\nbc', 'sk\tabc', 'sk\u0007abc', 'sk\u007fabc', 'sk abc', 'x'.repeat(4097), null, undefined, 123, {}]) {
      throwsCode(() => normalizeKey(bad), 'BAD_KEY');
    }
    assert.equal(normalizeKey('x'.repeat(4096)).length, 4096);
  });

  test('写库前都过 normalizeKey(共享默认 key / 个人 key / 私有网关 key / 未保存的测试)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    throwsCode(() => createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk a' }, users.boss), 'BAD_KEY');
    assert.equal(modelGatewaysDb.listAll().length, 0, '校验失败不能留下半条网关');
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    throwsCode(() => setSharedGatewayDefaultKey(g.id, 'sk\nx', users.boss), 'BAD_KEY');
    throwsCode(() => setPersonalKey(g.id, users.alice, '', users.alice), 'BAD_KEY');
    throwsCode(() => setPersonalKey(0, users.alice, 'a b', users.alice), 'BAD_KEY');
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' });
    throwsCode(() => setPrivateGatewayKey(users.alice, p.id, 'a\tb'), 'BAD_KEY');
    throwsCode(() => createPrivateGateway(users.alice, { name: 'two', baseUrl: 'https://two.example.com', authType: 'bearer', key: 'x y' }), 'BAD_KEY');
    await assert.rejects(testUnsavedGateway({ baseUrl: 'https://g.example.com', authType: 'bearer', key: 'x y' }), (error: unknown) => (error as GatewayError).code === 'BAD_KEY');
    await assert.rejects(testUnsavedGateway({ baseUrl: 'https://u:p@g.example.com', authType: 'bearer', key: 'k' }), (error: unknown) => (error as GatewayError).code === 'BAD_BASE_URL');
  });

  test('网关字段:名字必填 ≤60、鉴权方式只能两种、enabled 必须布尔;改的时候没给的沿用', async () => {
    const users = await fresh(SETTINGS_BEARER);
    throwsCode(() => validateGatewayInput({ name: '  ', baseUrl: 'https://g.example.com' }, null), 'BAD_NAME');
    throwsCode(() => validateGatewayInput({ name: 'x'.repeat(61), baseUrl: 'https://g.example.com' }, null), 'BAD_NAME');
    throwsCode(() => validateGatewayInput({ name: 'G', baseUrl: 'https://g.example.com', authType: 'basic' }, null), 'BAD_AUTH_TYPE');
    throwsCode(() => validateGatewayInput({ name: 'G', baseUrl: 'https://g.example.com', enabled: 'yes' }, null), 'BAD_FIELD');
    assert.deepEqual(validateGatewayInput({ name: ' G ', baseUrl: 'https://g.example.com/v1' }, null), {
      name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', enabled: true,
    });
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'x-api-key', enabled: false }, users.boss);
    const { after } = updateSharedGateway(g.id, { name: 'G2' }, users.boss);
    assert.equal(after.authType, 'x-api-key');
    assert.equal(after.enabled, false);
    assert.equal(after.baseUrl, 'https://g.example.com');
    // 同名(大小写不敏感)的共享网关不能有两个;私有网关按人各自查重
    throwsCode(() => createSharedGateway({ name: 'g2', baseUrl: 'https://x.example.com' }, users.boss), 'DUPLICATE_NAME', 409);
    createPrivateGateway(users.alice, { name: 'G2', baseUrl: 'https://x.example.com' });
    createPrivateGateway(users.bob, { name: 'G2', baseUrl: 'https://x.example.com' });
    throwsCode(() => createPrivateGateway(users.alice, { name: 'g2', baseUrl: 'https://y.example.com' }), 'DUPLICATE_NAME', 409);
  });
});

/* ================================================================== */

describe('hq 删除网关:级联', () => {
  test('共享网关还挂着目录条目 → 409 GATEWAY_IN_USE;摘掉后能删,连带删掉它上面的个人 key(网关 0 的不动)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-g' }, users.boss);
    const other = createSharedGateway({ name: 'H', baseUrl: 'https://h.example.com', authType: 'bearer' }, users.boss);
    const entry = claudeModelCatalog.create({ modelId: 'kimi-k2', gatewayId: g.id }, users.boss);
    setPersonalKey(g.id, users.alice, 'sk-alice-g', users.alice);
    setPersonalKey(g.id, users.bob, 'sk-bob-g', users.boss);
    setPersonalKey(other.id, users.bob, 'sk-bob-h', users.bob);
    setPersonalKey(0, users.alice, 'sk-alice-0', users.alice);

    throwsCode(() => deleteSharedGateway(g.id), 'GATEWAY_IN_USE', 409);
    assert.ok(modelGatewaysDb.get(g.id), '409 时什么都不删');
    assert.equal(gatewayUserKeysDb.listForGateway(g.id).length, 2);

    claudeModelCatalog.update(entry.id, { gatewayId: 0 }, users.boss);
    deleteSharedGateway(g.id);
    assert.equal(modelGatewaysDb.get(g.id), null);
    assert.equal(gatewayUserKeysDb.listForGateway(g.id).length, 0);
    assert.equal(gatewayUserKeysDb.readKey(g.id, users.alice), null);
    assert.equal(gatewayUserKeysDb.listForGateway(other.id).length, 1, '别的网关的 key 不动');
    assert.equal(gatewayUserKeysDb.readKey(0, users.alice), 'sk-alice-0', '网关 0 的个人 key 不动');
    throwsCode(() => deleteSharedGateway(g.id), 'NOT_FOUND', 404);
  });

  test('删共享网关的入口删不了私有网关;删私有网关连同它上面的私有模型', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer', key: 'sk-p' });
    const q = createPrivateGateway(users.alice, { name: 'mine2', baseUrl: 'https://alice2.example.com', authType: 'bearer', key: 'sk-q' });
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'm-1' });
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'm-2' });
    createMyModel(users.alice, { gatewayId: q.id, modelId: 'm-3' });

    throwsCode(() => deleteSharedGateway(p.id), 'NOT_FOUND', 404);
    throwsCode(() => deletePrivateGateway(users.bob, p.id), 'NOT_FOUND', 404);
    assert.equal(userModelsDb.countByGateway(p.id), 2);

    deletePrivateGateway(users.alice, p.id);
    assert.equal(modelGatewaysDb.get(p.id), null);
    assert.equal(userModelsDb.countByGateway(p.id), 0);
    assert.deepEqual(userModelsDb.listForUser(users.alice).map((row) => row.model_id), ['m-3']);
  });
});

/* ================================================================== */

type Seen = { url: string; headers: IncomingHttpHeaders };

describe('hq 测试连接(本地假网关)', () => {
  let server: Server;
  let base = '';
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      const url = req.url ?? '';
      const echo = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
      if (url.startsWith('/ok/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { nope: 1 }] }));
      } else if (url.startsWith('/denied/')) {
        // 故意把收到的 key 回显在错误体里:结果里不能带出来
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `invalid key ${echo}` } }));
      } else if (url.startsWith('/forbidden/')) {
        res.writeHead(403);
        res.end(`forbidden ${echo}`);
      } else if (url.startsWith('/messages-only/')) {
        res.writeHead(404);
        res.end(`not found ${echo}`);
      } else if (url.startsWith('/broken/')) {
        res.writeHead(502);
        res.end(`bad gateway ${echo}`);
      } else if (url.startsWith('/garbage/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json');
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const spyConsole = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
  const consoleText = (spies: ReturnType<typeof spyConsole>) => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

  test('bearer → Authorization: Bearer;x-api-key → x-api-key 头;都带 anthropic-version;打 /v1/models?limit=200', async () => {
    seen.length = 0;
    const ok = await testGatewayConnection({ baseUrl: `${base}/ok`, authType: 'bearer', key: 'sk-bearer-1111' });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.modelCount, 2);
    assert.deepEqual(ok.sampleModels, ['model-a', 'model-b']);
    assert.equal(ok.error, null);
    assert.equal(seen[0].url, '/ok/v1/models?limit=200');
    assert.equal(seen[0].headers.authorization, 'Bearer sk-bearer-1111');
    assert.equal(seen[0].headers['x-api-key'], undefined);
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');

    await testGatewayConnection({ baseUrl: `${base}/ok`, authType: 'x-api-key', key: 'sk-xkey-2222' });
    assert.equal(seen[1].headers['x-api-key'], 'sk-xkey-2222');
    assert.equal(seen[1].headers.authorization, undefined);
  });

  test('401 / 403 → ok false + 状态码;404 → 提示 /v1/models;其它非 2xx;坏 JSON 按 0 个;连不上 —— 结果与日志里都没有 key', async () => {
    const spies = spyConsole();
    const key = 'sk-never-leak-3333';
    const denied = await testGatewayConnection({ baseUrl: `${base}/denied`, authType: 'bearer', key });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);
    assert.match(denied.error ?? '', /401/);
    const forbidden = await testGatewayConnection({ baseUrl: `${base}/forbidden`, authType: 'x-api-key', key });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.ok, false);
    const missing = await testGatewayConnection({ baseUrl: `${base}/messages-only`, authType: 'bearer', key });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.match(missing.error ?? '', /\/v1\/models/);
    const broken = await testGatewayConnection({ baseUrl: `${base}/broken`, authType: 'bearer', key });
    assert.equal(broken.ok, false);
    assert.equal(broken.status, 502);
    const garbage = await testGatewayConnection({ baseUrl: `${base}/garbage`, authType: 'bearer', key });
    assert.equal(garbage.ok, true);
    assert.equal(garbage.modelCount, 0);

    // 关掉的端口:连不上
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await testGatewayConnection({ baseUrl: `http://127.0.0.1:${closedPort}`, authType: 'bearer', key });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, null);
    assert.ok(refused.error);

    for (const result of [denied, forbidden, missing, broken, garbage, refused]) {
      assert.equal(JSON.stringify(result).includes(key), false, JSON.stringify(result));
      assert.equal(typeof result.latencyMs, 'number');
    }
    assert.equal(consoleText(spies).includes(key), false, '测试连接不能把 key 打进日志');
  });

  test('没地址 / 没 key:不发请求,直接说明', async () => {
    seen.length = 0;
    const noUrl = await testGatewayConnection({ baseUrl: null, authType: 'bearer', key: 'k' });
    const noKey = await testGatewayConnection({ baseUrl: `${base}/ok`, authType: 'bearer', key: null });
    assert.equal(noUrl.ok, false);
    assert.equal(noKey.ok, false);
    assert.ok(noUrl.error && noKey.error);
    assert.equal(seen.length, 0);
  });

  test('testGatewayFor:网关 0 用 个人 key > settings.json 的 token;给了 key 用给的;别人的私有网关 → 404', async () => {
    const users = await fresh({ env: { ANTHROPIC_BASE_URL: `${base}/ok`, ANTHROPIC_AUTH_TOKEN: SETTINGS_TOKEN } });
    seen.length = 0;
    const viaSettings = await testGatewayFor(0, viewer(users.alice));
    assert.equal(viaSettings.ok, true);
    assert.equal(seen.at(-1)?.headers.authorization, `Bearer ${SETTINGS_TOKEN}`);
    assert.equal(JSON.stringify(viaSettings).includes(SETTINGS_TOKEN), false);

    setPersonalKey(0, users.alice, 'sk-alice-zero', users.alice);
    await testGatewayFor(0, viewer(users.alice));
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-alice-zero');
    await testGatewayFor(0, viewer(users.alice), 'sk-candidate');
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-candidate');

    const g = createSharedGateway({ name: 'G', baseUrl: `${base}/ok`, authType: 'x-api-key', defaultKey: 'sk-g-default' }, users.boss);
    await testGatewayFor(g.id, viewer(users.bob));
    assert.equal(seen.at(-1)?.headers['x-api-key'], 'sk-g-default');
    setPersonalKey(g.id, users.bob, 'sk-bob-g', users.bob);
    await testGatewayFor(g.id, viewer(users.bob));
    assert.equal(seen.at(-1)?.headers['x-api-key'], 'sk-bob-g');

    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: `${base}/ok`, authType: 'bearer', key: 'sk-alice-private' });
    const count = seen.length;
    await assert.rejects(testGatewayFor(p.id, viewer(users.bob)), (error: unknown) => (error as GatewayError).code === 'NOT_FOUND' && (error as GatewayError).status === 404);
    await assert.rejects(testGatewayFor(p.id, viewer(users.boss, true)), (error: unknown) => (error as GatewayError).status === 404);
    assert.equal(seen.length, count, '别人的私有网关:一个请求都不发(更不能带着主人的 key 发)');
    await testGatewayFor(p.id, viewer(users.alice));
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-alice-private');
    await assert.rejects(testGatewayFor(4242, viewer(users.alice)), (error: unknown) => (error as GatewayError).status === 404);
  });

  test('testUnsavedGateway:地址先规范化(去 /v1)再测', async () => {
    seen.length = 0;
    const result = await testUnsavedGateway({ baseUrl: `${base}/ok/v1/`, authType: 'x-api-key', key: '  sk-unsaved  ' });
    assert.equal(result.ok, true);
    assert.equal(seen[0].url, '/ok/v1/models?limit=200');
    assert.equal(seen[0].headers['x-api-key'], 'sk-unsaved');
  });
});

describe('读 key 出错与可用人员校验', () => {
  test('读 key 时库 / 解密出错 → GatewayError GATEWAY_KEY_UNREADABLE(不退回 settings.json 的 key)', async () => {
    const users = await fresh(SETTINGS_BEARER);
    setPersonalKey(0, users.alice, 'sk-alice-0', users.alice);
    // 模拟换了加密密钥:把密文改坏
    getConnection().prepare("UPDATE gateway_user_keys SET key_enc = 'v1:AAAA:BBBB:CCCC' WHERE user_id = ?").run(users.alice);
    await assert.rejects(resolveTurnGateway({ model: 'sonnet', viewer: viewer(users.alice) }), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal((error as GatewayError).code, 'GATEWAY_KEY_UNREADABLE');
      assert.equal((error as GatewayError).prismModelRejected, true);
      assert.equal(String((error as Error).message).includes('sk-alice'), false);
      return true;
    });
    // 别人(没有个人 key)照常走 settings.json
    assert.equal((await resolveTurnGateway({ model: 'sonnet', viewer: viewer(users.bob) })).settingsPatch, null);
  });

  test('可用人员里有人被停用 → 只改别的字段(上下架)照样能存;新加不存在的人才拒', async () => {
    const users = await fresh(SETTINGS_BEARER);
    const entry = claudeModelCatalog.create({ modelId: 'team-model', allowedUsers: [users.alice, users.bob] }, users.boss);
    userDb.setActive(users.bob, false);
    const toggled = claudeModelCatalog.update(entry.id, { enabled: false }, users.boss).after;
    assert.equal(toggled.enabled, false);
    assert.deepEqual(toggled.allowedUsers, [users.alice, users.bob].sort((a, b) => a - b));
    assert.throws(() => claudeModelCatalog.update(entry.id, { allowedUsers: [users.alice, users.bob, 99999] }, users.boss), /不存在的用户/);
  });
});

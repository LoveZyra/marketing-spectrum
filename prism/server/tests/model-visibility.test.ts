import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  appConfigDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import {
  annotateModelAvailability,
  createMyModel,
  createPrivateGateway,
  createSharedGateway,
  deleteMyModel,
  deletePrivateGateway,
  modelsDefinitionFor,
  resolveTurnGateway,
  setPersonalKey,
  setPrivateGatewayKey,
  updateMyModel,
  updatePrivateGateway,
  updateSharedGateway,
} from '@/modules/providers/list/claude/claude-gateways.service.js';
import {
  CatalogValidationError,
  PRIVATE_GATEWAYS_KEY,
  claudeModelCatalog,
  entryVisibleTo,
  invalidateCatalogCache,
  modelViewerFor,
  privateEntriesFor,
  privateGatewaysEnabled,
  subagentModelEnv,
  validateCatalogInput,
  validateUserModelInput,
  type ModelViewer,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import { resetEncryptionKey } from '@/shared/crypto-box.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

/**
 * 模型按人可见:「可用人员」、私有模型(与目录同名时本人优先)、私有网关总开关、选择器的"能不能用"、
 * 子代理模型按人按网关筛、目录 / 私有模型的引用校验。
 */

const ENV_KEYS = [
  'DATABASE_PATH', 'HOME', 'PRISM_ROOT_USERS', 'PRISM_ENCRYPTION_KEY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDir: string | null = null;

type Users = { alice: number; bob: number; carol: number; boss: number };

async function fresh(): Promise<Users> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'hq-visibility-'));
  closeConnection();
  resetEncryptionKey();
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
  await initializeDatabase();
  invalidateCatalogCache();
  const id = (name: string) => Number(userDb.createUser(name, 'hash').id);
  return { alice: id('alice'), bob: id('bob'), carol: id('carol'), boss: id('boss') };
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
});

const as = (userId: number | null, isRoot = false): ModelViewer => ({ userId, isRoot });
const catalogValues = (definition: ProviderModelsDefinition) => definition.OPTIONS.filter((option) => option.group === 'catalog').map((option) => option.value);
const option = (definition: ProviderModelsDefinition, value: string) => definition.OPTIONS.find((candidate) => candidate.value === value);

function throwsCatalog(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CatalogValidationError, String(error));
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

/** 三条目录:所有人 / 只有 alice / 只有 root(空数组)。 */
function seedCatalog(users: Users) {
  claudeModelCatalog.create({ modelId: 'open-model', recommended: true, sortOrder: 10 }, users.boss);
  claudeModelCatalog.create({ modelId: 'team-model', allowedUsers: [users.alice], isDefault: true, sortOrder: 20 }, users.boss);
  claudeModelCatalog.create({ modelId: 'root-only', allowedUsers: [], sortOrder: 30 }, users.boss);
}

/* ================================================================== */

describe('hq 可用人员(allowedUsers)', () => {
  test('null = 所有人;数组 = 只有名单里的人 + root;空数组 = 只有 root;不给 viewer 的老调用方不按人', async () => {
    const users = await fresh();
    seedCatalog(users);
    const cases: Array<[string, ModelViewer, boolean]> = [
      ['open-model', as(users.bob), true],
      ['open-model', as(null), true],
      ['team-model', as(users.alice), true],
      ['team-model', as(users.bob), false],
      ['team-model', as(null), false],
      ['team-model', as(users.boss, true), true],
      ['root-only', as(users.alice), false],
      ['root-only', as(users.boss, true), true],
    ];
    for (const [model, viewer, expected] of cases) {
      assert.equal(claudeModelCatalog.isAllowed(model, viewer), expected, `${model} / ${JSON.stringify(viewer)}`);
    }
    assert.equal(claudeModelCatalog.isAllowed('team-model'), true, '不给 viewer = 不按人(老调用方)');
    assert.throws(() => claudeModelCatalog.assertAllowed('team-model', as(users.bob)), (error: unknown) => (error as { code?: string }).code === 'MODEL_NOT_ALLOWED');
    // 别名永远放行
    assert.equal(claudeModelCatalog.isAllowed('sonnet', as(users.bob)), true);
    assert.equal(claudeModelCatalog.isAllowed(null, as(users.bob)), true);
  });

  test('modelViewerFor:root 按 PRISM_ROOT_USERS 判(不看前端给的);查不到用户名按非 root', async () => {
    const users = await fresh();
    assert.deepEqual(modelViewerFor(users.boss), { userId: users.boss, isRoot: true });
    assert.deepEqual(modelViewerFor(users.alice, 'alice'), { userId: users.alice, isRoot: false });
    assert.deepEqual(modelViewerFor(4242), { userId: 4242, isRoot: false });
    assert.deepEqual(modelViewerFor(0), { userId: null, isRoot: false });
  });

  test('buildModelsDefinition(viewer):只留看得见的;别名组始终在且 gatewayId 0;DEFAULT 在看得见的里面挑', async () => {
    const users = await fresh();
    seedCatalog(users);
    const bob = claudeModelCatalog.buildModelsDefinition(as(users.bob));
    assert.deepEqual(catalogValues(bob), ['open-model']);
    assert.equal(bob.DEFAULT, 'open-model', 'is_default 那条 bob 看不见 → 第一条推荐的');
    assert.ok(bob.OPTIONS.some((candidate) => candidate.group === 'alias' && candidate.value === 'sonnet' && candidate.gatewayId === 0));

    const alice = claudeModelCatalog.buildModelsDefinition(as(users.alice));
    assert.deepEqual(catalogValues(alice), ['open-model', 'team-model']);
    assert.equal(alice.DEFAULT, 'team-model');

    const boss = claudeModelCatalog.buildModelsDefinition(as(users.boss, true));
    assert.deepEqual(catalogValues(boss), ['open-model', 'team-model', 'root-only']);
    assert.equal(boss.DEFAULT, 'team-model');

    // 每条都带 gatewayId
    for (const candidate of boss.OPTIONS) assert.equal(typeof candidate.gatewayId, 'number', candidate.value);
  });

  test('defaultModel(viewer):跳过看不见的;都看不见 → 别名 default', async () => {
    const users = await fresh();
    claudeModelCatalog.create({ modelId: 'team-model', allowedUsers: [users.alice], isDefault: true }, users.boss);
    claudeModelCatalog.create({ modelId: 'carol-model', allowedUsers: [users.carol], recommended: true }, users.boss);
    assert.equal(claudeModelCatalog.defaultModel(as(users.alice)), 'team-model');
    assert.equal(claudeModelCatalog.defaultModel(as(users.carol)), 'carol-model');
    assert.equal(claudeModelCatalog.defaultModel(as(users.bob)), 'default');
    assert.equal(claudeModelCatalog.defaultModel(), 'team-model', '不按人');
  });

  test('entryVisibleTo:userId 为 null 的非 root 只看得见"所有人"的条目', async () => {
    const users = await fresh();
    seedCatalog(users);
    const team = claudeModelCatalog.lookup('team-model')!;
    assert.equal(entryVisibleTo(team, as(null)), false);
    assert.equal(entryVisibleTo(team, null), true);
    assert.equal(entryVisibleTo(claudeModelCatalog.lookup('open-model')!, as(null)), true);
  });
});

/* ================================================================== */

describe('hq 私有模型', () => {
  async function withPrivate() {
    const users = await fresh();
    seedCatalog(users);
    const p = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer', key: 'sk-alice-private' });
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'my-model', label: '我的' });
    // 与目录同名:对 alice 来说私有的那条优先
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'open-model', label: '我自己的 open' });
    return { users, p };
  }

  test('只有主人看得见、排在目录前面、带 private;同名的目录条目只对主人隐去', async () => {
    const { users, p } = await withPrivate();
    const alice = claudeModelCatalog.buildModelsDefinition(as(users.alice));
    const catalog = alice.OPTIONS.filter((candidate) => candidate.group === 'catalog');
    assert.deepEqual(catalog.slice(0, 2).map((candidate) => [candidate.value, candidate.private, candidate.gatewayId]), [
      ['my-model', true, p.id],
      ['open-model', true, p.id],
    ]);
    assert.equal(catalog.filter((candidate) => candidate.value === 'open-model').length, 1, '同名目录条目对 alice 隐去');
    assert.deepEqual(catalogValues(alice), ['my-model', 'open-model', 'team-model']);

    const bob = claudeModelCatalog.buildModelsDefinition(as(users.bob));
    assert.deepEqual(catalogValues(bob), ['open-model']);
    assert.equal(option(bob, 'open-model')?.private, undefined);
    assert.equal(option(bob, 'open-model')?.gatewayId, 0);
    const boss = claudeModelCatalog.buildModelsDefinition(as(users.boss, true));
    assert.equal(catalogValues(boss).includes('my-model'), false, 'root 也看不见别人的私有模型');

    // 查表与网关解析按人
    assert.equal(claudeModelCatalog.lookupFor('open-model', as(users.alice))?.ownerUserId, users.alice);
    assert.equal(claudeModelCatalog.lookupFor('open-model', as(users.bob))?.ownerUserId, null);
    assert.equal((await resolveTurnGateway({ model: 'open-model', viewer: as(users.alice) })).gatewayId, p.id);
    assert.equal((await resolveTurnGateway({ model: 'open-model', viewer: as(users.bob) })).gatewayId, 0);
    assert.equal(claudeModelCatalog.isAllowed('my-model', as(users.alice)), true);
    assert.equal(claudeModelCatalog.isAllowed('my-model', as(users.bob)), false);
    assert.equal(claudeModelCatalog.isAllowed('my-model'), false, '不按人的老调用方看不到私有模型');
  });

  test('私有模型下架 / 私有网关停用 → 不再出现,同名的回落到目录条目', async () => {
    const { users, p } = await withPrivate();
    const own = claudeModelCatalog.lookupFor('open-model', as(users.alice))!;
    updateMyModel(users.alice, own.id, { enabled: false });
    assert.equal(claudeModelCatalog.lookupFor('open-model', as(users.alice))?.ownerUserId, null);
    assert.equal(option(claudeModelCatalog.buildModelsDefinition(as(users.alice)), 'open-model')?.gatewayId, 0);
    assert.deepEqual(privateEntriesFor(users.alice).map((entry) => entry.modelId), ['my-model']);

    updatePrivateGateway(users.alice, p.id, { enabled: false });
    assert.deepEqual(privateEntriesFor(users.alice), []);
    assert.equal(claudeModelCatalog.isAllowed('my-model', as(users.alice)), false);
    assert.equal((await resolveTurnGateway({ model: 'open-model', viewer: as(users.alice) })).gatewayId, 0);
  });

  test('私有网关总开关关掉:私有模型全部消失、闸口拒;本人仍能删;不能新建 / 修改', async () => {
    const { users, p } = await withPrivate();
    assert.equal(privateGatewaysEnabled(), true, '没设 = 开');
    appConfigDb.set(PRIVATE_GATEWAYS_KEY, '0');
    assert.equal(privateGatewaysEnabled(), false);
    assert.deepEqual(privateEntriesFor(users.alice), []);
    assert.equal(claudeModelCatalog.isAllowed('my-model', as(users.alice)), false);
    const alice = claudeModelCatalog.buildModelsDefinition(as(users.alice));
    assert.equal(alice.OPTIONS.some((candidate) => candidate.private), false);
    assert.equal(option(alice, 'open-model')?.gatewayId, 0, '同名的回到目录条目');
    assert.equal((await resolveTurnGateway({ model: 'open-model', viewer: as(users.alice) })).gatewayId, 0);

    const forbidden = (fn: () => unknown) => assert.throws(fn, (error: unknown) => (error as { code?: string }).code === 'PRIVATE_GATEWAYS_DISABLED' && (error as { status?: number }).status === 403);
    forbidden(() => createPrivateGateway(users.bob, { name: 'x', baseUrl: 'https://x.example.com' }));
    forbidden(() => updatePrivateGateway(users.alice, p.id, { name: 'renamed' }));
    forbidden(() => setPrivateGatewayKey(users.alice, p.id, 'sk-new'));
    forbidden(() => createMyModel(users.alice, { gatewayId: p.id, modelId: 'another' }));
    const own = claudeModelCatalog.lookupFor('my-model', as(users.alice));
    assert.equal(own?.ownerUserId ?? null, null, '关掉之后 lookupFor 不再返回私有模型');

    // 删除不受开关限制
    const rows = getConnection().prepare('SELECT id FROM user_models WHERE user_id = ? ORDER BY id').all(users.alice) as Array<{ id: number }>;
    deleteMyModel(users.alice, rows[0].id);
    deletePrivateGateway(users.alice, p.id);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS c FROM user_models').get() as { c: number }).c, 0);

    appConfigDb.set(PRIVATE_GATEWAYS_KEY, '1');
    assert.equal(privateGatewaysEnabled(), true);
  });

  test('私有模型的引用校验:只能挂自己的私有网关;别名 / 重名 / 网关缺失都拒', async () => {
    const { users, p } = await withPrivate();
    const shared = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    const bobs = createPrivateGateway(users.bob, { name: 'bobs', baseUrl: 'https://bob.example.com' });
    const notFound = (fn: () => unknown) => assert.throws(fn, (error: unknown) => (error as { status?: number }).status === 404);
    notFound(() => createMyModel(users.alice, { gatewayId: shared.id, modelId: 'on-shared' }));
    notFound(() => createMyModel(users.alice, { gatewayId: bobs.id, modelId: 'on-bobs' }));
    notFound(() => createMyModel(users.alice, { gatewayId: 4242, modelId: 'nowhere' }));
    throwsCatalog(() => createMyModel(users.alice, { gatewayId: 0, modelId: 'zero' }), 'BAD_GATEWAY');
    throwsCatalog(() => createMyModel(users.alice, { modelId: 'no-gateway' }), 'BAD_GATEWAY');
    throwsCatalog(() => createMyModel(users.alice, { gatewayId: p.id, modelId: 'sonnet' }), 'MODEL_ID_IS_ALIAS');
    throwsCatalog(() => createMyModel(users.alice, { gatewayId: p.id, modelId: 'my-model' }), 'DUPLICATE_MODEL_ID', 409);
    // 别人可以用同一个名字(各自的命名空间)
    createMyModel(users.bob, { gatewayId: bobs.id, modelId: 'my-model' });
    // 改到别人的网关上 / 改别人的模型 → 404
    const mine = claudeModelCatalog.lookupFor('my-model', as(users.alice))!;
    notFound(() => updateMyModel(users.alice, mine.id, { gatewayId: bobs.id }));
    notFound(() => updateMyModel(users.bob, mine.id, { label: 'pwned' }));
    notFound(() => deleteMyModel(users.bob, mine.id));
    assert.equal(claudeModelCatalog.lookupFor('my-model', as(users.alice))?.label, '我的');
  });

  test('validateUserModelInput:推荐 / 默认 / 可用人员 / 说明这些全员字段不收', () => {
    const write = validateUserModelInput({
      gatewayId: 5, modelId: 'm', recommended: true, isDefault: true, allowedUsers: [1], description: 'x', effortLevels: ['high'], effortDefault: 'high',
    }, null);
    assert.deepEqual(write, {
      gatewayId: 5, modelId: 'm', label: 'm', vendor: null, contextWindow: null, effortLevels: ['high'], effortDefault: 'high', enabled: true, sortOrder: 0,
    });
    for (const bad of [undefined, null, 0, -1, 1.5, 'abc']) {
      throwsCatalog(() => validateUserModelInput({ gatewayId: bad, modelId: 'm' }, null), 'BAD_GATEWAY');
    }
  });
});

/* ================================================================== */

describe('hq 选择器:能不能用(annotateModelAvailability)', () => {
  test('没有 key / 网关停用 / 网关不见了 → available false + 原因;非默认网关带 gatewayName;网关 0 一律可用', async () => {
    const users = await fresh();
    const g = createSharedGateway({ name: 'G 网关', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    const d = createSharedGateway({ name: 'D', baseUrl: 'https://d.example.com', authType: 'bearer', defaultKey: 'sk-d' }, users.boss);
    const k = createSharedGateway({ name: 'K', baseUrl: 'https://k.example.com', authType: 'bearer', defaultKey: 'sk-k' }, users.boss);
    claudeModelCatalog.create({ modelId: 'open-model', recommended: true }, users.boss);
    claudeModelCatalog.create({ modelId: 'g-model', gatewayId: g.id }, users.boss);
    claudeModelCatalog.create({ modelId: 'd-model', gatewayId: d.id }, users.boss);
    claudeModelCatalog.create({ modelId: 'k-model', gatewayId: k.id }, users.boss);
    claudeModelCatalog.create({ modelId: 'gone-model', gatewayId: k.id }, users.boss);
    updateSharedGateway(d.id, { enabled: false }, users.boss);
    getConnection().prepare('UPDATE model_catalog SET gateway_id = 999 WHERE model_id = ?').run('gone-model');
    invalidateCatalogCache();

    const bob = modelsDefinitionFor(as(users.bob));
    const open = option(bob, 'open-model')!;
    assert.equal(open.available, true);
    assert.equal(open.gatewayName, undefined);
    const gm = option(bob, 'g-model')!;
    assert.equal(gm.available, false);
    assert.equal(gm.gatewayName, 'G 网关');
    assert.ok(gm.unavailableReason);
    const dm = option(bob, 'd-model')!;
    assert.equal(dm.available, false);
    assert.equal(dm.gatewayName, 'D');
    assert.match(dm.unavailableReason ?? '', /停用/);
    const km = option(bob, 'k-model')!;
    assert.equal(km.available, true, '网关有默认 key');
    assert.equal(km.gatewayName, 'K');
    const gone = option(bob, 'gone-model')!;
    assert.equal(gone.available, false);
    assert.ok(gone.unavailableReason);
    for (const alias of bob.OPTIONS.filter((candidate) => candidate.group === 'alias')) assert.equal(alias.available, true, alias.value);

    // bob 填了自己的 key → G 上的模型对 bob 可用,对 alice 仍不可用
    setPersonalKey(g.id, users.bob, 'sk-bob-g', users.bob);
    assert.equal(option(modelsDefinitionFor(as(users.bob)), 'g-model')?.available, true);
    assert.equal(option(modelsDefinitionFor(as(users.alice)), 'g-model')?.available, false);
    // 选择器定义里不带任何 key
    assert.equal(JSON.stringify(modelsDefinitionFor(as(users.bob))).includes('sk-'), false);
  });

  test('私有模型:网关没 key → 不可用;填了 → 可用;gatewayName = 私有网关名', async () => {
    const users = await fresh();
    const p = createPrivateGateway(users.alice, { name: '我的网关', baseUrl: 'https://alice.example.com', authType: 'bearer' });
    createMyModel(users.alice, { gatewayId: p.id, modelId: 'my-model' });
    const before = option(modelsDefinitionFor(as(users.alice)), 'my-model')!;
    assert.equal(before.private, true);
    assert.equal(before.available, false);
    assert.equal(before.gatewayName, '我的网关');
    setPrivateGatewayKey(users.alice, p.id, 'sk-alice');
    assert.equal(option(modelsDefinitionFor(as(users.alice)), 'my-model')?.available, true);
  });

  test('DEFAULT 不可用 → 换成第一个可用的目录条目(推荐的优先);一个都没有 → default', async () => {
    const users = await fresh();
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    claudeModelCatalog.create({ modelId: 'g-default', gatewayId: g.id, isDefault: true, sortOrder: 1 }, users.boss);
    claudeModelCatalog.create({ modelId: 'plain', sortOrder: 2 }, users.boss);
    claudeModelCatalog.create({ modelId: 'recommended', recommended: true, sortOrder: 3 }, users.boss);
    assert.equal(claudeModelCatalog.buildModelsDefinition(as(users.bob)).DEFAULT, 'g-default');
    assert.equal(modelsDefinitionFor(as(users.bob)).DEFAULT, 'recommended');
    setPersonalKey(g.id, users.bob, 'sk-bob', users.bob);
    assert.equal(modelsDefinitionFor(as(users.bob)).DEFAULT, 'g-default', '有 key 了就留着');

    // 直接喂定义:没有可用的目录条目 → 'default'
    const definition: ProviderModelsDefinition = {
      OPTIONS: [
        { value: 'g-default', label: 'g', group: 'catalog', gatewayId: g.id },
        { value: 'default', label: 'Default', group: 'alias', gatewayId: 0 },
      ],
      DEFAULT: 'g-default',
    };
    assert.equal(annotateModelAvailability(definition, as(users.alice)).DEFAULT, 'default');
    assert.equal(annotateModelAvailability(definition, as(users.bob)).DEFAULT, 'g-default');
  });
});

/* ================================================================== */

describe('hq 子代理模型:按人、按网关筛(subagentModelEnv(policy, scope))', () => {
  test('看不见 / 在别的网关 / 下架 → 不写;别名只在主模型走网关 0 时写', async () => {
    const users = await fresh();
    const g = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer', defaultKey: 'sk-g' }, users.boss);
    claudeModelCatalog.create({ modelId: 'team-model', allowedUsers: [users.alice] }, users.boss);
    claudeModelCatalog.create({ modelId: 'g-model', gatewayId: g.id }, users.boss);
    const down = claudeModelCatalog.create({ modelId: 'down-model' }, users.boss);
    claudeModelCatalog.update(down.id, { enabled: false }, users.boss);

    const team = { model: 'team-model', force: true };
    assert.deepEqual(subagentModelEnv(team, { viewer: as(users.alice), gatewayId: 0 }), { CLAUDE_CODE_SUBAGENT_MODEL: 'team-model', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    assert.deepEqual(subagentModelEnv(team, { viewer: as(users.bob), gatewayId: 0 }), {}, 'bob 不在可用人员里');
    assert.deepEqual(subagentModelEnv(team, { viewer: as(users.boss, true), gatewayId: 0 }).CLAUDE_CODE_SUBAGENT_MODEL, 'team-model');
    assert.deepEqual(subagentModelEnv(team, { viewer: as(users.alice), gatewayId: g.id }), {}, '主模型在 G 上,子代理模型在网关 0 上');
    assert.deepEqual(subagentModelEnv(team), { CLAUDE_CODE_SUBAGENT_MODEL: 'team-model', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, '不给 scope = 不筛(老调用方)');

    const onG = { model: 'g-model', force: false };
    assert.deepEqual(subagentModelEnv(onG, { viewer: as(users.bob), gatewayId: 0 }), {});
    assert.deepEqual(subagentModelEnv(onG, { viewer: as(users.bob), gatewayId: g.id }), { CLAUDE_CODE_SUBAGENT_MODEL: 'g-model' });

    const alias = { model: 'haiku', force: false };
    assert.deepEqual(subagentModelEnv(alias, { viewer: as(users.bob), gatewayId: 0 }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
    assert.deepEqual(subagentModelEnv(alias, { viewer: as(users.bob), gatewayId: g.id }), {}, '别名落到网关 0 的模型,主模型在别的网关时不写');
    assert.deepEqual(subagentModelEnv(alias), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });

    assert.deepEqual(subagentModelEnv({ model: 'down-model', force: true }, { viewer: as(users.bob), gatewayId: 0 }), {});
    assert.deepEqual(subagentModelEnv({ model: null, force: false }, { viewer: as(users.bob), gatewayId: 0 }), {});
    assert.deepEqual(subagentModelEnv({ model: 'unknown-model', force: false }, { viewer: as(users.bob), gatewayId: 0 }), {});
  });
});

/* ================================================================== */

describe('hq 目录校验:gatewayId / allowedUsers', () => {
  test('validateCatalogInput:gatewayId 0 / "0" / null / "" = 网关 0;非正整数拒;allowedUsers 去重排序、非数组 / 非正整数 / 超 500 拒', () => {
    for (const zero of [0, '0', null, '']) assert.equal(validateCatalogInput({ modelId: 'm', gatewayId: zero }, null).gatewayId, null, String(zero));
    assert.equal(validateCatalogInput({ modelId: 'm', gatewayId: 3 }, null).gatewayId, 3);
    assert.equal(validateCatalogInput({ modelId: 'm', gatewayId: '3' }, null).gatewayId, 3);
    for (const bad of [-1, 1.5, 'abc', {}]) throwsCatalog(() => validateCatalogInput({ modelId: 'm', gatewayId: bad }, null), 'BAD_GATEWAY');

    assert.equal(validateCatalogInput({ modelId: 'm' }, null).allowedUsers, null);
    assert.equal(validateCatalogInput({ modelId: 'm', allowedUsers: null }, null).allowedUsers, null);
    assert.deepEqual(validateCatalogInput({ modelId: 'm', allowedUsers: [3, '1', 3, 2] }, null).allowedUsers, [1, 2, 3]);
    assert.deepEqual(validateCatalogInput({ modelId: 'm', allowedUsers: [] }, null).allowedUsers, []);
    for (const bad of ['1,2', 5, { 0: 1 }, [0], [-2], [1.5], ['x'], Array.from({ length: 501 }, (_, i) => i + 1)]) {
      throwsCatalog(() => validateCatalogInput({ modelId: 'm', allowedUsers: bad }, null), 'BAD_ALLOWED_USERS');
    }
  });

  test('create / update:gatewayId 必须是已存在的共享网关;allowedUsers 必须是已存在的用户;没给的沿用', async () => {
    const users = await fresh();
    const shared = createSharedGateway({ name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' }, users.boss);
    const priv = createPrivateGateway(users.alice, { name: 'mine', baseUrl: 'https://alice.example.com' });
    throwsCatalog(() => claudeModelCatalog.create({ modelId: 'm1', gatewayId: 4242 }, users.boss), 'BAD_GATEWAY');
    throwsCatalog(() => claudeModelCatalog.create({ modelId: 'm1', gatewayId: priv.id }, users.boss), 'BAD_GATEWAY');
    throwsCatalog(() => claudeModelCatalog.create({ modelId: 'm1', allowedUsers: [users.alice, 4242] }, users.boss), 'BAD_ALLOWED_USERS');
    assert.equal(claudeModelCatalog.listAll().length, 0, '校验失败不落库');

    const entry = claudeModelCatalog.create({ modelId: 'm1', gatewayId: shared.id, allowedUsers: [users.bob, users.alice] }, users.boss);
    assert.equal(entry.gatewayId, shared.id);
    assert.deepEqual(entry.allowedUsers, [users.alice, users.bob].sort((a, b) => a - b));
    assert.equal(entry.ownerUserId, null);

    const relabel = claudeModelCatalog.update(entry.id, { label: 'M1' }, users.boss).after;
    assert.equal(relabel.gatewayId, shared.id, '没给 gatewayId 就沿用');
    assert.deepEqual(relabel.allowedUsers, entry.allowedUsers, '没给 allowedUsers 就沿用');

    throwsCatalog(() => claudeModelCatalog.update(entry.id, { gatewayId: priv.id }, users.boss), 'BAD_GATEWAY');
    throwsCatalog(() => claudeModelCatalog.update(entry.id, { allowedUsers: [4242] }, users.boss), 'BAD_ALLOWED_USERS');
    const cleared = claudeModelCatalog.update(entry.id, { gatewayId: 0, allowedUsers: null }, users.boss).after;
    assert.equal(cleared.gatewayId, 0);
    assert.equal(cleared.allowedUsers, null);
    const row = getConnection().prepare('SELECT gateway_id, allowed_users FROM model_catalog WHERE id = ?').get(entry.id);
    assert.deepEqual(row, { gateway_id: null, allowed_users: null });
  });

  test('库里的 allowed_users 数组里有脏值:丢掉脏值,名单照旧生效', async () => {
    const users = await fresh();
    const entry = claudeModelCatalog.create({ modelId: 'm1', allowedUsers: [users.alice] }, users.boss);
    getConnection().prepare('UPDATE model_catalog SET allowed_users = ? WHERE id = ?').run(`[${users.alice}, "x", -3, 1.5]`, entry.id);
    invalidateCatalogCache();
    assert.deepEqual(claudeModelCatalog.get(entry.id)?.allowedUsers, [users.alice]);
    assert.equal(claudeModelCatalog.isAllowed('m1', as(users.bob)), false);
  });
});

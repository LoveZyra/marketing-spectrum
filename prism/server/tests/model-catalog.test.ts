import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, modelCatalogDb } from '@/modules/database/index.js';
import { REQUIRED_COLUMNS } from '@/modules/database/migrations.js';
import {
  CatalogValidationError,
  ModelNotAllowedError,
  claudeModelCatalog,
  invalidateCatalogCache,
  isModelAlias,
  seedModelCatalogOnce,
  validateCatalogInput,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import {
  allowedSkillWhetModels,
  disabledCatalogModelsIn,
  isSkillWhetModelAllowed,
  proposerEvaluatorConflict,
} from '@/modules/skillwhet/services/model-policy.js';

import {
  AUTO_COMPACT_MARGIN,
  detectModelVendor,
  formatContextWindow,
  isValidModelId,
  modelInitial,
} from '../../shared/modelVendors.js';
import { contextTooLargeForSwitch, modelWindowEnv, resolveContextWindowTokens } from '../claude-sdk.js';

/**
 * 模型目录:厂商识别与名字校验、增删改与默认回落、按 settings.json 播种与别名解析、模型闸口、
 * 上下文窗口与切换限制、SkillWhet 的模型策略。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const previousDatabasePath = process.env.DATABASE_PATH;
const previousHome = process.env.HOME;
let tempDir: string | null = null;

async function freshEnv(settings: Record<string, unknown> | null = null) {
  tempDir = await mkdtemp(path.join(tmpdir(), 'hn-catalog-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.HOME = tempDir;
  if (settings) {
    await mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  await initializeDatabase();
  invalidateCatalogCache();
}

beforeEach(() => invalidateCatalogCache());
afterEach(async () => {
  closeConnection();
  invalidateCatalogCache();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const GATEWAY_SETTINGS = {
  model: 'opus',
  env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4',
  },
};

describe('厂商识别与共用规则', () => {
  test('9 家各一条 + 顺序冲突 + 兜底', () => {
    const cases: Array<[string, string | null]> = [
      ['claude-sonnet-4-5', 'claude'], ['gpt-5.1', 'gpt'], ['o3', 'gpt'], ['o4-mini', 'gpt'], ['openai/gpt-oss-120b', 'gpt'],
      ['gemini-3-pro', 'gemini'], ['grok-4', 'grok'], ['xai/grok-4', 'grok'], ['glm-5.2', 'glm'], ['deepseek-v4', 'deepseek'],
      ['qwen3-coder-plus', 'qwen'], ['QwQ-32B', 'qwen'], ['kimi-k2.5', 'kimi'], ['moonshot-v1-128k', 'kimi'],
      ['doubao-seed-1.6', 'doubao'], ['ep-20250101-abc', 'doubao'],
      // 两家都在名字里:按顺序归 DeepSeek
      ['DeepSeek-R1-Distill-Qwen-32B', 'deepseek'],
      ['my-private-model', null], ['', null],
    ];
    for (const [name, vendor] of cases) assert.equal(detectModelVendor(name), vendor, name);
  });

  test('模型名字符集:不能以 - 开头、不能有空格 / shell 元字符;放行 / 与 @', () => {
    for (const ok of ['glm-5.2', 'deepseek/deepseek-v4', 'glm-5.2@2026-09', 'claude-sonnet-4-5[1m]', 'us.anthropic.claude:1']) {
      assert.equal(isValidModelId(ok), true, ok);
    }
    for (const bad of ['-m', '/abs', '@x', 'a b', 'a;b', 'a$b', 'x'.repeat(81), '']) {
      assert.equal(isValidModelId(bad), false, bad);
    }
  });

  test('窗口角标与首字母', () => {
    assert.equal(formatContextWindow(128_000), '128K');
    assert.equal(formatContextWindow(1_000_000), '1M');
    assert.equal(formatContextWindow(1_500_000), '1.5M');
    assert.equal(formatContextWindow(null), null);
    assert.equal(modelInitial('my-model'), 'M');
  });
});

describe('目录:校验、增删改、默认回落', () => {
  test('校验:字符集 / 别名 / 窗口下限 / 默认档位 / 下架不能是默认', () => {
    const bad = (input: Record<string, unknown>, code: string) => {
      assert.throws(() => validateCatalogInput(input, null), (error: unknown) => error instanceof CatalogValidationError && error.code === code);
    };
    bad({ modelId: '-x' }, 'BAD_MODEL_ID');
    bad({ modelId: 'a b' }, 'BAD_MODEL_ID');
    bad({ modelId: 'sonnet' }, 'MODEL_ID_IS_ALIAS');
    bad({ modelId: 'glm-5.2', contextWindow: 99_999 }, 'BAD_CONTEXT_WINDOW');
    bad({ modelId: 'glm-5.2', effortLevels: ['ultra'] }, 'BAD_EFFORT');
    bad({ modelId: 'glm-5.2', effortLevels: ['low'], effortDefault: 'high' }, 'BAD_EFFORT');
    bad({ modelId: 'glm-5.2', vendor: 'acme' }, 'BAD_VENDOR');
    bad({ modelId: 'glm-5.2', enabled: false, isDefault: true }, 'DEFAULT_MUST_BE_ENABLED');
    const ok = validateCatalogInput({ modelId: 'glm-5.2', contextWindow: 128_000, effortLevels: ['high', 'low', 'high'] }, null);
    assert.deepEqual(ok.effortLevels, ['low', 'high']);
    assert.equal(ok.label, 'glm-5.2');
  });

  test('增删改 + 缓存随写失效 + is_default 只许一条', async () => {
    await freshEnv();
    const a = claudeModelCatalog.create({ modelId: 'glm-5.2', label: 'GLM 5.2', contextWindow: 128_000, recommended: true, isDefault: true }, 1);
    const b = claudeModelCatalog.create({ modelId: 'deepseek-v4', isDefault: true }, 1);
    assert.equal(a.vendor, 'glm');
    assert.equal(b.vendor, 'deepseek');
    assert.equal(claudeModelCatalog.get(a.id)?.isDefault, false, '新的默认把旧的清掉');
    assert.equal(claudeModelCatalog.defaultModel(), 'deepseek-v4');
    assert.throws(() => claudeModelCatalog.create({ modelId: 'glm-5.2' }, 1), (error: unknown) => error instanceof CatalogValidationError && error.status === 409);

    // 下架默认那条 → 回落到第一条上架的推荐
    claudeModelCatalog.update(b.id, { enabled: false }, 1);
    assert.equal(claudeModelCatalog.get(b.id)?.isDefault, false, '下架顺手取消默认');
    assert.equal(claudeModelCatalog.defaultModel(), 'glm-5.2');
    // 推荐也没了 → 别名 default
    claudeModelCatalog.update(a.id, { recommended: false }, 1);
    assert.equal(claudeModelCatalog.defaultModel(), 'default');

    // 手动指定厂商优先于自动识别;设回 auto 恢复
    assert.equal(claudeModelCatalog.update(a.id, { vendor: 'qwen' }, 1).after.vendor, 'qwen');
    assert.equal(claudeModelCatalog.update(a.id, { vendor: 'auto' }, 1).after.vendor, 'glm');

    assert.equal(claudeModelCatalog.remove(a.id)?.modelId, 'glm-5.2');
    assert.equal(claudeModelCatalog.lookup('glm-5.2'), null);
    assert.equal(modelCatalogDb.count(), 1);
  });

  test('闸口:别名组 / 上架的放行;下架的、不在目录里的拒(MODEL_NOT_ALLOWED)', async () => {
    await freshEnv();
    const entry = claudeModelCatalog.create({ modelId: 'kimi-k2.5' }, 1);
    for (const alias of ['default', 'sonnet', 'opus[1m]', 'haiku', 'fable', '', null, undefined]) {
      assert.equal(claudeModelCatalog.isAllowed(alias), true, String(alias));
      assert.equal(isModelAlias(alias), true);
    }
    assert.equal(claudeModelCatalog.isAllowed('kimi-k2.5'), true);
    assert.equal(claudeModelCatalog.isAllowed('no-such-model'), false);
    claudeModelCatalog.update(entry.id, { enabled: false }, 1);
    assert.equal(claudeModelCatalog.isAllowed('kimi-k2.5'), false);
    assert.throws(() => claudeModelCatalog.assertAllowed('kimi-k2.5'), (error: unknown) => (
      error instanceof ModelNotAllowedError && error.code === 'MODEL_NOT_ALLOWED' && error.prismModelRejected === true
    ));
  });

  test('给选择器的定义:目录条目(group=catalog,带厂商 / 窗口 / 档位)+ 别名组;DEFAULT 按回落', async () => {
    await freshEnv();
    claudeModelCatalog.create({ modelId: 'glm-5.2', label: 'GLM 5.2', contextWindow: 128_000, effortLevels: ['low', 'high'], effortDefault: 'high', recommended: true, sortOrder: 20 }, 1);
    claudeModelCatalog.create({ modelId: 'qwen3-max', sortOrder: 10 }, 1);
    claudeModelCatalog.create({ modelId: 'retired-model', enabled: false }, 1);
    const def = claudeModelCatalog.buildModelsDefinition();
    const catalog = def.OPTIONS.filter((option) => option.group === 'catalog');
    assert.deepEqual(catalog.map((option) => option.value), ['qwen3-max', 'glm-5.2'], '按 sort_order,下架的不在');
    const glm = catalog.find((option) => option.value === 'glm-5.2')!;
    assert.equal(glm.vendor, 'glm');
    assert.equal(glm.contextWindow, 128_000);
    assert.equal(glm.recommended, true);
    assert.deepEqual(glm.effort, { default: 'high', values: [{ value: 'low' }, { value: 'high' }] });
    const aliases = def.OPTIONS.filter((option) => option.group === 'alias').map((option) => option.value);
    for (const alias of ['default', 'sonnet', 'opus', 'haiku']) assert.ok(aliases.includes(alias), alias);
    assert.equal(def.DEFAULT, 'glm-5.2', '没有 is_default → 第一条上架的推荐');
  });

  test('表结构:REQUIRED_COLUMNS 登记了新表;is_default 的部分唯一索引真的挡住第二条', async () => {
    await freshEnv();
    assert.ok(REQUIRED_COLUMNS.model_catalog?.includes('context_window'));
    const db = getConnection();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'model_catalog'").all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === 'idx_model_catalog_single_default'));
    db.prepare("INSERT INTO model_catalog (model_id, label, is_default, created_at, updated_at) VALUES ('a', 'a', 1, 'x', 'x')").run();
    assert.throws(() => db.prepare("INSERT INTO model_catalog (model_id, label, is_default, created_at, updated_at) VALUES ('b', 'b', 1, 'x', 'x')").run());
  });
});

describe('播种与别名解析', () => {
  test('按 settings.json 播一次:去重、顶层 model(别名)解析成真名设默认;删光后不再播', async () => {
    await freshEnv(GATEWAY_SETTINGS);
    const first = await seedModelCatalogOnce();
    assert.equal(first.seeded, true);
    assert.deepEqual(first.added.sort(), ['deepseek-v4', 'glm-5.2']);
    assert.equal(claudeModelCatalog.defaultModel(), 'glm-5.2', 'model: "opus" → glm-5.2');
    // 档位跟着第一个映射到它的别名走(glm-5.2 ← default),播种后默认模型的档位 chip 不会消失
    const glm = claudeModelCatalog.lookup('glm-5.2')!;
    assert.deepEqual(glm.effortLevels, ['low', 'medium', 'high', 'max']);
    assert.equal(glm.effortDefault, 'high');
    assert.ok(claudeModelCatalog.lookup('deepseek-v4')!.effortLevels.length > 0);
    for (const entry of claudeModelCatalog.listAll()) claudeModelCatalog.remove(entry.id);
    const second = await seedModelCatalogOnce();
    assert.equal(second.seeded, false, 'root 清空之后不会被自动播回来');
    assert.equal(modelCatalogDb.count(), 0);
  });

  test('resolveEntry / contextWindowFor:别名先换真名再查目录', async () => {
    await freshEnv(GATEWAY_SETTINGS);
    claudeModelCatalog.create({ modelId: 'glm-5.2', contextWindow: 128_000 }, 1);
    const viaAlias = await claudeModelCatalog.resolveEntry('opus');
    assert.equal(viaAlias.realModel, 'glm-5.2');
    assert.equal(viaAlias.entry?.modelId, 'glm-5.2');
    assert.equal(await claudeModelCatalog.contextWindowFor('opus'), 128_000);
    assert.equal(await claudeModelCatalog.contextWindowFor('default'), 128_000, 'default → model: opus → glm-5.2');
    assert.equal(await claudeModelCatalog.contextWindowFor('glm-5.2'), 128_000);
    assert.equal(await claudeModelCatalog.contextWindowFor('sonnet'), null, 'deepseek-v4 不在目录里');
  });
});

describe('窗口与切换', () => {
  test('modelWindowEnv:有窗口写 CLAUDE_CODE_MAX_CONTEXT_TOKENS,没有就删掉继承来的', () => {
    assert.deepEqual(modelWindowEnv(128_000), { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000' });
    assert.deepEqual(modelWindowEnv(null), { CLAUDE_CODE_MAX_CONTEXT_TOKENS: undefined });
  });

  test('切到窗口更小的模型、上下文已过它的压缩线 → MODEL_CONTEXT_TOO_LARGE;其余放行', () => {
    const runtime = { currentModel: 'deepseek-v4', lastContextUsage: { totalTokens: 120_000 } };
    const line = 128_000 - AUTO_COMPACT_MARGIN;
    const error = contextTooLargeForSwitch(runtime, { model: 'glm-5.2', contextWindow: 128_000 });
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'MODEL_CONTEXT_TOO_LARGE');
    assert.equal((error as Error & { prismModelRejected?: boolean }).prismModelRejected, true);
    assert.match(error!.message, new RegExp(String(line)));
    assert.equal(contextTooLargeForSwitch(runtime, { model: 'deepseek-v4', contextWindow: 128_000 }), null, '同一个模型');
    assert.equal(contextTooLargeForSwitch(runtime, { model: 'glm-5.2', contextWindow: null }), null, '目录没填窗口');
    assert.equal(contextTooLargeForSwitch({ ...runtime, lastContextUsage: { totalTokens: line - 1 } }, { model: 'glm-5.2', contextWindow: 128_000 }), null);
    assert.equal(contextTooLargeForSwitch({ currentModel: 'x' }, { model: 'glm-5.2', contextWindow: 128_000 }), null, '没有实测用量');
    // 目标窗口不比现在小 → 放行(别名 sonnet → 同一个 128K 模型,留在原地也一样要压)
    const onAlias = { currentModel: 'sonnet', contextWindow: 128_000, lastContextUsage: { totalTokens: 100_000, maxTokens: 128_000 } };
    assert.equal(contextTooLargeForSwitch(onAlias, { model: 'glm-5.2', contextWindow: 128_000 }), null);
    assert.ok(contextTooLargeForSwitch(onAlias, { model: 'small-model', contextWindow: 110_000 }), '更小的才拒');
  });

  test('用量环分母优先级:实测 → runtime 的目录窗口 → 回复模型名查目录 → CONTEXT_WINDOW → claude-* → 200000', async () => {
    await freshEnv();
    claudeModelCatalog.create({ modelId: 'kimi-k2.5', contextWindow: 256_000 }, 1);
    const previous = process.env.CONTEXT_WINDOW;
    delete process.env.CONTEXT_WINDOW;
    try {
      assert.equal(resolveContextWindowTokens({ lastContextUsage: { maxTokens: 95_000 }, contextWindow: 128_000 }, null), 95_000);
      assert.equal(resolveContextWindowTokens({ contextWindow: 128_000 }, null), 128_000);
      assert.equal(resolveContextWindowTokens(null, { message: { model: 'kimi-k2.5' } }), 256_000);
      assert.equal(resolveContextWindowTokens({ currentModel: 'kimi-k2.5' }, null), 256_000);
      assert.equal(resolveContextWindowTokens(null, { message: { model: 'claude-opus-4' } }), 200_000);
      assert.equal(resolveContextWindowTokens(null, { message: { model: 'unknown-x' } }), 200_000);
      process.env.CONTEXT_WINDOW = '160000';
      assert.equal(resolveContextWindowTokens(null, { message: { model: 'unknown-x' } }), 160_000, '只作兜底');
      assert.equal(resolveContextWindowTokens({ contextWindow: 128_000 }, null), 128_000, '不再压住目录窗口');
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_WINDOW;
      else process.env.CONTEXT_WINDOW = previous;
    }
  });

  test('源码:闸口在四条 SDK 路径上;窗口进签名;/compact 被压缩线挡住时用当前模型跑', async () => {
    const source = await readFile(path.join(here, '..', 'claude-sdk.js'), 'utf8');
    assert.equal((source.match(/await modelRuntimeSettings\(/g) ?? []).length, 4, '一次性 / 常驻 / loop / 预热');
    assert.match(source, /contextWindow: options\.contextWindow \?\? null,\n(?:.*\n){0,12}?\s*subagent: /, 'persistentRuntimeSignature 带窗口(ho 起后面还跟着子代理模型)');
    const body = source.slice(source.indexOf('async function runtimeForSend('), source.indexOf('if (runtime && runtime.signature !== signature)'));
    const guard = body.indexOf('contextTooLargeForSwitch(guardSubject, options)');
    assert.ok(guard > 0);
    assert.ok(guard < body.indexOf('runtime.pendingToolUses.size > 0'), '在任何重建分支之前');
    assert.ok(guard < body.indexOf('currentUserSettingsMtimeMs()'));
    assert.match(body, /if \(!options\.compactCommand\) throw tooLarge;/);
    // runtime 被回收之后也要判:用 dispose 时记下的那份上下文
    assert.match(body, /const guardSubject = runtime \?\? \(requestedSessionId \? lastRuntimeContextBySession\.get\(requestedSessionId\)/);
    const dispose = source.slice(source.indexOf('async function disposePersistentRuntime('));
    // dispose 与进程自己退出两处共用 finalizeRuntime,由它记下这份上下文
    assert.match(dispose.slice(0, 400), /finalizeRuntime\(runtime\);/);
    const finalize = source.slice(source.indexOf('function finalizeRuntime('), source.indexOf('async function disposePersistentRuntime('));
    assert.match(finalize, /rememberRuntimeContext\(runtime\);/);
    // 别的路(终端接管 / 一次性调用)接着走这段对话时,记下的那份作废
    const release = source.slice(source.indexOf('async function releaseClaudeSession('), source.indexOf('async function prewarmClaudeSession('));
    assert.equal((release.match(/forgetRemembered\(\);/g) ?? []).length, 2);
    assert.match(source, /compactCommand: isCompactCommand\(command\)/);
  });
});

describe('SkillWhet 模型策略', () => {
  const budget = (list: string[] | null) => ({ modelAllowlist: list ?? ['haiku', 'sonnet', 'opus'], modelAllowlistConfigured: list !== null });

  test('非 root:配了白名单只认它;没配 = 三个别名 + 目录上架条目;root 不限但仍校验字符集', async () => {
    await freshEnv();
    claudeModelCatalog.create({ modelId: 'glm-5.2' }, 1);
    claudeModelCatalog.create({ modelId: 'retired', enabled: false }, 1);
    assert.deepEqual(allowedSkillWhetModels(budget(null), false), ['haiku', 'sonnet', 'opus', 'glm-5.2']);
    assert.deepEqual(allowedSkillWhetModels(budget(['haiku', 'deepseek/v4']), false), ['haiku', 'deepseek/v4']);
    assert.equal(allowedSkillWhetModels(budget(null), true), null);
    assert.equal(isSkillWhetModelAllowed('glm-5.2', budget(null), false), true);
    assert.equal(isSkillWhetModelAllowed('retired', budget(null), false), false);
    assert.equal(isSkillWhetModelAllowed('glm-5.2', budget(['haiku']), false), false);
    assert.equal(isSkillWhetModelAllowed('anything-goes', budget(null), true), true);
    assert.equal(isSkillWhetModelAllowed('-rm', budget(null), true), false);
  });

  test('评估 ≠ 提议按真名比:opus(→ glm-5.2)与 glm-5.2 是同一个', async () => {
    await freshEnv(GATEWAY_SETTINGS);
    assert.match(String(await proposerEvaluatorConflict({ fast_model: 'haiku', slow_model: 'glm-5.2', eval_model: 'opus' })), /glm-5\.2/);
    assert.equal(await proposerEvaluatorConflict({ fast_model: 'haiku', slow_model: 'glm-5.2', eval_model: 'kimi-k2.5' }), null);
    // haiku 与 sonnet 都映射到 deepseek-v4:默认的 fast=haiku 与 eval=sonnet 冲突
    assert.match(String(await proposerEvaluatorConflict({ eval_model: 'sonnet' })), /deepseek-v4/);
  });

  test('夜训:配置里的模型在目录里被下架 → 列出来(调度器据此跳过这一晚)', async () => {
    await freshEnv();
    const entry = claudeModelCatalog.create({ modelId: 'glm-5.2' }, 1);
    assert.deepEqual(disabledCatalogModelsIn({ fast_model: 'haiku', slow_model: 'glm-5.2', eval_model: 'never-in-catalog' }), []);
    claudeModelCatalog.update(entry.id, { enabled: false }, 1);
    assert.deepEqual(disabledCatalogModelsIn({ fast_model: 'haiku', slow_model: 'glm-5.2' }), ['slow_model=glm-5.2']);
  });
});

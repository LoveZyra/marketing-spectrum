import express, { type Request, type Response } from 'express';

import {
  isProbeRunning,
  probeModelMappings,
  readModelMappingsMeta,
} from '@/modules/providers/list/claude/claude-model-probe.service.js';
import { readAliasConfigMappings } from '@/modules/providers/list/claude/claude-settings-mapping.service.js';
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
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { assertViewerMayCreateSessionAt } from '@/modules/providers/services/session-project-path-guard.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
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
import { sessionsDb } from '@/modules/database/index.js';
import {
  renderSessionExport,
  type ExportableMessage,
} from '@/modules/providers/services/session-export.service.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * 自定义网关的主机名,给前端决定要不要提示"卡片描述仅供参考"。
 * 只暴露 host,不暴露完整 URL —— 路径里可能带租户 id 之类不该给所有登录用户看的东西。
 */
const readGatewayHost = (): string | null => {
  const raw = process.env.ANTHROPIC_BASE_URL;
  if (!raw || !raw.trim()) return null;
  try {
    return new URL(raw.trim()).host || null;
  } catch {
    return raw.trim();
  }
};

const router = express.Router();

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
    res.json(createApiSuccessResponse({ provider, models: result.models, cache: result.cache }));
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

    res.json(createApiSuccessResponse(await writeModelConfig(update)));
  }),
);

router.get(
  '/:provider/model-mappings',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider); // 目前只有 claude,守卫同其它路由
    const meta = await readModelMappingsMeta();
    // 配置层映射:每次现读 settings.json —— 改完配置这里立即是新值,不依赖实测。
    const definition = await providerModelsService.getProviderModels('claude');
    const configMappings = await readAliasConfigMappings(
      definition.models.OPTIONS.map((option) => option.value),
    );
    res.json(createApiSuccessResponse({
      mappings: meta.mappings,
      // settings.json 在上次实测后改过 → 实测值可能过期。前端据此提示重测,
      // chip 停显过期真名(回退到 configMappings)。
      stale: meta.stale,
      configMappings,
      probing: isProbeRunning(),
      gatewayHost: readGatewayHost(),
    }));
  }),
);

router.post(
  '/:provider/model-mappings/probe',
  asyncHandler(async (req: Request, res: Response) => {
    parseProvider(req.params.provider);
    const definition = await providerModelsService.getProviderModels('claude');
    const aliases = definition.models.OPTIONS.map((option) => option.value);
    // 并发点击加入同一次探测(service 内单飞),不会拉起第二排 CLI 进程。
    await probeModelMappings(aliases);
    // 刚落盘的实测自带最新 settings 指纹,这里重读一次拿权威的 stale(通常 false)。
    const meta = await readModelMappingsMeta();
    const configMappings = await readAliasConfigMappings(aliases);
    res.json(createApiSuccessResponse({
      mappings: meta.mappings,
      stale: meta.stale,
      configMappings,
      gatewayHost: readGatewayHost(),
    }));
  }),
);

/**
 * The session's effective model.
 *
 * Exists so the composer can show which model is actually running. Until this
 * route, the only way to find out was to run /models and read the modal, which
 * meant a switch had no visible effect anywhere once that modal closed.
 */
router.get(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    // 兄弟路由(delete/rename/messages)都过这道门,这两条当初漏了 —— 读会泄露
    // 别人会话的当前模型,写能替别人的会话改下一轮用的模型。
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const active = await providerModelsService.getCurrentActiveModel(provider, sessionId);
    res.json(createApiSuccessResponse({ provider, sessionId, model: active.model }));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const payload = parseChangeActiveModelPayload(req.body);
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
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input);
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const result = await providerSkillsService.removeProviderSkill(provider, {
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const scope = parseMcpScope(req.query.scope);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath });
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
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
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// `POST /mcp/servers/global` was removed: with Claude the only provider it wrote
// to exactly the same file as the per-provider add route above, minus `local`
// scope — the same feature with a hole in it. (Its old consumer, browser-use,
// is gone too.)

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
    // dz:路径合法(挡越界)+ 项目可见(挡越权),与任务路由同一道门。
    // 没有它,任何登录用户 POST 一个 projectPath:"/" 就成了根目录项目的 owner
    // (实测),文件树、聊天 cwd 随之全盘放开。见 session-project-path-guard。
    await assertViewerMayCreateSessionAt(readRequestViewer(req), projectPath);
    // 建会话的人就是项目的 owner。不传的话项目 owner 为 NULL,而 NULL 的语义是
    // "公共项目" —— 新会话所在的目录会直接出现在所有人的侧栏里。
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
    // E10:分页 + 可见性下推 SQL。`sessions` 字段名不变,老前端照常拿到数组;
    // 新增的 total/hasMore 让界面能说清"还有多少条没列出来"。
    const page = sessionsService.listArchivedSessions(readRequestViewer(req), {
      limit: parseOptionalCountQuery(req.query.limit, 'limit'),
      offset: parseOptionalCountQuery(req.query.offset, 'offset'),
    });
    res.json(createApiSuccessResponse(page));
  }),
);

/**
 * F8:批量归档 / 恢复 / 删除。逐条鉴权(看不见的静默跳过,不报错 —— 报错等于
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

    const result = await sessionsService.bulkSessionAction(ids, action, readRequestViewer(req));
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * F8:清空回收站 —— 永久删除**当前访问者看得见的**归档会话。
 * `?olderThanDays=N` 只清超过 N 天的(给"保留最近一周"这种用法)。
 */
router.delete(
  '/sessions/archived',
  asyncHandler(async (req: Request, res: Response) => {
    const olderThanDays = parseOptionalCountQuery(req.query.olderThanDays, 'olderThanDays');
    const result = await sessionsService.emptyArchivedSessions(readRequestViewer(req), { olderThanDays });
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
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
    // F12:默认不带工具过程(多数导出是给人读的);要排查"它当时改了哪个文件"
    // 时才打开,而不是替谁做决定。
    const includeTools = parseOptionalBooleanQuery(req.query.includeTools, 'includeTools') ?? false;

    const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
    const dbSession = sessionsDb.getSessionById(sessionId);
    const title = (dbSession?.custom_name && String(dbSession.custom_name).trim()) || `会话 ${sessionId.slice(0, 8)}`;

    const rendered = renderSessionExport(
      {
        title,
        sessionId,
        exportedAt: new Date().toISOString(),
        messages: history.messages as ExportableMessage[],
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

/**
 * dq:右侧工作面板的数据帧(任务清单 + 产出文件原料)。
 * 全量历史滤出 TodoWrite/TaskCreate/TaskUpdate/Write 工具帧;折叠在前端做。
 */
router.get(
  '/sessions/:sessionId/work-frames',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    sessionsService.assertViewerCanSeeSession(sessionId, readRequestViewer(req));
    // ec:dw 给 collectWorkFrames 加了 `truncated`(帧数触顶、较早的帧未下发),
    // 前端 useSessionWorkFrames 也接了 —— 但这里当时只透传了两个字段,提示永远
    // 亮不起来。三个字段一起下发。
    // ej:多带一个 turnOutputs(助手回答 id → 这一轮写出的文件)。对话正文下面
    // 那张产出卡直接读它 —— 由服务端从全量日志算好、随会话一次到达,不再由前端
    // 从"当前加载到的窗口"现推(那会随历史补齐而变)。
    const { frames, revertedPaths, truncated, turnOutputs } = await sessionsService.fetchWorkFrames(sessionId);
    res.json(createApiSuccessResponse({ frames, revertedPaths, turnOutputs, truncated: truncated === true }));
  }),
);

/**
 * 铸一张搜索用的 SSE 票据。
 *
 * EventSource 没法带 Authorization 头,所以前端先用普通(带 Bearer 头的)POST
 * 换一张短命票据,再拿它连 `/search/sessions` —— JWT 不进 URL。
 */
router.post('/search/ticket', (req: Request, res: Response) => {
  const viewer = (req as Request & { user?: { id?: number } }).user;
  if (viewer?.id == null) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({ ticket: issueSseTicket(viewer.id) });
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
    console.error('Error searching conversations:', error);
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

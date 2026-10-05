import express, { type Request, type Response } from 'express';

import { appConfigDb, auditLogDb, userDb, type AuditEvent } from '@/modules/database/index.js';
import {
  CatalogValidationError,
  PRIVATE_GATEWAYS_KEY,
  modelViewerFor,
  privateGatewaysEnabled,
  type ModelViewer,
} from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import {
  DEFAULT_GATEWAY_ID,
  GatewayError,
  clearPersonalKey,
  createMyModel,
  createPrivateGateway,
  createSharedGateway,
  defaultGatewayView,
  deleteMyModel,
  deletePrivateGateway,
  deleteSharedGateway,
  listAllPrivateGatewayViews,
  listGatewayKeyHolders,
  listMyModels,
  listSharedGatewayViews,
  myGatewayViews,
  resolveTurnGateway,
  setPersonalKey,
  setPrivateGatewayKey,
  setSharedGatewayDefaultKey,
  testGatewayFor,
  testUnsavedGateway,
  updateMyModel,
  updatePrivateGateway,
  updateSharedGateway,
} from '@/modules/providers/list/claude/claude-gateways.service.js';
import { probeCatalogModel } from '@/modules/providers/list/claude/claude-model-catalog-probe.service.js';
import { clientIp } from '@/shared/client-ip.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * hq:**模型网关与 key 的接口。**
 *
 * - `/:provider/gateways*` —— root:共享网关(增删改、默认 key、替人填 key)、私有网关总开关、看全部私有网关;
 * - `/:provider/my-gateways*`、`/:provider/my-models*` —— 任何登录用户:自己的个人 key、自己的私有网关与私有模型。
 *
 * **key 只进不出**:任何响应里都没有明文,最多是末四位(本人 / root 认 key 用)。审计只记"谁、对哪个网关、
 * 给谁设 / 清了 key",不记值。
 */

type RequestUser = { id?: number; username?: string; isRoot?: boolean };
const readUser = (req: Request): RequestUser | null => (req as Request & { user?: RequestUser }).user ?? null;

const requireUser = (req: Request): { id: number; username: string; isRoot: boolean } => {
  const user = readUser(req);
  if (!user || typeof user.id !== 'number') throw new AppError('Unauthorized', { code: 'UNAUTHORIZED', statusCode: 401 });
  return { id: user.id, username: user.username ?? '', isRoot: user.isRoot === true };
};

const requireRoot = (req: Request) => {
  const user = requireUser(req);
  if (!user.isRoot) throw new AppError('只有 root 可以管理共享网关', { code: 'GATEWAY_FORBIDDEN', statusCode: 403 });
  return user;
};

const viewerOf = (user: { id: number; username: string }): ModelViewer => modelViewerFor(user.id, user.username);

const parseProviderParam = (value: unknown): void => {
  if (value !== 'claude') throw new AppError('只支持 claude', { code: 'BAD_PROVIDER', statusCode: 400 });
};

const parseId = (value: unknown, { allowZero = false } = {}): number => {
  const id = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isInteger(id) || id < (allowZero ? 0 : 1)) throw new AppError('id 不对', { code: 'BAD_ID', statusCode: 400 });
  return id;
};

/** 服务层的校验错误 → AppError(状态码与 code 原样)。 */
const asAppError = (error: unknown): unknown => {
  if (error instanceof GatewayError || error instanceof CatalogValidationError) {
    return new AppError(error.message, { code: error.code, statusCode: error.status });
  }
  return error;
};

const run = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    throw asAppError(error);
  }
};

const runAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    throw asAppError(error);
  }
};

/** `targetUserId`:root 替某个人设 / 清 key 时填 —— 那个人在「与我有关」的审计视图里看得到(与 admin 路由同一约定)。 */
const audit = (
  req: Request,
  actor: { id: number; username: string },
  event: AuditEvent,
  detail: Record<string, unknown>,
  targetUserId: number | null = null,
) => {
  auditLogDb.record({
    userId: actor.id,
    username: actor.username,
    event,
    ip: clientIp(req) ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    detail: JSON.stringify(detail).slice(0, 1000),
    targetUserId,
  });
};

export const claudeGatewaysRouter = express.Router();
const router = claudeGatewaysRouter;

/* ============================ root:共享网关 ============================ */

router.get(
  '/:provider/gateways',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    res.json(createApiSuccessResponse({
      defaultGateway: await defaultGatewayView(viewerOf(root)),
      gateways: listSharedGatewayViews(),
      privateGateways: listAllPrivateGatewayViews(),
      allowPrivate: privateGatewaysEnabled(),
      users: userDb.listBasicUsers(),
    }));
  }),
);

router.post(
  '/:provider/gateways',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const view = run(() => createSharedGateway((req.body ?? {}) as Record<string, unknown>, root.id));
    audit(req, root, 'model_gateway_created', { id: view.id, name: view.name, host: view.host, authType: view.authType, hasDefaultKey: view.hasDefaultKey });
    res.status(201).json(createApiSuccessResponse({ gateway: view }));
  }),
);

router.patch(
  '/:provider/gateways/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id);
    const { before, after } = run(() => updateSharedGateway(id, (req.body ?? {}) as Record<string, unknown>, root.id));
    audit(req, root, 'model_gateway_updated', {
      id, name: after.name, changed: Object.keys(req.body ?? {}),
      ...(before.host !== after.host ? { hostBefore: before.host, hostAfter: after.host } : {}),
      ...(before.enabled !== after.enabled ? { enabled: after.enabled } : {}),
    });
    res.json(createApiSuccessResponse({ gateway: after }));
  }),
);

router.delete(
  '/:provider/gateways/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id);
    const removed = run(() => deleteSharedGateway(id));
    audit(req, root, 'model_gateway_deleted', { id, name: removed.name, host: removed.host });
    res.json(createApiSuccessResponse({ removed: id }));
  }),
);

/** 默认 key:PUT `{ key }` 设 / 换;DELETE 清。 */
router.put(
  '/:provider/gateways/:id/default-key',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id);
    const rawKey = (req.body ?? {}).key;
    const view = run(() => setSharedGatewayDefaultKey(id, rawKey, root.id));
    // 空 key = 清除(与 DELETE 同义),审计按清除记
    audit(req, root, rawKey === null || rawKey === '' ? 'gateway_default_key_cleared' : 'gateway_default_key_set', { gatewayId: id, gateway: view.name });
    res.json(createApiSuccessResponse({ gateway: view }));
  }),
);

router.delete(
  '/:provider/gateways/:id/default-key',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id);
    const view = run(() => setSharedGatewayDefaultKey(id, null, root.id));
    audit(req, root, 'gateway_default_key_cleared', { gatewayId: id, gateway: view.name });
    res.json(createApiSuccessResponse({ gateway: view }));
  }),
);

/** 测试连接:body 里带 key 就用它(保存前先测),否则用 root 自己会用的那把。id 0 = 默认网关。 */
router.post(
  '/:provider/gateways/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id, { allowZero: true });
    const result = await runAsync(() => testGatewayFor(id, viewerOf(root), (req.body ?? {}).key));
    res.json(createApiSuccessResponse({ result }));
  }),
);

/** 还没保存的网关(地址 + key 直接测)。root 与允许私有网关时的普通用户都能用。 */
router.post(
  '/:provider/gateways-test',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    if (!user.isRoot && !privateGatewaysEnabled()) {
      throw new AppError('管理员关掉了私有网关', { code: 'PRIVATE_GATEWAYS_DISABLED', statusCode: 403 });
    }
    const result = await runAsync(() => testUnsavedGateway((req.body ?? {}) as Record<string, unknown>));
    res.json(createApiSuccessResponse({ result }));
  }),
);

/** 某个网关(含 0)上谁填了个人 key —— root 看(只有末四位)。 */
router.get(
  '/:provider/gateways/:id/keys',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    requireRoot(req);
    const id = parseId(req.params.id, { allowZero: true });
    res.json(createApiSuccessResponse({ keys: run(() => listGatewayKeyHolders(id)) }));
  }),
);

/** root 替某个人填 / 清个人 key。 */
router.put(
  '/:provider/gateways/:id/keys/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id, { allowZero: true });
    const userId = parseId(req.params.userId);
    run(() => setPersonalKey(id, userId, (req.body ?? {}).key, root.id));
    audit(req, root, 'gateway_key_set_by_root', { gatewayId: id, forUserId: userId, forUsername: userDb.getUserById(userId)?.username ?? null }, userId);
    res.json(createApiSuccessResponse({ keys: run(() => listGatewayKeyHolders(id)) }));
  }),
);

router.delete(
  '/:provider/gateways/:id/keys/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const id = parseId(req.params.id, { allowZero: true });
    const userId = parseId(req.params.userId);
    const cleared = run(() => clearPersonalKey(id, userId, root.id));
    if (cleared) {
      audit(req, root, 'gateway_key_cleared_by_root', { gatewayId: id, forUserId: userId, forUsername: userDb.getUserById(userId)?.username ?? null }, userId);
    }
    res.json(createApiSuccessResponse({ keys: run(() => listGatewayKeyHolders(id)) }));
  }),
);

/** 私有网关总开关(关掉后:私有模型不再出现在选择器里、发不出;已有的数据保留,本人仍可删)。 */
router.put(
  '/:provider/gateways-settings',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const root = requireRoot(req);
    const allow = (req.body ?? {}).allowPrivate;
    if (typeof allow !== 'boolean') throw new AppError('allowPrivate 必须是 true / false', { code: 'BAD_FIELD', statusCode: 400 });
    appConfigDb.set(PRIVATE_GATEWAYS_KEY, allow ? '1' : '0');
    audit(req, root, 'private_gateways_toggled', { allowPrivate: allow });
    res.json(createApiSuccessResponse({ allowPrivate: privateGatewaysEnabled() }));
  }),
);

/* ============================ 本人:个人 key ============================ */

router.get(
  '/:provider/my-gateways',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const viewer = viewerOf(user);
    res.json(createApiSuccessResponse({
      gateways: await myGatewayViews(viewer),
      models: privateGatewaysEnabled() || listMyModels(user.id).length > 0 ? listMyModels(user.id) : [],
      allowPrivate: privateGatewaysEnabled(),
    }));
  }),
);

/** 自己在网关 0 / 共享网关上的个人 key。 */
router.put(
  '/:provider/my-gateways/:id/key',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id, { allowZero: true });
    run(() => setPersonalKey(id, user.id, (req.body ?? {}).key, user.id));
    audit(req, user, 'gateway_key_set', { gatewayId: id });
    res.json(createApiSuccessResponse({ gateways: await myGatewayViews(viewerOf(user)) }));
  }),
);

router.delete(
  '/:provider/my-gateways/:id/key',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id, { allowZero: true });
    const cleared = run(() => clearPersonalKey(id, user.id));
    if (cleared) audit(req, user, 'gateway_key_cleared', { gatewayId: id });
    res.json(createApiSuccessResponse({ gateways: await myGatewayViews(viewerOf(user)) }));
  }),
);

/** 测试:带 key 测给的那把;不带测自己现在会用的那把。 */
router.post(
  '/:provider/my-gateways/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id, { allowZero: true });
    const result = await runAsync(() => testGatewayFor(id, viewerOf(user), (req.body ?? {}).key));
    res.json(createApiSuccessResponse({ result }));
  }),
);

/* ============================ 本人:私有网关 ============================ */

router.post(
  '/:provider/my-gateways',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const view = run(() => createPrivateGateway(user.id, (req.body ?? {}) as Record<string, unknown>));
    audit(req, user, 'private_gateway_created', { id: view.id, name: view.name, host: view.host, hasKey: view.hasDefaultKey });
    res.status(201).json(createApiSuccessResponse({ gateway: view, gateways: await myGatewayViews(viewerOf(user)) }));
  }),
);

router.patch(
  '/:provider/my-gateways/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id);
    const view = run(() => updatePrivateGateway(user.id, id, (req.body ?? {}) as Record<string, unknown>));
    audit(req, user, 'private_gateway_updated', { id, name: view.name, host: view.host, changed: Object.keys(req.body ?? {}) });
    res.json(createApiSuccessResponse({ gateway: view, gateways: await myGatewayViews(viewerOf(user)) }));
  }),
);

router.put(
  '/:provider/my-gateways/:id/private-key',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id);
    const rawKey = (req.body ?? {}).key;
    const view = run(() => setPrivateGatewayKey(user.id, id, rawKey));
    audit(req, user, 'private_gateway_key_set', { gatewayId: id, cleared: rawKey === null || rawKey === '' });
    res.json(createApiSuccessResponse({ gateway: view, gateways: await myGatewayViews(viewerOf(user)) }));
  }),
);

router.delete(
  '/:provider/my-gateways/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id);
    const removed = run(() => deletePrivateGateway(user.id, id));
    audit(req, user, 'private_gateway_deleted', { id, name: removed.name });
    res.json(createApiSuccessResponse({ removed: id, gateways: await myGatewayViews(viewerOf(user)), models: listMyModels(user.id) }));
  }),
);

/* ============================ 本人:私有模型 ============================ */

router.post(
  '/:provider/my-models',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const entry = run(() => createMyModel(user.id, (req.body ?? {}) as Record<string, unknown>));
    audit(req, user, 'user_model_created', { id: entry.id, modelId: entry.modelId, gatewayId: entry.gatewayId });
    res.status(201).json(createApiSuccessResponse({ model: entry, models: listMyModels(user.id) }));
  }),
);

router.patch(
  '/:provider/my-models/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id);
    const entry = run(() => updateMyModel(user.id, id, (req.body ?? {}) as Record<string, unknown>));
    audit(req, user, 'user_model_updated', { id, modelId: entry.modelId, changed: Object.keys(req.body ?? {}) });
    res.json(createApiSuccessResponse({ model: entry, models: listMyModels(user.id) }));
  }),
);

router.delete(
  '/:provider/my-models/:id',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    const id = parseId(req.params.id);
    const removed = run(() => deleteMyModel(user.id, id));
    audit(req, user, 'user_model_deleted', { id, modelId: removed.modelId });
    res.json(createApiSuccessResponse({ removed: id, models: listMyModels(user.id) }));
  }),
);

/**
 * 私有模型「实测」:用本人的私有网关与 key 跑一次一致性检查(结果不落库,只回给本人)。
 * 复审(P2-8):每一次都起一个 CLI 进程(最长 60 秒)—— 每人同时只许一个,全站同时最多 3 个。
 */
const probesInFlight = new Map<number, number>();
const MAX_PROBES_TOTAL = 3;
const probeSlotsInUse = (): number => [...probesInFlight.values()].reduce((sum, n) => sum + n, 0);

router.post(
  '/:provider/my-models/:id/probe',
  asyncHandler(async (req: Request, res: Response) => {
    parseProviderParam(req.params.provider);
    const user = requireUser(req);
    if ((probesInFlight.get(user.id) ?? 0) > 0) {
      throw new AppError('你还有一个实测在跑 —— 等它结束再测', { code: 'PROBE_BUSY', statusCode: 429 });
    }
    if (probeSlotsInUse() >= MAX_PROBES_TOTAL) {
      throw new AppError('现在同时在跑的实测太多了 —— 过一会儿再试', { code: 'PROBE_BUSY', statusCode: 429 });
    }
    // 复审(二轮 nit):检查完立刻占位(下面有 await,不占位的话并发请求会一起过检查)
    probesInFlight.set(user.id, (probesInFlight.get(user.id) ?? 0) + 1);
    try {
      const id = parseId(req.params.id);
      const entry = listMyModels(user.id).find((candidate) => candidate.id === id);
      if (!entry) throw new AppError('这个私有模型不存在', { code: 'NOT_FOUND', statusCode: 404 });
      if (!privateGatewaysEnabled()) throw new AppError('管理员关掉了私有网关', { code: 'PRIVATE_GATEWAYS_DISABLED', statusCode: 403 });
      let gateway;
      try {
        gateway = await resolveTurnGateway({ model: entry.modelId, viewer: viewerOf(user) });
      } catch (error) {
        if (error instanceof GatewayError) {
          res.json(createApiSuccessResponse({ probe: { at: new Date().toISOString(), ok: false, accepted: false, toolRoundTrip: false, inputTokens: null, respondedModel: null, latencyMs: 0, error: error.message } }));
          return;
        }
        throw error;
      }
      // 私有模型没上架 / 网关停用时,lookupFor 会落到同名的目录条目上 —— 那就不是在测"我的这个模型"了
      if (gateway.gatewayId !== entry.gatewayId) {
        res.json(createApiSuccessResponse({ probe: { at: new Date().toISOString(), ok: false, accepted: false, toolRoundTrip: false, inputTokens: null, respondedModel: null, latencyMs: 0, error: '这个私有模型没上架,或它的网关停用了 —— 先上架 / 启用再测' } }));
        return;
      }
      const probe = await probeCatalogModel(entry.modelId, entry.contextWindow, gateway);
      res.json(createApiSuccessResponse({ probe }));
    } finally {
      const left = (probesInFlight.get(user.id) ?? 1) - 1;
      if (left > 0) probesInFlight.set(user.id, left);
      else probesInFlight.delete(user.id);
    }
  }),
);

export { DEFAULT_GATEWAY_ID };

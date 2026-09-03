import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  DEFAULT_EFFORT_VALUE,
  FALLBACK_PROVIDER_EFFORT_VALUES,
  toProviderEffortOptions,
} from '../constants/providerEffort';

/**
 * The agent backend this build talks to.
 *
 * `provider` used to be state here: seeded from a `selected-provider`
 * localStorage key, re-synced from `session.__provider`, and reassigned by the
 * model picker. `LLMProvider` has one member now, so all three paths could only
 * ever produce this value. It stays a named constant rather than being inlined
 * because the provider is still a real axis on the wire — every route below is
 * `/api/providers/:provider/...` — and the per-provider maps this hook keeps
 * are the shape the backend answers in.
 */
const PROVIDER: LLMProvider = 'claude';
const PROVIDERS: LLMProvider[] = [PROVIDER];

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
};

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

export function useChatProviderState({ selectedSession, selectedProject }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || FALLBACK_DEFAULT_MODEL.claude;
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  /**
   * The model this conversation is actually running, as the server sees it.
   *
   * Kept separately from `claudeModel` because they answer different
   * questions: `claudeModel` is the client-side default for the NEXT new chat,
   * while this is what the current session resolves to (a /models override if
   * one exists, otherwise what the transcript shows). Before this existed the
   * composer had no way to display the running model at all, so switching had
   * no visible effect once the /models modal closed.
   */
  const [activeSessionModel, setActiveSessionModel] = useState<string | null>(null);
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);
  /**
   * 别名 → 网关实际模型的实测缓存。自定义网关把 "haiku/sonnet" 之类的别名在请求时
   * 解析成真实模型,只有实测(/models 里点「实测真实模型」)后才知道。这里读回缓存,
   * 让输入框上的模型 chip 能直接显示"实际是谁在答",而不是只有一个内部别名。
   * 空 = 还没实测过 / 官方 API,chip 退回显示别名。
   */
  const [modelMappings, setModelMappings] = useState<
    Record<string, { actualModel: string | null; error: string | null; checkedAt: string }>
  >({});
  /**
   * settings.json 在上次实测后改过 → 缓存的"实际模型"可能已不成立。
   * 为 true 时 chip 停显真名(宁缺毋错),/models 弹窗提示重测。
   */
  const [modelMappingsStale, setModelMappingsStale] = useState(false);
  /**
   * 配置层映射(读 settings.json 直接算出,后端每次现读):别名 → 配置的模型。
   * 与实测互补 —— 实测缺失/过期时 chip 用它回退,改完配置立即是新值。
   */
  const [modelConfigMappings, setModelConfigMappings] = useState<
    Record<string, { configuredModel: string | null; source: string | null }>
  >({});

  const providerModelsRequestIdRef = useRef(0);

  const setStoredProviderModel = useCallback((model: string) => {
    setClaudeModel(model);
    localStorage.setItem('claude-model', model);
  }, []);

  const refreshActiveSessionModel = useCallback(async (sessionId?: string | null) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setActiveSessionModel(null);
      return;
    }

    try {
      const response = await authenticatedFetch(
        `/api/providers/${PROVIDER}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      );
      const body = (await response.json()) as { success?: boolean; data?: { model?: string } };
      setActiveSessionModel(response.ok && body.data?.model ? body.data.model : null);
    } catch {
      // A missing indicator is better than a wrong one.
      setActiveSessionModel(null);
    }
  }, []);

  const refreshModelMappings = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`/api/providers/${PROVIDER}/model-mappings`);
      if (!response.ok) return;
      const body = (await response.json()) as {
        data?: {
          mappings?: Record<string, { actualModel: string | null; error: string | null; checkedAt: string }>;
          stale?: boolean;
          configMappings?: Record<string, { configuredModel: string | null; source: string | null }>;
        };
      };
      setModelMappings(body.data?.mappings ?? {});
      setModelMappingsStale(body.data?.stale === true);
      setModelConfigMappings(body.data?.configMappings ?? {});
    } catch {
      // 拿不到映射就不显示真实名 —— chip 退回显示别名,不影响使用。
    }
  }, []);

  useEffect(() => {
    void refreshModelMappings();
  }, [refreshModelMappings]);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        PROVIDERS.map(async (p) => {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!body.success || !body.data?.models || !body.data?.cache) {
            return null;
          }

          return body.data;
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      PROVIDERS.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry.models;
        nextCacheCatalog[p] = entry.cache;
      });

      setProviderModelCatalog(nextCatalog);
      setProviderModelCacheCatalog(nextCacheCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/capabilities');
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
    claude: claudeModel,
  }), [claudeModel]);

  useEffect(() => {
    const claude = providerModelCatalog.claude;
    if (claude) {
      const next = pickStoredOrCurrent('claude-model', claudeModel, claude);
      if (next !== claudeModel) {
        setClaudeModel(next);
      }
      if (localStorage.getItem('claude-model') !== next) {
        localStorage.setItem('claude-model', next);
      }
    }
  }, [providerModelCatalog.claude, claudeModel]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    void refreshActiveSessionModel(selectedSession?.id);
  }, [selectedSession?.id, refreshActiveSessionModel]);

  /**
   * Warm this conversation's runtime as soon as it is opened.
   *
   * Prism builds the Claude subprocess lazily inside the first send, so its
   * launch, the SDK handshake and any MCP servers all land on the user's first
   * message. Running `claude` in a terminal costs exactly the same, but you
   * watch it boot before you type — which is why the chat felt slower than the
   * shell for identical work. Asking the server to build it while the user is
   * still reading or typing moves the wait off the first turn.
   *
   * Fire-and-forget: the endpoint never fails a request, and if this never
   * runs the send path builds the runtime exactly as it always did.
   *
   * The payload has to match what the first send will pass, because the
   * runtime is keyed by a signature over cwd, effort and permission mode — a
   * mismatch throws the warmed runtime away and rebuilds it, which is slower
   * than not warming at all. Changing the execution-mode gear afterwards
   * re-runs this for the same reason.
   */
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId) return;

    const controller = new AbortController();
    // A short delay keeps a fast scroll through the session list from spawning
    // a subprocess per conversation the user merely passed over.
    const timer = window.setTimeout(() => {
      void authenticatedFetch(`/api/providers/${PROVIDER}/sessions/${encodeURIComponent(sessionId)}/prewarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissionMode,
          model: claudeModel,
          effort: providerEfforts[PROVIDER] ?? DEFAULT_EFFORT_VALUE,
          cwd: selectedProject?.fullPath || selectedProject?.path || undefined,
        }),
        signal: controller.signal,
      }).catch(() => {
        // Warming is an optimisation; a failure must stay invisible.
      });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedSession?.id, selectedProject?.fullPath, selectedProject?.path, permissionMode, claudeModel, providerEfforts]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(PROVIDER);
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${PROVIDER}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(PROVIDER));
  }, [selectedSession?.id, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  /**
   * Switch gear and remember it. The single write path for both the dropdown
   * and the Tab shortcut — the persistence below is easy to forget when adding
   * a second entry point, and forgetting it means the mode silently resets on
   * the next render.
   */
  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    const modes = getPermissionModesForProvider(PROVIDER);
    if (!modes.includes(nextMode)) return;

    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${PROVIDER}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [selectedSession?.id, getPermissionModesForProvider]);

  /**
   * do/du:计划卡点了「开始实施」→ 档位切出计划模式。批准只作用于当前回合
   * (CLI 内部继续执行),而 composer 档位决定**下一条消息**;不切的话下一句
   * 追问又进计划模式,"点了开始却还在计划"。
   *
   * du:必须走 `selectPermissionMode` —— 上面那段注释警告过的正是这个坑:
   * do 轮直接调 setPermissionMode,**没写 localStorage**,于是切走再切回
   * (或 capabilities 响应落地让恢复 effect 重跑)时,档位又从存档里读回
   * `plan`,症状原样复发。只在当前正是 plan 时动作,故读 ref 判断。
   */
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  useEffect(() => {
    const onPlanApproved = () => {
      if (permissionModeRef.current === 'plan') selectPermissionMode('default');
    };
    window.addEventListener('prism:plan-approved', onPlanApproved);
    return () => window.removeEventListener('prism:plan-approved', onPlanApproved);
  }, [selectPermissionMode]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(PROVIDER);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    selectPermissionMode(modes[nextIndex]);
  }, [permissionMode, getPermissionModesForProvider, selectPermissionMode]);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    // Also move the stored default. /models is the only model control now — the
    // picker on the new-chat screen was removed because the two wrote to
    // different places and whichever ran last silently won. Without this the
    // last model you chose would apply to the current conversation and every
    // new chat would still open on whatever the default was months ago, with
    // no way left to change it.
    setStoredProviderModel(model);
    setActiveSessionModel(body.data.model || model);

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: body.data.model || model,
    };
  }, [setStoredProviderModel]);

  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(PROVIDER, providerModels[PROVIDER]);
  }, [getEffortOptionsForModel, providerModels]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      PROVIDER,
      providerModels[PROVIDER],
      providerEfforts[PROVIDER] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  return {
    provider: PROVIDER,
    claudeModel,
    setClaudeModel: setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    activeSessionModel,
    refreshActiveSessionModel,
    modelMappings,
    modelMappingsStale,
    modelConfigMappings,
    refreshModelMappings,
    permissionMode,
    setPermissionMode,
    selectPermissionMode,
    availablePermissionModes: getPermissionModesForProvider(PROVIDER),
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  };
}

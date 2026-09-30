import { useEffect, useReducer, useRef } from 'react';

import { pushAccountSettings } from '../utils/accountSettings';

type UiPreferences = {
  showRawParameters: boolean;
  showThinking: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  /** gy:调过 skill 的回合结束后要不要问「效果如何」。服务端按这个键决定弹不弹。 */
  skillSurveyEnabled: boolean;
  /** hc:技能优化页自己的「SKILL STUDIO」导航开合(左轨那颗开合按钮在技能优化页管的是它,不是项目侧栏)。 */
  skillNavVisible: boolean;
};

type UiPreferenceKey = keyof UiPreferences;

type SetPreferenceAction = {
  type: 'set';
  key: UiPreferenceKey;
  value: unknown;
};

type SetManyPreferencesAction = {
  type: 'set_many';
  value?: Partial<Record<UiPreferenceKey, unknown>>;
};

type ResetPreferencesAction = {
  type: 'reset';
  value?: Partial<UiPreferences>;
};

type UiPreferencesAction =
  | SetPreferenceAction
  | SetManyPreferencesAction
  | ResetPreferencesAction;

const DEFAULTS: UiPreferences = {
  showRawParameters: false,
  showThinking: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  skillSurveyEnabled: true,
  skillNavVisible: true,
};

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
/**
 * hl(动态 P2-8):改了就要推到账号的键。
 *
 * 「技能效果询问」开关服务端也读(`user_ui_settings.uiPreferences.skillSurveyEnabled`,
 * 决定弹不弹调查卡),此前 setPreference 只写 localStorage、不 push,关了照弹。
 * 侧栏 / 技能导航开合是**本机布局态**,随页签切换频繁写,不值得每次打接口
 * (动态报告 P3 也点名"侧栏开合偏好随 tab 切换写服务端"会让另一端的侧栏消失)。
 */
const ACCOUNT_SYNCED_PREFERENCE_KEYS = new Set<UiPreferenceKey>(['skillSurveyEnabled', 'showRawParameters', 'showThinking', 'sendByCtrlEnter']);
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS); // prevents unknown keys from being written
const SYNC_EVENT = 'ui-preferences:sync';

type SyncEventDetail = {
  storageKey: string;
  sourceId: string;
  value: Partial<Record<UiPreferenceKey, unknown>>;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

const readLegacyPreference = (key: UiPreferenceKey, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;

    // Supports values written by both JSON.stringify and plain strings.
    const parsed = JSON.parse(raw);
    return parseBoolean(parsed, fallback);
  } catch {
    return fallback;
  }
};

const readInitialPreferences = (storageKey: string): UiPreferences => {
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }

  try {
    const raw = localStorage.getItem(storageKey);

    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedRecord = parsed as Record<string, unknown>;

        return PREFERENCE_KEYS.reduce((acc, key) => {
          acc[key] = parseBoolean(parsedRecord[key], DEFAULTS[key]);
          return acc;
        }, { ...DEFAULTS });
      }
    }
  } catch {
    // Fall back to legacy keys when unified key is missing or invalid.
  }

  return PREFERENCE_KEYS.reduce((acc, key) => {
    acc[key] = readLegacyPreference(key, DEFAULTS[key]);
    return acc;
  }, { ...DEFAULTS });
};

function reducer(state: UiPreferences, action: UiPreferencesAction): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parseBoolean(value, state[key]);
      if (state[key] === nextValue) {
        return state;
      }

      return { ...state, [key]: nextValue };
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const value = updates[key];
        const nextValue = parseBoolean(value, state[key]);
        if (nextState[key] !== nextValue) {
          nextState[key] = nextValue;
          changed = true;
        }
      }

      return changed ? nextState : state;
    }
    case 'reset':
      return { ...DEFAULTS, ...(action.value || {}) };
    default:
      return state;
  }
}

export function useUiPreferences(storageKey = 'uiPreferences') {
  const instanceIdRef = useRef(`ui-preferences-${Math.random().toString(36).slice(2)}`);
  const [state, dispatch] = useReducer(
    reducer,
    storageKey,
    readInitialPreferences
  );

  const hasPersistedRef = useRef(false);
  /** 本实例上一次 setPreference 改的是不是要同步到账号的键;写完 localStorage 再推。 */
  const pendingAccountPushRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    /**
     * 首次挂载**不广播**。
     *
     * 每个 useUiPreferences 实例在挂载时从存储读一份初始值,原来紧接着就把它
     * 写回并广播出去。晚挂载的实例(切标签页时才出现的面板、终端、Notebook…)
     * 于是会把**它读到的旧快照**广播给所有人,把别人刚改好的新值冲掉 ——
     * 表现为偏好"回跳一步、慢一拍"(切标签页自动收放侧栏时最明显)。
     *
     * 初始值本来就来自存储,写回是空转;真正需要补写的只有"存储里还没有这
     * 一项"的情况(从旧版分键存储迁移过来的第一次)。
     */
    if (!hasPersistedRef.current) {
      hasPersistedRef.current = true;
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(storageKey, JSON.stringify(state));
      }
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify(state));
    if (pendingAccountPushRef.current) {
      pendingAccountPushRef.current = false;
      // 落盘之后再推:pushAccountSettings 读的是 localStorage 里那份。
      void pushAccountSettings();
    }

    window.dispatchEvent(
      new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
        detail: {
          storageKey,
          sourceId: instanceIdRef.current,
          value: state,
        },
      })
    );
  }, [state, storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyExternalUpdate = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      dispatch({ type: 'set_many', value: value as Partial<Record<UiPreferenceKey, unknown>> });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== storageKey || event.newValue === null) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue);
        applyExternalUpdate(parsed);
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSyncEvent = (event: Event) => {
      const syncEvent = event as CustomEvent<SyncEventDetail>;
      const detail = syncEvent.detail;
      if (!detail || detail.storageKey !== storageKey || detail.sourceId === instanceIdRef.current) {
        return;
      }

      applyExternalUpdate(detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
    };
  }, [storageKey]);

  const setPreference = (key: UiPreferenceKey, value: unknown) => {
    if (ACCOUNT_SYNCED_PREFERENCE_KEYS.has(key)) pendingAccountPushRef.current = true;
    dispatch({ type: 'set', key, value });
  };

  const setPreferences = (value: Partial<Record<UiPreferenceKey, unknown>>) => {
    dispatch({ type: 'set_many', value });
  };

  const resetPreferences = (value?: Partial<UiPreferences>) => {
    dispatch({ type: 'reset', value });
  };

  return {
    preferences: state,
    setPreference,
    setPreferences,
    resetPreferences,
    dispatch,
  };
}

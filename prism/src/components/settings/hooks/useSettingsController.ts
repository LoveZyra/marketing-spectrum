import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { setNotificationSoundEnabled } from '../../../utils/notificationSound';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import { DEFAULT_CODE_EDITOR_SETTINGS, SETTINGS_MAIN_TAB_IDS } from '../constants/constants';
import type {
  AgentProvider,
  ClaudePermissionsState,
  CodeEditorSettingsState,
  NotificationPreferencesState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

// 派生自同一份清单。手写的那一版少了 voice,于是 `?tab=voice` 深链会被
// normalizeMainTab 判为未知值,静默回落到 agents。
const KNOWN_MAIN_TABS: SettingsMainTab[] = SETTINGS_MAIN_TAB_IDS;

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const readCodeEditorSettings = (): CodeEditorSettingsState => ({
  wordWrap: localStorage.getItem('codeEditorWordWrap') === 'true',
  showMinimap: localStorage.getItem('codeEditorShowMinimap') !== 'false',
  lineNumbers: localStorage.getItem('codeEditorLineNumbers') !== 'false',
  fontSize: localStorage.getItem('codeEditorFontSize') ?? DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
});

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

/**
 * 自动保存基线签名:把会自动保存的那几项(权限 / 排序 / 通知偏好)拍成一个串。
 * loadSettings 记录加载后的基线,auto-save 只在当前签名与基线不同时才写。
 */
const settingsSignature = (
  perms: ClaudePermissionsState,
  sortOrder: ProjectSortOrder,
  notif: NotificationPreferencesState,
): string => JSON.stringify({
  allowedTools: perms.allowedTools,
  disallowedTools: perms.disallowedTools,
  skipPermissions: perms.skipPermissions,
  projectSortOrder: sortOrder,
  notif,
});

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const closeTimerRef = useRef<number | null>(null);
  // 自动保存门:加载完成前不写;加载后只在签名变化时写。见 loadSettings / auto-save。
  const loadCompleteRef = useRef(false);
  const lastPersistedSigRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const loadSettings = useCallback(async () => {
    try {
      const savedClaudeSettings = parseJson<ClaudeSettingsStorage>(
        localStorage.getItem('claude-settings'),
        {},
      );
      const loadedPerms = {
        allowedTools: savedClaudeSettings.allowedTools || [],
        disallowedTools: savedClaudeSettings.disallowedTools || [],
        skipPermissions: Boolean(savedClaudeSettings.skipPermissions),
      };
      const loadedSortOrder: ProjectSortOrder = savedClaudeSettings.projectSortOrder === 'date' ? 'date' : 'name';
      setClaudePermissions(loadedPerms);
      setProjectSortOrder(loadedSortOrder);

      let loadedNotifPrefs = createDefaultNotificationPreferences();
      try {
        const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences');
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            loadedNotifPrefs = normalizeNotificationPreferences(notificationData.preferences);
          }
        }
      } catch {
        // 保留默认值。
      }
      setNotificationPreferences(loadedNotifPrefs);

      // 记录"已加载"基线签名并放开自动保存。auto-save 只在**当前签名 ≠ 该基线**时
      // 才写 —— 这样 loadSettings 的异步 setState(尤其通知偏好 GET 失败回落默认值时)
      // 不会把默认值 PUT 回去覆盖服务端已存偏好;只有用户真正改动才触发保存。
      lastPersistedSigRef.current = settingsSignature(loadedPerms, loadedSortOrder, loadedNotifPrefs);
      loadCompleteRef.current = true;
    } catch (error) {
      console.error('Error loading settings:', error);
      const fallbackPerms = createEmptyClaudePermissions();
      const fallbackNotif = createDefaultNotificationPreferences();
      setClaudePermissions(fallbackPerms);
      setNotificationPreferences(fallbackNotif);
      setProjectSortOrder('name');
      lastPersistedSigRef.current = settingsSignature(fallbackPerms, 'name', fallbackNotif);
      loadCompleteRef.current = true;
    }
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      const now = new Date().toISOString();
      localStorage.setItem('claude-settings', JSON.stringify({
        allowedTools: claudePermissions.allowedTools,
        disallowedTools: claudePermissions.disallowedTools,
        skipPermissions: claudePermissions.skipPermissions,
        projectSortOrder,
        lastUpdated: now,
      }));

      const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(notificationPreferences),
      });
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      // 更新基线:保存成功后当前值即新的"已持久化"状态,后续没变就不再重复写。
      lastPersistedSigRef.current = settingsSignature(claudePermissions, projectSortOrder, notificationPreferences);
      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    claudePermissions,
    notificationPreferences,
    projectSortOrder,
  ]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      setCodeEditorSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  useEffect(() => {
    localStorage.setItem('codeEditorWordWrap', String(codeEditorSettings.wordWrap));
    localStorage.setItem('codeEditorShowMinimap', String(codeEditorSettings.showMinimap));
    localStorage.setItem('codeEditorLineNumbers', String(codeEditorSettings.lineNumbers));
    localStorage.setItem('codeEditorFontSize', codeEditorSettings.fontSize);
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorSettings]);

  // Auto-save permissions and sort order with debounce
  const autoSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // 加载还没完成:一律不写(避免 loadSettings 的异步 setState 触发回写)。
    if (!loadCompleteRef.current) {
      return;
    }

    const currentSig = settingsSignature(claudePermissions, projectSortOrder, notificationPreferences);
    // 与已加载/已保存的基线一致 → 不是用户改动(通常是 load 的多段 setState 落定),
    // 不写。这就堵住了"打开设置即回写默认值覆盖服务端偏好"。
    if (currentSig === lastPersistedSigRef.current) {
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      void saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings, claudePermissions, projectSortOrder, notificationPreferences]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  // 每次打开设置对话框:重置加载门,等 loadSettings 重新记录基线后才放开自动保存。
  useEffect(() => {
    if (isOpen) {
      loadCompleteRef.current = false;
      lastPersistedSigRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}

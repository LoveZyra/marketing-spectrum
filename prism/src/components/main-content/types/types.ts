import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '../../../types/app';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../../chat/types/types';
import type { RecentSessionEntry } from '../../chat/utils/recentSessions';
import type { SettingsMainTab } from '../../settings/types/types';

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  isConnected: boolean;
  sendMessage: (message: unknown) => boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionProcessing: MarkSessionProcessing;
  onSessionIdle: MarkSessionIdle;
  processingSessions: SessionActivityMap;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  /**
   * ee:预览「最大化 / 还原」的状态通知。最大化时对话列与工作面板已经隐藏,
   * 用户要的是"所有展开的栏目都收起" —— 项目侧栏归 AppContent 管,由它据此隐藏。
   */
  onEditorMaximizedChange?: (maximized: boolean) => void;
  /** ef:首页空态「最近会话」的数据(跨项目、按时间取前几条),由 AppContent 算好。 */
  recentSessions?: RecentSessionEntry[];
  /** ef:顶栏铅笔改名 / 「…」删除会话 —— 实现在 AppContent。 */
  onRenameSession?: (sessionId: string, summary: string) => Promise<boolean> | boolean;
  onDeleteSession?: (sessionId: string, sessionTitle: string) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** 「在 JupyterLab 打开」的目标;nonce 变化触发 notebook 标签页重新定位。 */
  jupyterTarget?: { path: string | null; nonce: number };
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
  /** 当前会话在服务端挂着常驻运行时(本页见过它在跑)——「…」里那行的乐观初值。 */
  isPersistentSession?: boolean;
  /** ef:标题就地改名(顶栏铅笔)。 */
  onRenameSession?: (sessionId: string, summary: string) => Promise<boolean> | boolean;
  /** ef:顶栏「…」里的删除会话 —— 确认框在 AppContent(侧栏折叠时它也在)。 */
  onDeleteSession?: (sessionId: string, sessionTitle: string) => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
  /**
   * 空态下用户当前选的页签。
   *
   * 没选项目时四个页签渲染的都是这块空态 —— 点终端 / 文件 / notebook 看起来
   * 「毫无反应」。把页签名说出来,至少让人知道点是点到了,缺的是一个项目。
   */
  activeTab?: AppTab;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};


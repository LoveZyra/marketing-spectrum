import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '../../../types/app';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../../chat/types/types';
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
  /** 当前会话在服务端挂着常驻运行时 —— 顶栏右侧显示「常驻会话」胶囊。 */
  isPersistentSession?: boolean;
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


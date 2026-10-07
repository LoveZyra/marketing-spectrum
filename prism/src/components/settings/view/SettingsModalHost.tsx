import { lazy, Suspense, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';

import { ModalLoadingFallback } from '../../../shared/view/LazyPanel';
import { normalizeProjectForSettings } from '../../sidebar/utils/utils';
import type { SettingsProject } from '../../sidebar/types/types';
import type { Project } from '../../../types/app';

/**
 * 设置弹窗的挂载点:挂在应用外层(AppContent),不挂在侧栏里。
 *
 * 侧栏折叠时 `AppContent` 整棵不渲染 `<Sidebar/>`,而设置的三个入口(轨上的齿轮、命令面板、
 * 主区)都在侧栏之外;若挂在侧栏里,折叠状态下 `showSettings` 变成 true 也没有东西渲染它。
 * 弹窗 `createPortal` 到 `document.body`,挂在哪一层不影响显示。
 *
 * 新建项目 / 删除确认等弹窗留在 `SidebarModals`:它们的入口只在侧栏里。
 */

// 懒加载:设置页牵着 MCP、技能、权限、API key 几屏,大多数会话根本不会打开。
const Settings = lazy(() => import('./Settings'));

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as unknown as (props: TypedSettingsProps) => JSX.Element;

type SettingsModalHostProps = {
  isOpen: boolean;
  initialTab: string;
  onClose: () => void;
  projects: Project[];
};

export default function SettingsModalHost({
  isOpen,
  initialTab,
  onClose,
  projects,
}: SettingsModalHostProps) {
  // 设置页要拿到项目的 id / path 才能渲染下拉标签和 local 作用域的 MCP 配置。
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  /**
   * 空闲时预取设置页的代码块。
   *
   * 首次点「设置」的那一下抖动来自懒加载:代码块还没到,先显示 fallback 遮罩,
   * 到货再换成真弹窗 —— 两者的背景色、模糊、入场动画都不同,切换就是那一下不稳。
   * 提前取好,`React.lazy` 同步渲染,首次和后续一样顺。
   */
  useEffect(() => {
    let cancelled = false;
    const prefetch = () => {
      if (cancelled) return;
      void import('./Settings');
    };
    const scheduler = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timerId: number | null = null;
    if (typeof scheduler.requestIdleCallback === 'function') {
      idleId = scheduler.requestIdleCallback(prefetch);
    } else {
      timerId = window.setTimeout(prefetch, 1500);
    }
    return () => {
      cancelled = true;
      if (idleId !== null && typeof scheduler.cancelIdleCallback === 'function') {
        scheduler.cancelIdleCallback(idleId);
      }
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, []);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <Suspense fallback={<ModalLoadingFallback />}>
      <SettingsComponent
        isOpen={isOpen}
        onClose={onClose}
        projects={settingsProjects}
        initialTab={initialTab}
      />
    </Suspense>,
    document.body,
  );
}

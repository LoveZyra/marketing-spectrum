import { lazy, Suspense, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';

import { ModalLoadingFallback } from '../../../shared/view/LazyPanel';
import { normalizeProjectForSettings } from '../../sidebar/utils/utils';
import type { SettingsProject } from '../../sidebar/types/types';
import type { Project } from '../../../types/app';

/**
 * 设置弹窗的挂载点 —— **挂在应用外层,不挂在侧栏里**。
 *
 * 这一条是修一个真 bug:弹窗原来住在 `SidebarModals` 里,而侧栏折叠时
 * `AppContent` 是 `isSidebarCollapsed ? null : <Sidebar/>` —— 整棵侧栏根本没渲染。
 * 于是折叠状态下点轨上的齿轮,`showSettings` 确实变成了 true,**但没有任何东西
 * 在渲染它**,表现就是"按了没反应"。命令面板的「打开设置」和主区那个入口
 * 一样中招 —— 三个入口全都在侧栏之外,却依赖侧栏活着。
 *
 * 弹窗本来就是 `createPortal` 到 `document.body` 的,它待在侧栏子树里
 * 从来只是历史位置,没有任何理由。搬到这里之后,谁开都一样。
 *
 * 新建项目 / 删除确认那几个仍然留在 `SidebarModals`:它们的唯一入口就在侧栏里,
 * 侧栏没渲染时本来也点不到。
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

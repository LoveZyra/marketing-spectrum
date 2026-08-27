import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '../../../types/app';
import Shell from '../../shell/view/Shell';

import StandaloneShellEmptyState from './subcomponents/StandaloneShellEmptyState';
import StandaloneShellHeader from './subcomponents/StandaloneShellHeader';
import ShellTabs, { type ShellTab } from './subcomponents/ShellTabs';

type StandaloneShellProps = {
  project?: Project | null;
  session?: ProjectSession | null;
  command?: string | null;
  isPlainShell?: boolean | null;
  isActive?: boolean;
  autoConnect?: boolean;
  onComplete?: ((exitCode: number) => void) | null;
  onClose?: (() => void) | null;
  title?: string | null;
  className?: string;
  showHeader?: boolean;
  compact?: boolean;
  minimal?: boolean;
};

/** 终端标签上限。开到第七个通常意味着人想要的是别的东西(比如后台任务)。 */
const MAX_SHELL_TABS = 6;

export default function StandaloneShell({
  project = null,
  session = null,
  command = null,
  isPlainShell = null,
  isActive = true,
  autoConnect = true,
  onComplete = null,
  onClose = null,
  title = null,
  className = '',
  showHeader = true,
  compact = false,
  minimal = false,
}: StandaloneShellProps) {
  const { t } = useTranslation('common');
  const [isCompleted, setIsCompleted] = useState(false);
  /**
   * F10:终端多标签。
   *
   * 一个终端跑着构建、另一个想看日志 —— 之前只能等。服务端的 PTY 池本来就按键
   * 分,给每个标签一个 id 就各自一个 shell(见 shell-websocket 的 terminalId)。
   *
   * 只在"项目终端"这个形态下开标签:带 `command` 的那些是一次性任务终端
   * (登录、setup-token),给它们加标签条既没意义又会把布局挤乱。
   */
  const supportsTabs = !minimal && command === null;
  const [tabs, setTabs] = useState<ShellTab[]>([{ id: 't1', label: t('shellTabs.label', { index: 1, defaultValue: '终端 1' }) }]);
  const [activeTabId, setActiveTabId] = useState('t1');
  const nextTabIdRef = useRef(2);

  /**
   * 注意:**不要**在 setTabs 的 updater 里改别的 state 或 ref。
   *
   * updater 必须是纯函数 —— React 会在开发模式(StrictMode)里跑两遍来暴露副作用,
   * 那样 id 计数器会跳号、活动标签会被设两次。所以这里先算好下一份 tabs,再一次性
   * 提交,活动标签用普通 setState 单独设。
   */
  const addTab = useCallback(() => {
    if (tabs.length >= MAX_SHELL_TABS) return;
    const id = `t${nextTabIdRef.current}`;
    nextTabIdRef.current += 1;
    setTabs([...tabs, { id, label: t('shellTabs.label', { index: tabs.length + 1, defaultValue: `终端 ${tabs.length + 1}` }) }]);
    setActiveTabId(id);
  }, [tabs, t]);

  const closeTab = useCallback((id: string) => {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;

    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (activeTabId === id) {
      // 落到左边那个;没有左边就落到右边 —— 可预测,不跳到随机一个。
      setActiveTabId((next[index - 1] ?? next[index] ?? next[0]).id);
    }
  }, [tabs, activeTabId]);

  // Keep `compact` in the public API for compatibility with existing callers.
  void compact;

  const shouldUsePlainShell = isPlainShell !== null ? isPlainShell : command !== null;

  const handleProcessComplete = useCallback(
    (exitCode: number) => {
      setIsCompleted(true);
      onComplete?.(exitCode);
    },
    [onComplete],
  );

  if (!project) {
    return <StandaloneShellEmptyState className={className} />;
  }

  return (
    <div className={`flex h-full w-full flex-col ${className}`}>
      {!minimal && showHeader && title && (
        <StandaloneShellHeader title={title} isCompleted={isCompleted} onClose={onClose} />
      )}

      {supportsTabs && tabs.length > 0 && (
        <ShellTabs
          tabs={tabs}
          activeId={activeTabId}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onAdd={addTab}
          canAdd={tabs.length < MAX_SHELL_TABS}
        />
      )}

      <div className="min-h-0 w-full flex-1">
        {supportsTabs ? (
          // 非活动标签**用 CSS 藏起来而不是拆掉**:卸载会断开 websocket,回来时
          // 只能靠回放缓冲捞一小段,正在跑的命令就看不到了。
          tabs.map((tab) => (
            <div key={tab.id} className={`h-full w-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}>
              <Shell
                selectedProject={project}
                selectedSession={session}
                initialCommand={command}
                isPlainShell={shouldUsePlainShell}
                isActive={isActive && tab.id === activeTabId}
                onProcessComplete={handleProcessComplete}
                minimal={minimal}
                autoConnect={minimal ? true : autoConnect}
                terminalId={tab.id}
              />
            </div>
          ))
        ) : (
          <Shell
            selectedProject={project}
            selectedSession={session}
            initialCommand={command}
            isPlainShell={shouldUsePlainShell}
            isActive={isActive}
            onProcessComplete={handleProcessComplete}
            minimal={minimal}
            autoConnect={minimal ? true : autoConnect}
          />
        )}
      </div>
    </div>
  );
}

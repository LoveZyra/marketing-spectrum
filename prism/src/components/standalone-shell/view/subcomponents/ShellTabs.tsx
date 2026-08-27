import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ShellTab = { id: string; label: string };

type Props = {
  tabs: ShellTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  canAdd: boolean;
};

/**
 * 终端标签条(F10)。
 *
 * 一个终端跑着构建、另一个想看日志 —— 之前只能等,或者去别处开一个 shell。
 * 服务端的 PTY 池本来就按键分,天然支持多个;缺的只是给每个标签一个 id
 * (见 shell-websocket 的 `terminalId`)与这条标签条。
 *
 * 标签**不随切换卸载**:调用方把非活动的终端用 CSS 藏起来而不是拆掉 ——
 * 卸载会断开 websocket,回来时只能靠回放缓冲捞一小段,正在跑的命令看不到了。
 */
export default function ShellTabs({ tabs, activeId, onSelect, onClose, onAdd, canAdd }: Props) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-1 py-0.5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            className={`group flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-t px-2.5 py-1 text-xs transition-colors ${
              isActive ? 'border-b-2 border-primary bg-card font-medium text-foreground' : 'border-b-2 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <span>{tab.label}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                aria-label={t('shellTabs.close', { name: tab.label, defaultValue: `关闭 ${tab.label}` })}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                className={`rounded p-0.5 transition-opacity hover:bg-accent ${isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        disabled={!canAdd}
        title={t('shellTabs.add', '新建终端')}
        aria-label={t('shellTabs.add', '新建终端')}
        className="ml-0.5 flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

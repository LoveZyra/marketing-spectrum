import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, Square } from 'lucide-react';

export type BackgroundTaskItem = { taskId: string; taskType: string; description: string };

type Props = {
  tasks: BackgroundTaskItem[];
  onStop: (taskId: string) => Promise<void> | void;
};

const typeLabelKey = (taskType: string): string => {
  if (taskType.includes('bash') || taskType.includes('shell')) return 'backgroundTasks.types.shell';
  if (taskType.includes('agent')) return 'backgroundTasks.types.agent';
  if (taskType.includes('workflow')) return 'backgroundTasks.types.workflow';
  return 'backgroundTasks.types.task';
};

/**
 * 后台任务条:输入框上方,列出这段对话此刻在后台跑的任务(后台 Bash、后台子代理、workflow),
 * 每个可以单独停。数据来自服务端的 `background_tasks`(CLI 的 `background_tasks_changed`,全量替换)。
 *
 * 服务端声明了能逐个停止后台任务(`perTaskStopAffordance`),所以「停止」只停当前这一轮、
 * 不会连带杀掉后台子代理;后台的东西因此要有个地方看得见、停得掉。
 */
export default function BackgroundTasksBar({ tasks, onStop }: Props) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  if (tasks.length === 0) return null;

  const stop = async (taskId: string) => {
    setStopping((current) => new Set(current).add(taskId));
    try {
      await onStop(taskId);
    } finally {
      // 停成功的那条会随下一次全量表消失;失败的恢复按钮
      setTimeout(() => setStopping((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      }), 4000);
    }
  };

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[52.25rem] rounded-panel border border-border bg-card px-3 py-1.5" data-background-tasks={tasks.length}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />
        <span className="font-medium text-foreground">{t('backgroundTasks.title', { count: tasks.length })}</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate">{tasks.map((task) => task.description || task.taskType).join(' · ')}</span>
        )}
        {open ? <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 pb-0.5">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-center gap-2 rounded-md px-1 py-1 text-[12.5px]">
              <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
                {t(typeLabelKey(task.taskType))}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={task.description}>
                {task.description || task.taskId}
              </span>
              <button
                type="button"
                onClick={() => void stop(task.taskId)}
                disabled={stopping.has(task.taskId)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                aria-label={t('backgroundTasks.stop')}
              >
                <Square className="h-3 w-3" aria-hidden />
                {stopping.has(task.taskId) ? t('backgroundTasks.stopping') : t('backgroundTasks.stop')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  /** 当前会话在服务端挂着常驻运行时 —— 进标题的悬停提示,不再单独占一枚胶囊。 */
  isPersistentSession?: boolean;
  /** ef:就地重命名(设计稿标题右侧那支铅笔)。没给就不出现铅笔。 */
  onRenameSession?: (sessionId: string, summary: string) => Promise<boolean> | boolean;
};

function getTabTitle(activeTab: AppTab, t: (key: string) => string) {
  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'notebook') {
    return 'JupyterLab';
  }

  return 'Project';
}

// Cursor sessions were titled from `name`; Claude sessions only carry a summary.
function getSessionTitle(session: ProjectSession): string {
  return (session.summary as string) || 'New Session';
}

/**
 * 顶栏标题块。
 *
 * ef:两行收成一行 —— 15px / 600 的标题 + 项目名芯片。原来第二行那串等宽坐标
 * (项目 · 路径 · 会话短 id)每个会话都要看一遍,但真正要用到路径的时候一年没几次;
 * 现在收进标题的悬停提示,顶栏省下 24px,主区更宽松。常驻会话也不再单独占一枚
 * 胶囊,同样进提示。标题右侧一支铅笔:就地改名(Enter 保存 / Esc 取消)——
 * 以前改名只能去侧栏悬停找那支笔。
 */
export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  isPersistentSession = false,
  onRenameSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();

  const title = activeTab === 'chat'
    ? (selectedSession ? getSessionTitle(selectedSession) : t('mainContent.newSession'))
    : getTabTitle(activeTab, t);

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sessionId = selectedSession?.id ? String(selectedSession.id) : null;
  const canRename = Boolean(onRenameSession && sessionId && activeTab === 'chat');

  // 换会话时丢掉未提交的草稿 —— 否则改名框会带着上一段对话的标题跟过去。
  useEffect(() => { setDraft(null); }, [sessionId]);
  useEffect(() => {
    if (draft !== null) inputRef.current?.select();
  }, [draft]);

  const commit = async () => {
    if (!sessionId || !onRenameSession || draft === null) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) { setDraft(null); return; }
    setSaving(true);
    try {
      await onRenameSession(sessionId, trimmed);
    } finally {
      setSaving(false);
      setDraft(null);
    }
  };

  const projectPath = selectedProject.fullPath || selectedProject.path || '';
  const shortSessionId = selectedSession?.id ? `sess_${String(selectedSession.id).slice(-6)}` : null;
  const sessionMeta = [
    shortSessionId,
    isPersistentSession ? t('mainContent.persistentSession', { defaultValue: '常驻会话' }) : null,
  ].filter(Boolean).join(' · ');

  const coordinates = (
    <span className="flex flex-col gap-0.5 font-mono text-[11px] leading-4">
      {projectPath && <span className="text-body">{projectPath}</span>}
      {sessionMeta && <span className="text-muted-foreground">{sessionMeta}</span>}
    </span>
  );

  if (draft !== null) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <input
          ref={inputRef}
          data-main-title-input
          value={draft}
          disabled={saving}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') void commit();
            if (event.key === 'Escape') setDraft(null);
          }}
          onBlur={() => void commit()}
          className="h-7 min-w-0 flex-1 rounded-md border border-primary bg-card px-2 text-[15px] font-semibold leading-[26px] text-foreground focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commit()}
          aria-label={t('actions.save', { defaultValue: '保存' })}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-primary transition-colors hover:bg-accent"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setDraft(null)}
          aria-label={t('actions.cancel', { defaultValue: '取消' })}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="group/title flex min-w-0 flex-1 items-center gap-2">
      <Tooltip content={coordinates} position="bottom" wrapperClassName="min-w-0 max-w-full">
        <h2
          data-main-title
          className="truncate text-[15px] font-semibold leading-[26px] text-foreground"
        >
          {title}
        </h2>
      </Tooltip>
      {canRename && (
        <button
          type="button"
          data-main-title-rename
          onClick={() => setDraft(title)}
          aria-label={t('mainContent.renameSession', { defaultValue: '重命名会话' })}
          title={t('mainContent.renameSession', { defaultValue: '重命名会话' })}
          className="grid h-[22px] w-[22px] flex-none place-items-center rounded-md text-border-strong opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/title:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      {/*
        eh:常驻会话要**看得见**。菜单里那行只有点开才看得到,而"这段对话在服务端
        挂着运行时"是会影响下一轮快慢、也占着常驻名额的状态 —— 给它一枚常驻芯片,
        和项目芯片并排(主色底 + 图钉),一眼能认出来。
      */}
      {isPersistentSession && (
        <span
          data-persistent-badge
          title={t('mainContent.persistentSessionHint', {
            defaultValue: '这段对话在服务端挂着常驻运行时，下一轮无需重建进程',
          })}
          className="inline-flex h-6 flex-none items-center gap-1 rounded-full border border-primary/40 bg-primary/[0.08] px-2 text-xs font-medium text-primary dark:text-primary"
        >
          <Pin className="h-3 w-3 flex-none" aria-hidden />
          <span>{t('mainContent.persistentSession', { defaultValue: '常驻会话' })}</span>
        </span>
      )}
      <span
        data-main-project
        title={projectPath || undefined}
        className="inline-flex h-6 flex-none items-center gap-1.5 rounded-full border border-primary/40 px-2.5 text-xs text-foreground dark:border-primary/[0.32]"
      >
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" aria-hidden />
        <span className="max-w-48 truncate">{selectedProject.displayName}</span>
      </span>
    </div>
  );
}

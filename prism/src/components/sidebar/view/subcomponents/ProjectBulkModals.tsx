import { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, ShieldCheck, UserCog, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import PermissionSelector from '../../../project-creation-wizard/components/PermissionSelector';
import type { ProjectVisibilityChoice } from '../../../project-creation-wizard/types';
import type { Project } from '../../../../types/app';
import { authenticatedFetch } from '../../../../utils/api';

/**
 * 批量操作的三个对话框(eo):删除、权限、改所有者。
 *
 * 共同的一条规矩:**先把要动的项目逐条列出来,再让人按按钮**。批量操作最容易
 * 出的事故不是点错按钮,而是"以为选中的是那几个" —— 选择态在侧栏里滚动出屏幕
 * 之后就没人记得清了。所以这三个框都从"这 N 个项目"开始。
 */

const overlay = 'fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-4';
const panel = 'prism-modal-shadow w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card';
const headRow = 'flex items-center justify-between border-b border-border px-5 py-3';
const footRow = 'flex justify-end gap-2 border-t border-border bg-card px-5 py-3';
const ghostButton = 'rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-60';

/** 逐条列出将要被操作的项目:名字 + 会话数 + 路径。 */
function ProjectRoster({ projects, label }: { projects: Project[]; label: string }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[1.2px] text-muted-foreground">{label}</p>
      <div className="max-h-56 overflow-y-auto rounded-md border border-border">
        {projects.map((project, index) => {
          const sessionCount = Number(project.sessionMeta?.total ?? project.sessions?.length ?? 0);
          return (
            <div
              key={project.projectId}
              className={`flex items-center gap-2 px-3 py-1.5 text-[12.5px] ${index > 0 ? 'border-t border-border' : ''}`}
            >
              <span className="min-w-0 flex-1 truncate text-body" title={project.fullPath}>
                {project.displayName}
              </span>
              <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
                {sessionCount} 会话
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectBulkDeleteModal({
  projects, busy, onArchive, onDelete, onClose,
}: {
  projects: Project[];
  busy: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('sidebar');
  const totalSessions = useMemo(
    () => projects.reduce((sum, project) => sum + Number(project.sessionMeta?.total ?? project.sessions?.length ?? 0), 0),
    [projects],
  );

  return ReactDOM.createPortal(
    <div className={overlay}>
      <div className={panel}>
        <div className={headRow}>
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <h3 className="truncate text-sm font-semibold text-foreground">
              {t('project.bulk.deleteTitle', { defaultValue: '批量删除项目' })} · {projects.length}
            </h3>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          <ProjectRoster projects={projects} label={t('project.bulk.willAffect', { defaultValue: '将要操作的项目' })} />
          {/*
            两档说清楚各自动的是什么。用户最怕的问题是"我的代码还在吗" ——
            所以第一句就写明**项目目录本身不动**。
          */}
          <p className="text-xs leading-5 text-body">
            <strong className="font-semibold">归档</strong>:只是从活跃列表里隐藏,随时能在「归档」里恢复,什么都不会删。
          </p>
          <p className="mt-1.5 text-xs leading-5 text-body">
            <strong className="font-semibold text-destructive">彻底删除</strong>:删掉这 {projects.length} 个项目的
            会话记录(共 {totalSessions} 条)与它们的附件目录,<strong className="font-semibold">不可恢复</strong>。
            项目目录本身和里面的代码文件不会被删。
          </p>
        </div>

        <div className={footRow}>
          <button type="button" onClick={onClose} disabled={busy} className={ghostButton}>
            {t('project.bulk.cancel', { defaultValue: '取消' })}
          </button>
          <button
            type="button" onClick={onArchive} disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60"
          >
            {t('project.bulk.archive', { defaultValue: '归档' })}
          </button>
          <button
            type="button" onClick={onDelete} disabled={busy}
            className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy
              ? t('project.bulk.working', { defaultValue: '处理中…' })
              : t('project.bulk.deleteAll', { defaultValue: '彻底删除' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectBulkPermissionsModal({
  projects, busy, onSave, onClose,
}: {
  projects: Project[];
  busy: boolean;
  onSave: (input: { visibility: ProjectVisibilityChoice; sharedUserIds: number[] }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('sidebar');
  const [visibility, setVisibility] = useState<ProjectVisibilityChoice>('personal');
  const [sharedUserIds, setSharedUserIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (visibility === 'shared' && sharedUserIds.length === 0) {
      setError(t('project.permissions.needUsers', { defaultValue: '选择「指定用户」时至少勾选一位用户' }));
      return;
    }
    setError(null);
    onSave({ visibility, sharedUserIds: visibility === 'shared' ? sharedUserIds : [] });
  };

  return ReactDOM.createPortal(
    <div className={overlay}>
      <div className={panel}>
        <div className={headRow}>
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            <h3 className="truncate text-sm font-semibold text-foreground">
              {t('project.bulk.permissionsTitle', { defaultValue: '批量设置权限' })} · {projects.length}
            </h3>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          <ProjectRoster projects={projects} label={t('project.bulk.willAffect', { defaultValue: '将要操作的项目' })} />
          {error && (
            <p className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-body">{error}</p>
          )}
          {/*
            这一句不能省:批量设权限时,不是自己的项目会被服务端跳过。
            不提前说,用户会以为 12 个都改了。
          */}
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            只有你是所有者的项目(以及 root 的全部项目)会被修改,其余会被跳过并在结果里报出来。
          </p>
          <PermissionSelector
            visibility={visibility}
            sharedUserIds={sharedUserIds}
            disabled={busy}
            onVisibilityChange={setVisibility}
            onSharedUserIdsChange={setSharedUserIds}
          />
        </div>

        <div className={footRow}>
          <button type="button" onClick={onClose} disabled={busy} className={ghostButton}>
            {t('project.bulk.cancel', { defaultValue: '取消' })}
          </button>
          <button
            type="button" onClick={submit} disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy
              ? t('project.bulk.working', { defaultValue: '处理中…' })
              : t('project.bulk.apply', { defaultValue: '应用到选中项目' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ShareableUser = { id: number; username: string };

/**
 * 批量改所有者。**root 专用** —— 归属是侧栏过滤的依据,让非所有者改写它,
 * 过滤就没有意义了(服务端同样只认 root,前端的显隐只是礼貌)。
 */
export function ProjectBulkOwnerModal({
  projects, busy, onSave, onClose,
}: {
  projects: Project[];
  busy: boolean;
  onSave: (ownerUserId: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('sidebar');
  const [users, setUsers] = useState<ShareableUser[] | null>(null);
  const [choice, setChoice] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/projects/shareable-users');
        const payload = await response.json().catch(() => null);
        if (!cancelled && response.ok) setUsers((payload?.data?.users as ShareableUser[]) ?? []);
      } catch { if (!cancelled) setUsers([]); }
    })();
    return () => { cancelled = true; };
  }, []);

  return ReactDOM.createPortal(
    <div className={overlay}>
      <div className={panel}>
        <div className={headRow}>
          <div className="flex min-w-0 items-center gap-2">
            <UserCog className="h-4 w-4 shrink-0 text-primary" />
            <h3 className="truncate text-sm font-semibold text-foreground">
              {t('project.bulk.ownerTitle', { defaultValue: '批量改所有者' })} · {projects.length}
            </h3>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          <ProjectRoster projects={projects} label={t('project.bulk.willAffect', { defaultValue: '将要操作的项目' })} />
          <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[1.2px] text-muted-foreground">
            {t('project.bulk.newOwner', { defaultValue: '新的所有者' })}
          </label>
          <select
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
            value={choice} disabled={busy}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">选择一位用户…</option>
            <option value="__none__">置为无主</option>
            {(users ?? []).map((user) => (
              <option key={user.id} value={String(user.id)}>{user.username}</option>
            ))}
          </select>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            「置为无主」之后,项目只有落在公共目录(<code className="font-mono">PRISM_PUBLIC_WORKSPACE</code>)
            下才对所有人可见;否则只有 root 看得到。这一步会写进审计日志。
          </p>
        </div>

        <div className={footRow}>
          <button type="button" onClick={onClose} disabled={busy} className={ghostButton}>
            {t('project.bulk.cancel', { defaultValue: '取消' })}
          </button>
          <button
            type="button" disabled={busy || !choice}
            onClick={() => onSave(choice === '__none__' ? null : Number(choice))}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy
              ? t('project.bulk.working', { defaultValue: '处理中…' })
              : t('project.bulk.apply', { defaultValue: '应用到选中项目' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

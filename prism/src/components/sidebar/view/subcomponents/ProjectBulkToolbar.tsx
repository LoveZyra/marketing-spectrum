import { CheckSquare, ShieldCheck, Square, Star, StarOff, Trash2, UserCog, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 多选工具条(eo)。只在多选态下出现,钉在项目列表上方。
 *
 * 按钮排布刻意把**删除放到最右、并且是唯一带危险色的那个** —— 侧栏窄,几个
 * 小按钮挨在一起,收藏和删除长得一样时手滑的代价不对等。
 */
export default function ProjectBulkToolbar({
  selectedCount, totalCount, allSelected, busy, canChangeOwner,
  onToggleSelectAll, onStar, onUnstar, onPermissions, onOwner, onDelete, onExit,
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  busy: boolean;
  /** root 才画「改所有者」—— 服务端同样只认 root。 */
  canChangeOwner: boolean;
  onToggleSelectAll: () => void;
  onStar: () => void;
  onUnstar: () => void;
  onPermissions: () => void;
  onOwner: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  const { t } = useTranslation('sidebar');
  const action = 'grid h-6 w-6 flex-none place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';
  const disabled = busy || selectedCount === 0;

  return (
    <div
      data-project-bulk-toolbar
      className="mx-2 mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5"
    >
      <button
        type="button" onClick={onToggleSelectAll} disabled={busy}
        className="flex flex-none items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        title={allSelected
          ? t('project.bulk.clearAll', { defaultValue: '取消全选' })
          : t('project.bulk.selectAll', { defaultValue: '全选' })}
      >
        {allSelected ? <CheckSquare className="h-3.5 w-3.5" aria-hidden /> : <Square className="h-3.5 w-3.5" aria-hidden />}
        {t('project.bulk.selectedOf', {
          defaultValue: '已选 {{count}}/{{total}}',
          count: selectedCount,
          total: totalCount,
        })}
      </button>

      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onStar} disabled={disabled} className={action} title={t('project.bulk.star', { defaultValue: '收藏' })}>
          <Star className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" onClick={onUnstar} disabled={disabled} className={action} title={t('project.bulk.unstar', { defaultValue: '取消收藏' })}>
          <StarOff className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" onClick={onPermissions} disabled={disabled} className={action} title={t('project.bulk.permissions', { defaultValue: '设置权限' })}>
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        </button>
        {canChangeOwner && (
          <button type="button" onClick={onOwner} disabled={disabled} className={action} title={t('project.bulk.owner', { defaultValue: '改所有者' })}>
            <UserCog className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button" onClick={onDelete} disabled={disabled}
          className="grid h-6 w-6 flex-none place-items-center rounded-md border border-destructive/40 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
          title={t('project.bulk.delete', { defaultValue: '归档或删除' })}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button" onClick={onExit} disabled={busy}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          title={t('project.bulk.exit', { defaultValue: '退出多选' })}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';

import { useToast } from '../../../../shared/view/ui';
import { useAuth } from '../../../auth/context/AuthContext';
import type { ProjectVisibilityChoice } from '../../../project-creation-wizard/types';
import type { Project } from '../../../../types/app';
import {
  describeBulkResult, type BulkProjectAction, type ProjectBulkSelection,
} from '../../hooks/useProjectBulkSelection';

import {
  ProjectBulkDeleteModal, ProjectBulkOwnerModal, ProjectBulkPermissionsModal,
} from './ProjectBulkModals';
import ProjectBulkToolbar from './ProjectBulkToolbar';

/**
 * 多选面板(eo):工具条 + 三个确认框 + 结果播报。
 *
 * 单独成一个组件,是为了让 `SidebarContent` 只多认识一个 prop —— 那个文件已经
 * 640 行,再塞三个弹窗的状态进去没人看得懂。
 *
 * 结果播报是这里最要紧的一件事:服务端逐条鉴权,不是你的项目会被静默跳过。
 * 选了 12 个只成了 5 个却报「操作成功」,比直接报错更糟。
 */
export default function ProjectBulkPanel({
  bulk, projects,
}: {
  bulk: ProjectBulkSelection;
  /** 当前列表里可见的项目(全选就是全选这一批,不是数据库里所有的)。 */
  projects: Project[];
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'delete' | 'permissions' | 'owner' | null>(null);

  const visibleIds = useMemo(() => projects.map((project) => project.projectId), [projects]);
  const chosen = useMemo(
    () => projects.filter((project) => bulk.selectedIds.has(project.projectId)),
    [projects, bulk.selectedIds],
  );
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => bulk.selectedIds.has(id));

  const run = async (action: BulkProjectAction, verb: string, extra?: Record<string, unknown>) => {
    const result = await bulk.runAction(action, extra);
    if (!result) return;
    setDialog(null);
    const message = describeBulkResult(result, verb);
    // 有跳过或失败就用错误色 —— 同一句话用不同颜色说,才看得出"没全成"
    toast({
      message,
      variant: result.succeeded.length === result.requested ? 'success' : 'error',
    });
  };

  return (
    <>
      <ProjectBulkToolbar
        selectedCount={bulk.selectedCount}
        totalCount={visibleIds.length}
        allSelected={allSelected}
        busy={bulk.isBusy}
        canChangeOwner={user?.isRoot === true}
        onToggleSelectAll={() => bulk.selectMany(visibleIds)}
        onStar={() => void run('star', '收藏')}
        onUnstar={() => void run('unstar', '取消收藏')}
        onPermissions={() => setDialog('permissions')}
        onOwner={() => setDialog('owner')}
        onDelete={() => setDialog('delete')}
        onExit={bulk.exitSelectionMode}
      />

      {dialog === 'delete' && (
        <ProjectBulkDeleteModal
          projects={chosen}
          busy={bulk.isBusy}
          onArchive={() => void run('archive', '归档')}
          onDelete={() => void run('delete', '删除')}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'permissions' && (
        <ProjectBulkPermissionsModal
          projects={chosen}
          busy={bulk.isBusy}
          onSave={(input: { visibility: ProjectVisibilityChoice; sharedUserIds: number[] }) =>
            void run('permissions', '改了权限的', input)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'owner' && (
        <ProjectBulkOwnerModal
          projects={chosen}
          busy={bulk.isBusy}
          onSave={(ownerUserId) => void run('owner', '改了所有者的', { ownerUserId })}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import PermissionSelector from '../../../project-creation-wizard/components/PermissionSelector';
import type { ProjectVisibilityChoice } from '../../../project-creation-wizard/types';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';

type ProjectPermissionsModalProps = {
  project: Project;
  onClose: () => void;
  /** 保存成功后触发(父级用它刷新项目列表,让徽标立即跟上)。 */
  onSaved?: () => void;
};

/**
 * 存量项目的权限管理:与创建向导同一套三选(个人/公共/指定用户),
 * 复用同一个 PermissionSelector。入口只对 owner 和 root 显示;
 * 服务端同样校验(403),前端的显示条件只是礼貌,不是边界。
 */
export default function ProjectPermissionsModal({ project, onClose, onSaved }: ProjectPermissionsModalProps) {
  const { t } = useTranslation('sidebar');
  const [visibility, setVisibility] = useState<ProjectVisibilityChoice>('personal');
  const [sharedUserIds, setSharedUserIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.projectPermissions(project.projectId);
        const payload = (await response.json()) as {
          data?: { visibility?: ProjectVisibilityChoice; sharedUserIds?: number[] };
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || t('project.permissions.loadFailed', { defaultValue: '权限加载失败' }));
        }
        if (!cancelled && payload.data) {
          setVisibility(payload.data.visibility ?? 'personal');
          setSharedUserIds(payload.data.sharedUserIds ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.projectId, t]);

  const handleSave = async () => {
    if (visibility === 'shared' && sharedUserIds.length === 0) {
      setError(t('project.permissions.needUsers', { defaultValue: '选择「指定用户」时至少勾选一位用户' }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.updateProjectPermissions(project.projectId, {
        visibility,
        sharedUserIds: visibility === 'shared' ? sharedUserIds : [],
      });
      const payload = (await response.json()) as { error?: string; details?: string };
      if (!response.ok) {
        throw new Error(payload.details || payload.error || t('project.permissions.saveFailed', { defaultValue: '保存失败' }));
      }
      onSaved?.();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-4">
      <div className="prism-modal-shadow w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            <h3 className="truncate text-sm font-semibold text-foreground">
              {t('project.permissions.title', { defaultValue: '项目权限' })} · {project.displayName}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('project.permissions.close', { defaultValue: '关闭' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {error && (
            <p className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-body">
              {error}
            </p>
          )}
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">…</p>
          ) : (
            <PermissionSelector
              visibility={visibility}
              sharedUserIds={sharedUserIds}
              disabled={saving}
              onVisibilityChange={setVisibility}
              onSharedUserIdsChange={setSharedUserIds}
            />
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            {t('project.permissions.cancel', { defaultValue: '取消' })}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving
              ? t('project.permissions.saving', { defaultValue: '保存中…' })
              : t('project.permissions.save', { defaultValue: '保存' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

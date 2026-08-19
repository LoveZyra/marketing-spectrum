import { useEffect, useState } from 'react';
import { Globe, Lock, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchShareableUsers } from '../data/workspaceApi';
import type { ProjectVisibilityChoice, ShareableUser } from '../types';

type PermissionSelectorProps = {
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
  disabled: boolean;
  onVisibilityChange: (visibility: ProjectVisibilityChoice) => void;
  onSharedUserIdsChange: (userIds: number[]) => void;
};

const OPTIONS: Array<{
  value: ProjectVisibilityChoice;
  icon: typeof Lock;
  labelKey: string;
  helpKey: string;
}> = [
  { value: 'personal', icon: Lock, labelKey: 'projectWizard.permission.personal', helpKey: 'projectWizard.permission.personalHelp' },
  { value: 'public', icon: Globe, labelKey: 'projectWizard.permission.public', helpKey: 'projectWizard.permission.publicHelp' },
  { value: 'shared', icon: Users, labelKey: 'projectWizard.permission.shared', helpKey: 'projectWizard.permission.sharedHelp' },
];

/**
 * 创建项目的权限三选:个人 / 公共 / 指定用户。
 * 选「指定用户」时才拉取用户名录(不含自己),勾选写入 sharedUserIds。
 */
export default function PermissionSelector({
  visibility,
  sharedUserIds,
  disabled,
  onVisibilityChange,
  onSharedUserIdsChange,
}: PermissionSelectorProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<ShareableUser[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (visibility !== 'shared' || users !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchShareableUsers();
        if (!cancelled) {
          setUsers(list);
          setLoadError(false);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visibility, users]);

  const toggleUser = (userId: number) => {
    if (sharedUserIds.includes(userId)) {
      onSharedUserIdsChange(sharedUserIds.filter((id) => id !== userId));
    } else {
      onSharedUserIdsChange([...sharedUserIds, userId]);
    }
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.permission.label')}
      </label>

      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const isActive = visibility === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onVisibilityChange(option.value)}
              className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                isActive
                  ? 'border-primary bg-primary/10'
                  : 'border-gray-200 hover:border-primary/40 dark:border-gray-700'
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white">
                <Icon className={`h-3.5 w-3.5 ${isActive ? 'text-primary' : 'text-gray-400'}`} />
                {t(option.labelKey)}
              </span>
              <span className="text-xs leading-4 text-gray-500 dark:text-gray-400">{t(option.helpKey)}</span>
            </button>
          );
        })}
      </div>

      {visibility === 'shared' && (
        <div className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <p className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('projectWizard.permission.pickUsers')}
            {sharedUserIds.length > 0 && (
              <span className="ml-2 text-primary">
                {t('projectWizard.permission.sharedCount', { count: sharedUserIds.length })}
              </span>
            )}
          </p>
          {loadError ? (
            <p className="text-xs text-red-500">{t('projectWizard.permission.loadUsersFailed')}</p>
          ) : users === null ? (
            <p className="text-xs text-gray-400">…</p>
          ) : users.length === 0 ? (
            <p className="text-xs text-gray-400">{t('projectWizard.permission.noUsers')}</p>
          ) : (
            <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
              {users.map((user) => {
                const checked = sharedUserIds.includes(user.id);
                return (
                  <button
                    key={user.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleUser(user.id)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                      checked
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-gray-300 text-gray-600 hover:border-primary/40 dark:border-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {user.username}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

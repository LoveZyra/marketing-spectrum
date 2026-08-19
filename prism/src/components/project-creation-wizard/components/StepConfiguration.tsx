import { useTranslation } from 'react-i18next';
import type { ProjectVisibilityChoice } from '../types';
import PermissionSelector from './PermissionSelector';
import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onVisibilityChange: (visibility: ProjectVisibilityChoice) => void;
  onSharedUserIdsChange: (userIds: number[]) => void;
  onAdvanceToConfirm: () => void;
};

/**
 * A GitHub URL field and a token card used to sit below the path field: filling
 * the URL switched the wizard onto a clone workflow. Cloning was removed with
 * the rest of the git surface, so a project is a directory that already exists.
 */
export default function StepConfiguration({
  workspacePath,
  visibility,
  sharedUserIds,
  isCreating,
  onWorkspacePathChange,
  onVisibilityChange,
  onSharedUserIdsChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <PermissionSelector
        visibility={visibility}
        sharedUserIds={sharedUserIds}
        disabled={isCreating}
        onVisibilityChange={onVisibilityChange}
        onSharedUserIdsChange={onSharedUserIdsChange}
      />
    </div>
  );
}

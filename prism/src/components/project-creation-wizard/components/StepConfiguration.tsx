import { useTranslation } from 'react-i18next';

import type { ProjectVisibilityChoice } from '../types';

import PermissionSelector from './PermissionSelector';
import TemplateSelector from './TemplateSelector';
import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
  templateId: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onTemplateIdChange: (templateId: string) => void;
  onVisibilityChange: (visibility: ProjectVisibilityChoice) => void;
  onSharedUserIdsChange: (userIds: number[]) => void;
  onAdvanceToConfirm: () => void;
};

/**
 * The wizard's configuration step: the project's directory on the server
 * (created if missing), an optional template and its visibility. There is no
 * clone-from-URL workflow.
 */
export default function StepConfiguration({
  workspacePath,
  visibility,
  sharedUserIds,
  templateId,
  isCreating,
  onWorkspacePathChange,
  onTemplateIdChange,
  onVisibilityChange,
  onSharedUserIdsChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-body">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-muted-foreground">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      {/* 模板选择。没配模板时这块整个不渲染(见 TemplateSelector 顶部)。 */}
      <TemplateSelector value={templateId} disabled={isCreating} onChange={onTemplateIdChange} />

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

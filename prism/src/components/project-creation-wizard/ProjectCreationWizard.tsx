import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../shared/view/ui';
import { useModalKeyboard } from '../../shared/view/hooks/useModalKeyboard';

import ErrorBanner from './components/ErrorBanner';
import StepConfiguration from './components/StepConfiguration';
import StepReview from './components/StepReview';
import WizardFooter from './components/WizardFooter';
import WizardProgress from './components/WizardProgress';
import { createProjectRequest } from './data/workspaceApi';
import type { WizardFormState, WizardStep } from './types';
import { CREATE_PROJECT_ERROR_CODES } from './utils/createProjectErrors';


type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  visibility: 'personal',
  sharedUserIds: [],
  templateId: '',
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * hl 复核:用户动没动过权限选择器。没动过就**不发** visibility —— 路径若命中一个已归档的
   * 项目,服务端据此保留它原来的共享设置,而不是被表单默认的「个人」覆盖掉。
   * 新建项目时不发与发 `personal` 等价(服务端缺省就是个人)。
   */
  const [permissionTouched, setPermissionTouched] = useState(false);

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      if (formState.visibility === 'shared' && formState.sharedUserIds.length === 0) {
        setError(t('projectWizard.permission.needUsers'));
        return;
      }
      setStep(2);
    }
  }, [formState.workspacePath, formState.visibility, formState.sharedUserIds, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  // hl(动态 P2-22):Esc 关(创建中不关)、Tab 不跑到弹窗背后、打开时焦点落进弹窗。
  const dialogRef = useRef<HTMLDivElement>(null);
  const handleEscapeClose = useCallback(() => {
    if (!isCreating) onClose();
  }, [isCreating, onClose]);
  useModalKeyboard(dialogRef, { onClose: handleEscapeClose });
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('input, textarea, select');
    (first ?? dialogRef.current)?.focus();
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);

    try {
      const { project, revived } = await createProjectRequest({
        path: formState.workspacePath.trim(),
        ...(permissionTouched
          ? {
            visibility: formState.visibility,
            sharedUserIds: formState.visibility === 'shared' ? formState.sharedUserIds : [],
          }
          : {}),
        // 空串 = 不用模板,后端据此走原来的空目录流程
        templateId: formState.templateId || undefined,
      });

      // hl(09-24 P2-14):命中已归档路径 = 还原了旧项目(连同旧会话),不是新建 —— 说一声。
      if (revived) {
        toast({
          message: t('projectWizard.revivedTitle', { defaultValue: '已还原一个归档的项目' }),
          description: t('projectWizard.revivedHint', { defaultValue: '这个路径之前已有项目并被归档;现在按你选择的可见性还原了它,旧会话一并回来。' }),
        });
      }

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const code = (createError as { code?: unknown } | null)?.code;
      const errorMessage = typeof code === 'string' && CREATE_PROJECT_ERROR_CODES[code]
        ? t(`projectWizard.errors.codes.${code}`, { defaultValue: CREATE_PROJECT_ERROR_CODES[code] })
        : createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, permissionTouched, t, toast]);

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-0 sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-wizard-title"
        tabIndex={-1}
        className="prism-modal-shadow h-full w-full overflow-y-auto rounded-none border-0 border-border bg-background outline-none sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border"
      >
        <div className="flex items-center justify-between border-b border-border p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.08]">
              <FolderPlus className="h-4 w-4 text-primary" />
            </div>
            <h3 id="project-wizard-title" className="text-lg font-semibold text-foreground">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-body"
            disabled={isCreating}
            aria-label={t('projectWizard.close', { defaultValue: '关闭' })}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepConfiguration
              workspacePath={formState.workspacePath}
              visibility={formState.visibility}
              sharedUserIds={formState.sharedUserIds}
              templateId={formState.templateId}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onTemplateIdChange={(templateId) => updateField('templateId', templateId)}
              onVisibilityChange={(visibility) => { setPermissionTouched(true); updateField('visibility', visibility); }}
              onSharedUserIdsChange={(sharedUserIds) => { setPermissionTouched(true); updateField('sharedUserIds', sharedUserIds); }}
              onAdvanceToConfirm={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <StepReview
              formState={formState}
              isCreating={isCreating}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}

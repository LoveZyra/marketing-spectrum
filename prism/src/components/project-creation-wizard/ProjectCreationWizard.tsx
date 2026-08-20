import { useCallback, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from './components/ErrorBanner';
import StepConfiguration from './components/StepConfiguration';
import StepReview from './components/StepReview';
import WizardFooter from './components/WizardFooter';
import WizardProgress from './components/WizardProgress';
import { createProjectRequest } from './data/workspaceApi';
import type { WizardFormState, WizardStep } from './types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  visibility: 'personal',
  sharedUserIds: [],
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);

    try {
      const project = await createProjectRequest({
        path: formState.workspacePath.trim(),
        visibility: formState.visibility,
        sharedUserIds: formState.visibility === 'shared' ? formState.sharedUserIds : [],
      });

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, t]);

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-0 sm:p-4">
      <div className="prism-modal-shadow h-full w-full overflow-y-auto rounded-none border-0 border-border bg-background sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-border p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.08]">
              <FolderPlus className="h-4 w-4 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-body"
            disabled={isCreating}
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
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onVisibilityChange={(visibility) => updateField('visibility', visibility)}
              onSharedUserIdsChange={(sharedUserIds) => updateField('sharedUserIds', sharedUserIds)}
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

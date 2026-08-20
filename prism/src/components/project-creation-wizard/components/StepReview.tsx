import { useTranslation } from 'react-i18next';

import type { WizardFormState } from '../types';

type StepReviewProps = {
  formState: WizardFormState;
  isCreating: boolean;
};

export default function StepReview({ formState }: StepReviewProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-body">{t('projectWizard.step3.path')}</span>
            <span className="break-all font-mono text-xs text-foreground">
              {formState.workspacePath}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-body">{t('projectWizard.permission.label')}</span>
            <span className="text-xs text-foreground">
              {t(`projectWizard.permission.${formState.visibility}`)}
              {formState.visibility === 'shared'
                && ` · ${t('projectWizard.permission.sharedCount', { count: formState.sharedUserIds.length })}`}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="text-sm text-foreground dark:text-primary">
          {t('projectWizard.step3.newEmpty')}
        </p>
      </div>
    </div>
  );
}

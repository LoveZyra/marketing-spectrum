import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../shared/view/ui';
import type { CreatedApiKey } from '../types';

type NewApiKeyAlertProps = {
  apiKey: CreatedApiKey;
  copiedKey: string | null;
  onCopy: (text: string, id: string) => void;
  onDismiss: () => void;
};

export default function NewApiKeyAlert({
  apiKey,
  copiedKey,
  onCopy,
  onDismiss,
}: NewApiKeyAlertProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-card px-4 py-2.5">
        <h4 className="text-sm font-medium text-foreground">{t('apiKeys.newKey.alertTitle')}</h4>
      </div>
      <div className="p-4">
        <p className="mb-3 text-sm text-muted-foreground">{t('apiKeys.newKey.alertMessage')}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-code">
            {apiKey.apiKey}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCopy(apiKey.apiKey, 'new')}
          >
            {copiedKey === 'new' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <Button size="sm" variant="ghost" className="mt-3" onClick={onDismiss}>
          {t('apiKeys.newKey.iveSavedIt')}
        </Button>
      </div>
    </div>
  );
}

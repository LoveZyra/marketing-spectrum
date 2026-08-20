import { useTranslation } from 'react-i18next';

import PrismLogo from '../../PrismLogo';
import PrismWordmark from '../../PrismWordmark';

const loadingDotAnimationDelays = ['0s', '0.15s', '0.3s'];

export default function AuthLoadingScreen() {
  const { t } = useTranslation('auth');

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div className="relative text-center" role="status" aria-live="polite">
        <div className="mb-5 flex justify-center">
          <PrismLogo size={72} />
        </div>

        <h1 className="mb-4 flex justify-center text-foreground">
          <PrismWordmark height={26} />
        </h1>
        <p className="sr-only">{t('loading')}</p>
        <div aria-hidden className="flex items-center justify-center gap-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-primary"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

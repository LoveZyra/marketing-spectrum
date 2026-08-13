import { Check, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { LLMProvider } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';

import AgentConnectionsStep from './subcomponents/AgentConnectionsStep';
import OnboardingStepProgress from './subcomponents/OnboardingStepProgress';
import { readErrorMessageFromResponse } from './utils';

type OnboardingProps = {
  onComplete?: () => void | Promise<void>;
};

/**
 * Onboarding used to open on a required "Git Configuration" step that wrote
 * `git config --global user.name/user.email` through `/api/user/git-config`.
 * That endpoint went away with the git surface, so connecting an agent is the
 * whole of onboarding now — one step, no Previous/Next.
 */
export default function Onboarding({ onComplete }: OnboardingProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [activeLoginProvider, setActiveLoginProvider] = useState<LLMProvider | null>(null);
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const previousActiveLoginProviderRef = useRef<LLMProvider | null | undefined>(undefined);

  useEffect(() => {
    void refreshProviderAuthStatuses();
  }, [refreshProviderAuthStatuses]);

  useEffect(() => {
    const previousProvider = previousActiveLoginProviderRef.current;
    previousActiveLoginProviderRef.current = activeLoginProvider;

    const didCloseModal = previousProvider !== undefined
      && previousProvider !== null
      && activeLoginProvider === null;

    // Refresh statuses after the login modal is closed.
    if (didCloseModal) {
      void refreshProviderAuthStatuses();
    }
  }, [activeLoginProvider, refreshProviderAuthStatuses]);

  const handleProviderLoginOpen = (provider: LLMProvider) => {
    setActiveLoginProvider(provider);
  };

  const handleLoginComplete = (exitCode: number) => {
    if (exitCode === 0 && activeLoginProvider) {
      void checkProviderAuthStatus(activeLoginProvider);
    }
  };

  const handleFinish = async () => {
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const response = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!response.ok) {
        const message = await readErrorMessageFromResponse(response, 'Failed to complete onboarding');
        throw new Error(message);
      }

      await onComplete?.();
    } catch (caughtError) {
      setErrorMessage(caughtError instanceof Error ? caughtError.message : 'Failed to complete onboarding');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="relative h-screen overflow-y-auto bg-background">
        <div aria-hidden className="pointer-events-none fixed inset-0">
          <div className="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-24 h-[26rem] w-[26rem] rounded-full bg-primary/5 blur-3xl" />
          <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.04)_1px,transparent_1px)] opacity-60 [background-size:22px_22px]" />
        </div>

        <div className="relative mx-auto flex min-h-full w-full max-w-2xl items-center justify-center p-4">
          <div className="w-full py-6">
          <OnboardingStepProgress currentStep={0} />

          <div className="rounded-2xl border border-border/70 bg-card/90 p-6 shadow-[0_24px_60px_-20px_hsl(var(--foreground)/0.18)] ring-1 ring-foreground/5 backdrop-blur-xl">
            <AgentConnectionsStep
              providerStatuses={providerAuthStatus}
              onOpenProviderLogin={handleProviderLoginOpen}
            />

              {errorMessage && (
                <div
                  role="alert"
                  className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 p-3.5"
                >
                  <p className="text-sm text-destructive">{errorMessage}</p>
                </div>
              )}

            <div className="mt-6 flex items-center justify-end border-t border-border pt-5">
              <button
                onClick={handleFinish}
                disabled={isSubmitting}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 font-medium text-white shadow-lg shadow-emerald-600/25 transition-all duration-200 hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Completing...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    Complete Setup
                  </>
                )}
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>

      {activeLoginProvider && (
        <ProviderLoginModal
          isOpen={Boolean(activeLoginProvider)}
          onClose={() => setActiveLoginProvider(null)}
          onComplete={handleLoginComplete}
        />
      )}
    </>
  );
}

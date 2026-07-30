import { lazy, Suspense, type ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

// A one-time flow: after the first run every load pays for this module and
// never renders it. AuthLoadingScreen is already the "we don't know yet" state
// this route shows, so it doubles as the Suspense fallback.
const Onboarding = lazy(() => import('../../onboarding/view/Onboarding'));

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  const onboarding = (
    <Suspense fallback={<AuthLoadingScreen />}>
      <Onboarding onComplete={refreshOnboardingStatus} />
    </Suspense>
  );

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return onboarding;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return onboarding;
  }

  return <>{children}</>;
}

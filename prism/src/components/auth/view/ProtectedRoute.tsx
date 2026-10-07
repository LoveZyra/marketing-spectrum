import { useState, type ReactNode } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';

import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * Auth gate: first-run setup, then login (or self-service registration), then the app.
 *
 * There is no onboarding step: connecting the Claude CLI lives in
 * Settings → Agents → Account, where it can be revisited at any time.
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup } = useAuth();
  const [isRegistering, setIsRegistering] = useState(false);

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return isRegistering
      ? <RegisterForm onBackToLogin={() => setIsRegistering(false)} />
      : <LoginForm onRegister={() => setIsRegistering(true)} />;
  }

  return <>{children}</>;
}

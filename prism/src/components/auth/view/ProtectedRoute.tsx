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
 * Auth gate: setup on first run, then login, then the app.
 *
 * There used to be a fourth state between login and the app — an onboarding
 * screen asking which agent to connect. Claude Code is the only agent this
 * build talks to, so the question had one answer and the screen was a step
 * that could only be clicked through. Connecting the Claude CLI now lives in
 * Settings → Agents → Account, where it can be revisited, rather than in a
 * one-shot flow that a user sees exactly once and cannot get back to.
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

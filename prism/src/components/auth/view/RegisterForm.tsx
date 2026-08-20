import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Lock, User } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type RegisterFormProps = {
  onBackToLogin: () => void;
};

/**
 * Self-service registration.
 *
 * Prism used to allow exactly one account: `/auth/register` refused once a user
 * existed and there was no screen for it beyond first-run setup. Colleagues now
 * sign up here and a root user approves them, so the success state that matters
 * is "submitted, waiting" — not "you're in". That state gets the whole panel
 * rather than a toast, because the next thing the person would otherwise do is
 * try to log in and hit a 403 they have no explanation for.
 */
export default function RegisterForm({ onBackToLogin }: RegisterFormProps) {
  const { t } = useTranslation('auth');
  const { register } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!username.trim() || !password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      if (username.trim().length < 3 || password.length < 6) {
        setErrorMessage(t('register.errors.tooShort'));
        return;
      }

      setIsSubmitting(true);
      const result = await register(username.trim(), password);
      setIsSubmitting(false);

      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }

      if (result.pendingApproval) {
        setPendingMessage(result.message);
      }
      // On immediate approval the auth context has a session and
      // ProtectedRoute swaps this screen out on its own.
    },
    [password, register, t, username],
  );

  if (pendingMessage) {
    return (
      <AuthScreenLayout
        title={t('register.pendingTitle')}
        description={t('register.pendingDescription')}
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-border p-3.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm text-foreground dark:text-primary">{pendingMessage}</p>
          </div>

          <button
            type="button"
            onClick={onBackToLogin}
            className="w-full rounded-lg border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            {t('register.backToLogin')}
          </button>
        </div>
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title={t('register.title')}
      description={t('register.description')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="register-username"
          label={t('login.username')}
          value={username}
          onChange={setUsername}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="register-password"
          label={t('login.password')}
          value={password}
          onChange={setPassword}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="prism-modal-shadow flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors duration-200 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? t('login.loading') : t('register.submit')}
        </button>

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('register.backToLogin')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}

import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '../../../../../../../shared/view/ui';
import ClaudeLogo from '../../../../../../llm-logo-provider/ClaudeLogo';
import type { AuthStatus } from '../../../../../types/types';

type AccountContentProps = {
  authStatus: AuthStatus;
  onLogin: () => void;
};

// This used to take an `agent` prop and index a four-entry palette map with it,
// so that Cursor rendered purple, Codex grey and OpenCode zinc. Claude is the
// only agent left, so the map had one entry and the prop had one value: the
// blue palette is inlined below.
export default function AccountContent({ authStatus, onLogin }: AccountContentProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <ClaudeLogo className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">Claude</h3>
          <p className="text-sm text-muted-foreground">
            {t('agents.account.claude.description', { defaultValue: 'Anthropic Claude AI assistant' })}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="font-medium text-blue-900 dark:text-blue-100">
                {t('agents.connectionStatus')}
              </div>
              <div className="text-sm text-blue-700 dark:text-blue-300">
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {authStatus.loading ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : authStatus.authenticated ? (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-blue-900 dark:text-blue-100">
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className="text-sm text-blue-700 dark:text-blue-300">
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: 'Claude' })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  className="bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-red-600 dark:text-red-400">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

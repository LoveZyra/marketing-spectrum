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
          <h3 className="text-base font-semibold text-foreground">Claude</h3>
          <p className="text-sm text-muted-foreground">
            {t('agents.account.claude.description', { defaultValue: 'Anthropic Claude AI assistant' })}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="font-medium text-foreground">
                {t('agents.connectionStatus')}
              </div>
              <div className="text-sm text-muted-foreground">
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
                <Badge variant="secondary" className="border border-primary/30 bg-transparent text-card-foreground dark:text-primary">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-muted text-foreground">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {authStatus.method !== 'api_key' && (
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-foreground">
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: 'Claude' })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border pt-4">
              <div className="text-sm text-muted-foreground">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

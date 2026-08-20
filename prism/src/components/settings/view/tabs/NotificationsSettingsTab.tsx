import { Bell, Play, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type { NotificationPreferencesState } from '../../types/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
};

export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
          <Volume2 className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">
            {t('notifications.sound.title', { defaultValue: 'Sound' })}
          </h4>
        </div>

        <div className="space-y-4 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', {
                defaultValue: 'Play a short tone when a chat run finishes.',
              })}
            </p>

            <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={notificationPreferences.channels.sound}
                onChange={(event) =>
                  onNotificationPreferencesChange({
                    ...notificationPreferences,
                    channels: {
                      ...notificationPreferences.channels,
                      sound: event.target.checked,
                    },
                  })
                }
                className="h-4 w-4 accent-primary"
              />
              {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
            </label>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void playChatCompletionSound({ force: true });
            }}
          >
            <Play className="h-4 w-4" />
            {t('notifications.sound.test', { defaultValue: 'Test sound' })}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border bg-card px-4 py-2.5">
          <h4 className="text-sm font-medium text-foreground">{t('notifications.events.title')}</h4>
        </div>
        <div className="space-y-3 p-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.actionRequired}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    actionRequired: event.target.checked,
                  },
                })
              }
              className="h-4 w-4 accent-primary"
            />
            {t('notifications.events.actionRequired')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.stop}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    stop: event.target.checked,
                  },
                })
              }
              className="h-4 w-4 accent-primary"
            />
            {t('notifications.events.stop')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.error}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    error: event.target.checked,
                  },
                })
              }
              className="h-4 w-4 accent-primary"
            />
            {t('notifications.events.error')}
          </label>
        </div>
      </div>
    </div>
  );
}

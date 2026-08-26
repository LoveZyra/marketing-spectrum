import { ExternalLink, Key, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../../shared/view/ui';
import type { ApiKeyItem } from '../types';

type ApiKeysSectionProps = {
  apiKeys: ApiKeyItem[];
  showNewKeyForm: boolean;
  newKeyName: string;
  /** 新建失败时的原因;null 表示没有错误。 */
  apiKeyError?: string | null;
  onShowNewKeyFormChange: (value: boolean) => void;
  onNewKeyNameChange: (value: string) => void;
  onCreateApiKey: () => void;
  onCancelCreateApiKey: () => void;
  onToggleApiKey: (keyId: string, isActive: boolean) => void;
  onDeleteApiKey: (keyId: string) => void;
};

export default function ApiKeysSection({
  apiKeys,
  showNewKeyForm,
  newKeyName,
  apiKeyError,
  onShowNewKeyFormChange,
  onNewKeyNameChange,
  onCreateApiKey,
  onCancelCreateApiKey,
  onToggleApiKey,
  onDeleteApiKey,
}: ApiKeysSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">{t('apiKeys.title')}</h3>
        </div>
        <Button size="sm" onClick={() => onShowNewKeyFormChange(!showNewKeyForm)}>
          <Plus className="mr-1 h-4 w-4" />
          {t('apiKeys.newButton')}
        </Button>
      </div>

      <div className="mb-4">
        <p className="mb-2 text-sm text-muted-foreground">{t('apiKeys.description')}</p>
        <a
          href="/api-docs.html"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-card-foreground hover:underline dark:text-primary"
        >
          {t('apiKeys.apiDocsLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {showNewKeyForm && (
        <div className="mb-4 rounded-lg border border-border p-4">
          <Input
            placeholder={t('apiKeys.form.placeholder')}
            value={newKeyName}
            onChange={(event) => onNewKeyNameChange(event.target.value)}
            className="mb-2"
          />
          <div className="flex gap-2">
            <Button onClick={onCreateApiKey}>{t('apiKeys.form.createButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateApiKey}>
              {t('apiKeys.form.cancelButton')}
            </Button>
          </div>
          {/* 失败以前只写进 console —— 界面上一点动静都没有,看着就是"点了没反应"。 */}
          {apiKeyError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {apiKeyError}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {apiKeys.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t('apiKeys.empty')}</p>
        ) : (
          apiKeys.map((key) => (
            <div key={key.id} className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="flex-1">
                <div className="font-medium">{key.key_name}</div>
                <code className="font-mono text-xs text-muted-foreground">{key.api_key}</code>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('apiKeys.list.created')} {new Date(key.created_at).toLocaleDateString()}
                  {key.last_used
                    ? ` - ${t('apiKeys.list.lastUsed')} ${new Date(key.last_used).toLocaleDateString()}`
                    : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* 状态与动作分离:原来一颗按钮上写「激活」,分不清是"当前已激活"
                    还是"点我去激活"。现在左边是**状态**(圆点 + 使用中/已停用,
                    不可点),右边是**动作**(停用/启用,动词,点了会发生什么一目了然)。 */}
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                    key.is_active
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-border bg-muted text-muted-foreground'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${key.is_active ? 'bg-primary' : 'bg-muted-foreground/60'}`}
                    aria-hidden
                  />
                  {key.is_active ? t('apiKeys.status.active') : t('apiKeys.status.inactive')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onToggleApiKey(key.id, key.is_active)}
                  title={key.is_active
                    ? t('apiKeys.action.disableHint', { defaultValue: '停用后,用这把密钥的请求会被拒绝' })
                    : t('apiKeys.action.enableHint', { defaultValue: '启用后,这把密钥即可用于外部 API 请求' })}
                >
                  {key.is_active ? t('apiKeys.action.disable') : t('apiKeys.action.enable')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDeleteApiKey(key.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

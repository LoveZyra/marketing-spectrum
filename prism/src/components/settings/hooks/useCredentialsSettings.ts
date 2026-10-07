import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import type {
  ApiKeyItem,
  ApiKeysResponse,
  CreatedApiKey,
  GithubCredentialItem,
  GithubCredentialsResponse,
} from '../view/tabs/api-settings/types';
import { copyTextToClipboard } from '../../../utils/clipboard';

type UseCredentialsSettingsArgs = {
  confirmDeleteApiKeyText: string;
  confirmDeleteGithubCredentialText: string;
};

const getApiError = (payload: { error?: string } | undefined, fallback: string) => (
  payload?.error || fallback
);

type CredentialLists = {
  /** null 表示没拉到(非 2xx、不是 JSON、请求失败),调用方保留旧列表并提示。 */
  apiKeys: ApiKeyItem[] | null;
  githubCredentials: GithubCredentialItem[] | null;
};

const readList = async <T,>(
  request: () => Promise<Response>,
  pick: (payload: Record<string, unknown>) => unknown,
): Promise<T[] | null> => {
  try {
    const response = await request();
    if (!response.ok) {
      return null;
    }
    const list = pick(await response.json() as Record<string, unknown>);
    return Array.isArray(list) ? list as T[] : [];
  } catch {
    return null;
  }
};

/**
 * 拉 API key 与 GitHub 凭证两张列表,两边互不连累。
 *
 * 拉失败的一边返回 null 而不是空列表:当成空列表的话界面显示「没有任何 key」,
 * 临时故障时用户会以为 key 丢了,去重建或找管理员。
 */
export const fetchCredentialLists = async (fetchFn: typeof authenticatedFetch = authenticatedFetch): Promise<CredentialLists> => {
  const [apiKeys, githubCredentials] = await Promise.all([
    readList<ApiKeyItem>(
      async () => fetchFn('/api/settings/api-keys'),
      (payload) => (payload as ApiKeysResponse).apiKeys,
    ),
    readList<GithubCredentialItem>(
      async () => fetchFn('/api/settings/credentials?type=github_token'),
      (payload) => (payload as GithubCredentialsResponse).credentials,
    ),
  ]);
  return { apiKeys, githubCredentials };
};

/**
 * API keys (`/api/settings/api-keys`) and GitHub tokens (`/api/settings/credentials`).
 *
 * Prism's own UI does no version control, but the external `/api/agent` endpoint
 * clones repositories and opens pull requests, and it reads its GitHub token from
 * here when the request body does not carry one. This screen is the only way to
 * store that token.
 */
export function useCredentialsSettings({
  confirmDeleteApiKeyText,
  confirmDeleteGithubCredentialText,
}: UseCredentialsSettingsArgs) {
  const { toast } = useToast();
  // 增删 / 启停失败都要给提示:删除或停用一把 key 却没反应,用户无法判断成没成功。
  const notifyFailure = useCallback((message: string) => {
    toast({ message, variant: 'error' });
  }, [toast]);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [githubCredentials, setGithubCredentials] = useState<GithubCredentialItem[]>([]);
  const [apiKeysLoadFailed, setApiKeysLoadFailed] = useState(false);
  const [githubCredentialsLoadFailed, setGithubCredentialsLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');

  const [showNewGithubForm, setShowNewGithubForm] = useState(false);
  const [newGithubName, setNewGithubName] = useState('');
  const [newGithubToken, setNewGithubToken] = useState('');
  const [newGithubDescription, setNewGithubDescription] = useState('');

  const [showToken, setShowToken] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<CreatedApiKey | null>(null);
  /**
   * 新建密钥失败时显示给用户的错误信息。
   *
   * 失败原因(例如数据库约束错误)往往只在服务端日志里;不在出错的地方说出来,
   * 界面就表现成「点了创建没反应」。
   */
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const lists = await fetchCredentialLists();
    // 拉失败的一边保留旧列表,只打失败标记,界面据此提示并给重试。
    if (lists.apiKeys) {
      setApiKeys(lists.apiKeys);
    }
    if (lists.githubCredentials) {
      setGithubCredentials(lists.githubCredentials);
    }
    setApiKeysLoadFailed(lists.apiKeys === null);
    setGithubCredentialsLoadFailed(lists.githubCredentials === null);
    setLoading(false);
  }, []);

  const createApiKey = useCallback(async () => {
    if (!newKeyName.trim()) {
      return;
    }

    setApiKeyError(null);
    try {
      const response = await authenticatedFetch('/api/settings/api-keys', {
        method: 'POST',
        body: JSON.stringify({ keyName: newKeyName.trim() }),
      });

      const payload = await response.json() as ApiKeysResponse;
      if (!response.ok || !payload.success) {
        const message = getApiError(payload, 'Failed to create API key');
        console.error('Error creating API key:', message);
        setApiKeyError(message);
        return;
      }

      if (payload.apiKey) {
        setNewlyCreatedKey(payload.apiKey);
      }
      setNewKeyName('');
      setShowNewKeyForm(false);
      await fetchData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error creating API key:', error);
      setApiKeyError(message);
    }
  }, [fetchData, newKeyName]);

  const deleteApiKey = useCallback(async (keyId: string) => {
    if (!window.confirm(confirmDeleteApiKeyText)) {
      return;
    }

    try {
      const response = await authenticatedFetch(`/api/settings/api-keys/${keyId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const payload = await response.json() as ApiKeysResponse;
        console.error('Error deleting API key:', getApiError(payload, 'Failed to delete API key'));
        notifyFailure(getApiError(payload, '删除 API Key 失败'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error deleting API key:', error);
      notifyFailure('删除 API Key 出错,请重试');
    }
  }, [confirmDeleteApiKeyText, fetchData, notifyFailure]);

  const toggleApiKey = useCallback(async (keyId: string, isActive: boolean) => {
    try {
      const response = await authenticatedFetch(`/api/settings/api-keys/${keyId}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (!response.ok) {
        const payload = await response.json() as ApiKeysResponse;
        console.error('Error toggling API key:', getApiError(payload, 'Failed to toggle API key'));
        notifyFailure(getApiError(payload, '切换 API Key 状态失败'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error toggling API key:', error);
      notifyFailure('切换 API Key 状态出错,请重试');
    }
  }, [fetchData, notifyFailure]);

  const createGithubCredential = useCallback(async () => {
    if (!newGithubName.trim() || !newGithubToken.trim()) {
      return;
    }

    try {
      const response = await authenticatedFetch('/api/settings/credentials', {
        method: 'POST',
        body: JSON.stringify({
          credentialName: newGithubName.trim(),
          credentialType: 'github_token',
          credentialValue: newGithubToken,
          description: newGithubDescription.trim(),
        }),
      });

      const payload = await response.json() as GithubCredentialsResponse;
      if (!response.ok || !payload.success) {
        console.error('Error creating GitHub credential:', getApiError(payload, 'Failed to create GitHub credential'));
        notifyFailure(getApiError(payload, '创建 GitHub 凭证失败'));
        return;
      }

      setNewGithubName('');
      setNewGithubToken('');
      setNewGithubDescription('');
      setShowNewGithubForm(false);
      setShowToken((prev) => ({ ...prev, new: false }));
      await fetchData();
    } catch (error) {
      console.error('Error creating GitHub credential:', error);
      notifyFailure('创建 GitHub 凭证出错,请重试');
    }
  }, [fetchData, newGithubDescription, newGithubName, newGithubToken, notifyFailure]);

  const deleteGithubCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteGithubCredentialText)) {
      return;
    }

    try {
      const response = await authenticatedFetch(`/api/settings/credentials/${credentialId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error deleting GitHub credential:', getApiError(payload, 'Failed to delete GitHub credential'));
        notifyFailure(getApiError(payload, '删除 GitHub 凭证失败'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error deleting GitHub credential:', error);
      notifyFailure('删除 GitHub 凭证出错,请重试');
    }
  }, [confirmDeleteGithubCredentialText, fetchData, notifyFailure]);

  const toggleGithubCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      const response = await authenticatedFetch(`/api/settings/credentials/${credentialId}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error toggling GitHub credential:', getApiError(payload, 'Failed to toggle GitHub credential'));
        notifyFailure(getApiError(payload, '切换 GitHub 凭证状态失败'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error toggling GitHub credential:', error);
      notifyFailure('切换 GitHub 凭证状态出错,请重试');
    }
  }, [fetchData, notifyFailure]);

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await copyTextToClipboard(text);
      setCopiedKey(id);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, []);

  const dismissNewlyCreatedKey = useCallback(() => {
    setNewlyCreatedKey(null);
  }, []);

  const cancelNewApiKeyForm = useCallback(() => {
    setShowNewKeyForm(false);
    setNewKeyName('');
    setApiKeyError(null);
  }, []);

  const cancelNewGithubForm = useCallback(() => {
    setShowNewGithubForm(false);
    setNewGithubName('');
    setNewGithubToken('');
    setNewGithubDescription('');
    setShowToken((prev) => ({ ...prev, new: false }));
  }, []);

  const toggleNewGithubTokenVisibility = useCallback(() => {
    setShowToken((prev) => ({ ...prev, new: !prev.new }));
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    apiKeys,
    githubCredentials,
    apiKeysLoadFailed,
    githubCredentialsLoadFailed,
    reload: fetchData,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    copiedKey,
    newlyCreatedKey,
    apiKeyError,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  };
}

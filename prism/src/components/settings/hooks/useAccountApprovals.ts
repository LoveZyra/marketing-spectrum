import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type AdminUser = {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  reviewed_by: number | null;
  reviewed_by_username: string | null;
};

type AdminUsersResponse = {
  success?: boolean;
  users?: AdminUser[];
  error?: string;
};

/**
 * The root-only account list and its two decisions.
 *
 * Every call here 403s for a non-root account, which is the intended behaviour
 * and not something the UI tries to pre-empt: the panel is hidden from
 * non-root, and the server is what actually enforces it.
 */
export function useAccountApprovals(enabled: boolean) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/admin/users');
      const payload = (await response.json()) as AdminUsersResponse;
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load accounts');
      }
      setUsers(payload.users ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load accounts');
      setUsers([]);
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = useCallback(
    async (userId: number, decision: 'approve' | 'reject') => {
      setBusyUserId(userId);
      setError(null);
      try {
        const response = await authenticatedFetch(`/api/admin/users/${userId}/${decision}`, {
          method: 'POST',
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as AdminUsersResponse;
          throw new Error(payload.error || 'Failed to update the account');
        }
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to update the account');
      } finally {
        setBusyUserId(null);
      }
    },
    [refresh],
  );

  /** root 重置某账号密码。成功后该账号所有设备被踢出,需用新密码重登。 */
  const resetPassword = useCallback(
    async (userId: number, newPassword: string): Promise<boolean> => {
      setBusyUserId(userId);
      setError(null);
      try {
        const response = await authenticatedFetch(`/api/admin/users/${userId}/reset-password`, {
          method: 'POST',
          body: JSON.stringify({ newPassword }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as AdminUsersResponse;
          throw new Error(payload.error || 'Failed to reset password');
        }
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to reset password');
        return false;
      } finally {
        setBusyUserId(null);
      }
    },
    [],
  );

  /** 停用/启用账号。停用即时踢出该账号全部会话。 */
  const setActive = useCallback(
    async (userId: number, active: boolean) => {
      setBusyUserId(userId);
      setError(null);
      try {
        const response = await authenticatedFetch(
          `/api/admin/users/${userId}/${active ? 'activate' : 'deactivate'}`,
          { method: 'POST' },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as AdminUsersResponse;
          throw new Error(payload.error || 'Failed to update the account');
        }
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to update the account');
      } finally {
        setBusyUserId(null);
      }
    },
    [refresh],
  );

  return { users, isLoading, error, busyUserId, refresh, decide, resetPassword, setActive };
}

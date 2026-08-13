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

  return { users, isLoading, error, busyUserId, refresh, decide };
}

import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  /** Derived from PRISM_ROOT_USERS on the server; never stored in the database. */
  isRoot?: boolean;
  [key: string]: unknown;
};

export type AuthActionResult =
  | { success: true; pendingApproval?: false }
  /**
   * Registration succeeded but the account is waiting for a root user to
   * approve it. There is no session — the caller must show `message` rather
   * than assume it can navigate into the app.
   */
  | { success: true; pendingApproval: true; message: string }
  | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  pendingApproval?: boolean;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};

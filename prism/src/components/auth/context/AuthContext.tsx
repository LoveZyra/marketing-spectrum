import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { api } from '../../../utils/api';
import { decodeJwtPayload } from '../../../utils/tokenRefresh';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      if (!token) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [clearSession, token]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      setIsLoading(false);
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus]);

  // 全局 401 兜底:api.js 拿到 401(令牌过期/被撤销)会派发这个事件,这里清会话
  // 跳回登录。不调登出端点 —— 令牌已经无效,再打一枪没意义。
  useEffect(() => {
    if (IS_PLATFORM) return;
    const onExpired = () => clearSession();
    window.addEventListener('prism:session-expired', onExpired);
    return () => window.removeEventListener('prism:session-expired', onExpired);
  }, [clearSession]);

  // dj:同一浏览器的其他标签页换了账号/退出时,本页跟上 —— 此前旧标签页会
  // 继续挂着旧账号的界面,而它发出去的请求其实已经带着新账号的令牌,身份错位。
  // storage 事件只在**其他**标签页触发,不会响应本页自己的写入。
  // 同一用户的静默续期(localStorage 已被写入方更新)刻意不动 React 状态,
  // 避免 WebSocket 因 token 变化整个重连。
  useEffect(() => {
    if (IS_PLATFORM) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_TOKEN_STORAGE_KEY) return;
      if (!event.newValue) {
        clearSession();
        return;
      }
      const nextUserId = decodeJwtPayload(event.newValue)?.userId;
      const currentUserId = token ? decodeJwtPayload(token)?.userId : null;
      if (nextUserId != null && currentUserId != null && nextUserId === currentUserId) return;
      // 换了人(或本页原本停在登录页):整页按新身份重启,是最干净的一致性。
      window.location.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [clearSession, token]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        // A pending account is a successful registration with no session
        // attached. Treating the missing token as a failure would tell someone
        // who just signed up correctly that registration failed.
        if (response.ok && payload?.pendingApproval) {
          return {
            success: true,
            pendingApproval: true,
            message: payload.message ?? AUTH_ERROR_MESSAGES.pendingApproval,
          };
        }

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [setSession],
  );

  const logout = useCallback(() => {
    const tokenToInvalidate = token;
    clearSession();

    if (tokenToInvalidate) {
      // 本地已清,localStorage 里没有令牌了;把捕获的旧令牌显式带上,登出
      // 事件才能落进服务端审计日志(此前这一枪永远 401,从没记上过)。
      void api.auth.logout({ token: tokenToInvalidate }).catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      });
    }
  }, [clearSession, token]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      error,
      login,
      register,
      logout,
    }),
    [
      error,
      isLoading,
      login,
      logout,
      needsSetup,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

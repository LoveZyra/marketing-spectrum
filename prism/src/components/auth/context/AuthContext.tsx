import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { api } from '../../../utils/api';
import { clearLocalAccountStateOnLogout } from '../../../utils/accountSettings';
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
  /**
   * 登录 / 注册刚拿到的会话跳过下一次状态核验:响应里已经带了 user,无需再核验。
   *
   * `checkAuthStatus` 依赖 `token`,登录后 token 变化会让 effect 重跑并 `setIsLoading(true)`,
   * ProtectedRoute 随之换成加载页、整个 AppContent 卸载再挂载:首屏的 /api 请求
   * (项目列表、运行中会话、偏好……)全部重发一遍,中间还闪一下加载页。
   */
  const skipNextStatusCheckRef = useRef(false);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    skipNextStatusCheckRef.current = true;
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
    if (skipNextStatusCheckRef.current) {
      skipNextStatusCheckRef.current = false;
      return;
    }
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

  // 全局 401 兜底:api.js 收到 401(令牌过期 / 被撤销)时派发这个事件,这里清会话跳回登录。
  // 不调登出端点:令牌已经无效,再调一次没有意义。
  useEffect(() => {
    if (IS_PLATFORM) return;
    const onExpired = () => clearSession();
    window.addEventListener('prism:session-expired', onExpired);
    return () => window.removeEventListener('prism:session-expired', onExpired);
  }, [clearSession]);

  // 同一浏览器的其他标签页换了账号或退出时,本页跟着切换:否则本页还挂着旧账号的界面,
  // 发出的请求却已带上新账号的令牌,身份错位。storage 事件只在其他标签页写入时触发。
  // 同一用户的静默续期(写入方已更新 localStorage)刻意不动 React 状态,免得 WebSocket 因 token 变化整个重连。
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
    /**
     * 要作废的令牌以 localStorage 里那张为准,React state 只作兜底。
     *
     * 静默续期(`X-Refreshed-Token`)与改密都只更新 localStorage、刻意不动 React state,
     * 所以这里捕获的 `token` 可能已经过时;改密后服务端 token_version 已加一,旧令牌随之作废,
     * 拿它调 logout 必然 401,登出事件就进不了审计日志。
     */
    let tokenToInvalidate: string | null = token;
    try {
      const stored = localStorage.getItem('auth-token');
      if (stored) tokenToInvalidate = stored;
    } catch { /* 隐私模式等取不到就用 state 里那张 */ }
    // 登出时清掉本机草稿与时间戳,否则下一个在这台浏览器登录的人会把上一个人的草稿当成自己的推上去。
    // 同步键不在这里清(同一个人再登录不必整页重载);换人时由主人标记在拉取前清。
    clearLocalAccountStateOnLogout();
    clearSession();

    if (tokenToInvalidate) {
      // 本地令牌已清,必须显式带上捕获的令牌,登出事件才能记进服务端审计日志。
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

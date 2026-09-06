import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { AuthApiClient, type AuthStatus } from "../../services/api/auth";
import { clearAuthenticatedClientCaches } from "../ai-access/clear-ai-caches";

interface AuthContextValue {
  status: AuthStatus | null;
  loading: boolean;
  error: string | null;
  startFeishuLogin: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => new AuthApiClient(), []);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    // A new browser load may already carry a different Feishu session cookie.
    // Clear user-scoped snapshots before trusting any authenticated response.
    clearAuthenticatedClientCaches(window.localStorage);
    try {
      const nextStatus = await client.getStatus();
      setStatus(nextStatus);
      setError(null);
    } catch {
      setStatus(null);
      setError("暂时无法确认身份状态，请检查服务连接。");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const startFeishuLogin = useCallback(async () => {
    if (status?.mode !== "feishu") {
      setError("登录服务暂未就绪，请稍后再试。");
      return;
    }
    window.location.assign(client.getFeishuStartEndpoint());
  }, [client, status?.mode]);

  const logout = useCallback(async () => {
    setLoading(true);
    clearAuthenticatedClientCaches(window.localStorage);
    try {
      await client.logout();
      await refreshStatus();
    } catch {
      setError("退出登录暂时不可用，请稍后重试。");
      setLoading(false);
    }
  }, [client, refreshStatus]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    loading,
    error,
    startFeishuLogin,
    logout,
  }), [error, loading, logout, startFeishuLogin, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}

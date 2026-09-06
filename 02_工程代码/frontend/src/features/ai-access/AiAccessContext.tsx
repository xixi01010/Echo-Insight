import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import {
  AiSettingsApiClient,
  type AiSettingsStatus,
  type VisitorAiProviderId,
} from "../../services/api/ai-settings";
import { clearAiDerivedClientCaches } from "./clear-ai-caches";

interface AiAccessContextValue {
  status: AiSettingsStatus | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  revision: number;
  refresh: () => Promise<void>;
  connect: (providerId: VisitorAiProviderId, apiKey: string) => Promise<boolean>;
  skip: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const AiAccessContext = createContext<AiAccessContextValue | null>(null);

export function AiAccessProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => new AiSettingsApiClient(), []);
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await client.getStatus());
      setError(null);
    } catch {
      setStatus(null);
      setError("暂时无法读取 AI 连接状态，请检查服务连接后重试。");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = useCallback(async (providerId: VisitorAiProviderId, apiKey: string) => {
    setPending(true);
    setError(null);
    clearAiDerivedClientCaches(window.localStorage);
    try {
      const nextStatus = await client.connect(providerId, apiKey);
      setStatus(nextStatus);
      setRevision((value) => value + 1);
      return true;
    } catch {
      setError("连接验证未通过。请确认平台、API Key 与账户余额后重试。");
      return false;
    } finally {
      setPending(false);
    }
  }, [client]);

  const skip = useCallback(async () => {
    setPending(true);
    setError(null);
    clearAiDerivedClientCaches(window.localStorage);
    try {
      setStatus(await client.skip());
      setRevision((value) => value + 1);
    } catch {
      setError("暂时无法保存本次选择，请稍后重试。");
    } finally {
      setPending(false);
    }
  }, [client]);

  const disconnect = useCallback(async () => {
    setPending(true);
    setError(null);
    clearAiDerivedClientCaches(window.localStorage);
    try {
      const nextStatus = await client.disconnect();
      setStatus(nextStatus);
      setRevision((value) => value + 1);
    } catch {
      setError("暂时无法断开 AI 连接，请稍后重试。");
    } finally {
      setPending(false);
    }
  }, [client]);

  const value = useMemo<AiAccessContextValue>(() => ({
    status,
    loading,
    pending,
    error,
    revision,
    refresh,
    connect,
    skip,
    disconnect,
  }), [connect, disconnect, error, loading, pending, refresh, revision, skip, status]);

  return <AiAccessContext.Provider value={value}>{children}</AiAccessContext.Provider>;
}

export function useAiAccess(): AiAccessContextValue {
  const context = useContext(AiAccessContext);
  if (!context) throw new Error("useAiAccess must be used inside AiAccessProvider.");
  return context;
}

import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react";

import {
  AiSettingsApiClient,
  AiSettingsApiError,
  GlobalInsightsApiClient,
  ProjectApiClient,
  ProjectReportApiClient,
  type AiSettingsStatus,
  type VisitorAiProviderId,
} from "../../services/api";
import {
  GlobalSynthesisSession,
  globalSynthesisSession,
} from "../global-insights/synthesis-session";

export type WorkspaceRuntimeMode = "account" | "demo";

export interface AiSettingsClient {
  getStatus(): Promise<AiSettingsStatus>;
  connect(providerId: VisitorAiProviderId, apiKey: string): Promise<AiSettingsStatus>;
  skip(): Promise<AiSettingsStatus>;
  disconnect(): Promise<AiSettingsStatus>;
}

interface WorkspaceRuntimeValue {
  mode: WorkspaceRuntimeMode;
  authenticated: boolean;
  enterAccount: () => void;
  projectClient: ProjectApiClient;
  projectReportClient: ProjectReportApiClient;
  globalInsightsClient: GlobalInsightsApiClient;
  aiSettingsClient: AiSettingsClient;
  cacheStorage: Storage;
  synthesisSession: GlobalSynthesisSession;
}

interface WorkspaceRuntimeProviderProps extends PropsWithChildren {
  mode: WorkspaceRuntimeMode;
  authenticated: boolean;
  onEnterAccount: () => void;
}

const WorkspaceRuntimeContext = createContext<WorkspaceRuntimeValue | null>(null);

export function WorkspaceRuntimeProvider({
  authenticated,
  children,
  mode,
  onEnterAccount,
}: WorkspaceRuntimeProviderProps) {
  const runtime = useMemo<WorkspaceRuntimeValue>(() => {
    const cacheStorage = mode === "demo" ? createMemoryStorage() : getBrowserStorage();
    const fetcher = mode === "demo" ? createDemoApiFetch() : globalThis.fetch.bind(globalThis);
    return {
      mode,
      authenticated,
      enterAccount: onEnterAccount,
      projectClient: new ProjectApiClient(fetcher),
      projectReportClient: new ProjectReportApiClient(fetcher),
      globalInsightsClient: new GlobalInsightsApiClient(fetcher),
      aiSettingsClient: mode === "demo" ? createDemoAiSettingsClient() : new AiSettingsApiClient(fetcher),
      cacheStorage,
      synthesisSession: new GlobalSynthesisSession(),
    };
  }, [authenticated, mode, onEnterAccount]);

  return (
    <WorkspaceRuntimeContext.Provider value={runtime}>
      {children}
    </WorkspaceRuntimeContext.Provider>
  );
}

export function useWorkspaceRuntime(): WorkspaceRuntimeValue {
  return useContext(WorkspaceRuntimeContext) ?? getFallbackRuntime();
}

export function createDemoApiFetch(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return Promise.reject(new TypeError("Demo API only accepts URL inputs."));
    }
    return fetcher(resolveDemoApiEndpoint(String(input)), init);
  }) as typeof fetch;
}

export function resolveDemoApiEndpoint(endpoint: string): string {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//iu.test(endpoint);
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(endpoint, origin);
  if (!url.pathname.startsWith("/api/")) {
    throw new TypeError("Demo API cannot access a non-API endpoint.");
  }
  url.pathname = `/api/demo${url.pathname.slice(4)}`;
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

let fallbackRuntime: WorkspaceRuntimeValue | null = null;

function getFallbackRuntime(): WorkspaceRuntimeValue {
  fallbackRuntime ??= {
    mode: "account",
    authenticated: true,
    enterAccount: () => undefined,
    projectClient: new ProjectApiClient(),
    projectReportClient: new ProjectReportApiClient(),
    globalInsightsClient: new GlobalInsightsApiClient(),
    aiSettingsClient: new AiSettingsApiClient(),
    cacheStorage: getBrowserStorage(),
    synthesisSession: globalSynthesisSession,
  };
  return fallbackRuntime;
}

function getBrowserStorage(): Storage {
  if (typeof window === "undefined") return createMemoryStorage();
  try {
    return window.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear() { entries.clear(); },
    getItem(key) { return entries.get(key) ?? null; },
    key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(key) { entries.delete(key); },
    setItem(key, value) { entries.set(key, String(value)); },
  };
}

function createDemoAiSettingsClient(): AiSettingsClient {
  const status: AiSettingsStatus = {
    mode: "visitor",
    configured: false,
    setupRequired: false,
    storage: "server-session-memory",
  };
  const rejectWrite = async (): Promise<AiSettingsStatus> => {
    throw new AiSettingsApiError(405);
  };
  return {
    getStatus: async () => status,
    connect: rejectWrite,
    skip: rejectWrite,
    disconnect: rejectWrite,
  };
}

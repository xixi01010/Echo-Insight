import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createFeishuClient,
  FeishuBaseReader,
  type FeishuApiClient,
  type ProjectDataReader,
} from "../../feishu-connector/src/index.js";
import {
  createAiProviderBundle,
  type AiProviderBundle,
} from "../../ai-service/src/index.js";
import {
  CachedProjectAnalysisService,
  ProjectAnalysisService,
} from "./analysis-service/index.js";
import { ProjectReportService } from "./ai-analysis-service/index.js";
import {
  GlobalInsightService,
  GlobalInsightSynthesisService,
} from "./global-insight/index.js";
import {
  FeishuCurrentUserContextProvider,
  FeishuSessionUserCredentialProvider,
  HttpFeishuIdentityVerifier,
  HttpFeishuResourceMembershipVerifier,
  InMemoryFeishuSessionStore,
  JsonVisitorAiAccountStore,
  readFeishuIdentityConfiguration,
  readDevelopmentCurrentUserContextProvider,
  readVisitorAiAccountMasterKey,
  type CurrentUserContext,
  type CurrentUserContextProvider,
  type FeishuIdentityVerifier,
  type FeishuIdentityWithAccessTokenVerifier,
  type FeishuSessionStore,
  type VisitorAiAccountStore,
} from "./current-user/index.js";
import {
  createDevelopmentProjectRuntime,
  type DevelopmentProjectRuntime,
  ProjectContextReportService,
  ProjectContextSummaryService,
  ProjectDataSourceConfigurationService,
  ProjectSourceBindingService,
  ProjectSourceConfigurationService,
  FeishuProjectJoinService,
  type ProjectDataSourceSubject,
  type ProjectSourceOperationalState,
} from "./project-context/index.js";
import { ProjectService } from "./project-service/index.js";
import {
  createBaseBackedProjectIntelligenceProvider,
  createRealTenantCandidateExtractor,
  ProjectIntelligenceQueryService,
} from "./intelligence/index.js";
import { createProjectAnalysisRoute } from "./routes/project-analysis.js";
import { createProjectReportRoute } from "./routes/project-report.js";
import { createProjectDataRoute } from "./routes/project-data.js";
import { createProjectsRoute, isProjectsApiPath } from "./routes/projects.js";
import { createAuthRoute, isAuthApiPath } from "./routes/auth.js";
import {
  createRealTenantDevLocatorRoute,
  isRealTenantDevLocatorPath,
} from "./routes/real-tenant-dev.js";
import {
  createRealTenantValidationRoute,
  isRealTenantValidationEnabled,
  isRealTenantValidationPath,
} from "./routes/real-tenant-validation.js";
import {
  createInsightsRoute,
  createInsightsSynthesisRoute,
  isInsightsApiPath,
  isInsightsSynthesisApiPath,
} from "./routes/insights.js";
import {
  createAiSettingsRoute,
  isAiSettingsApiPath,
  isServerAiProviderConfigured,
  readAiAccessMode,
} from "./routes/ai-settings.js";
import {
  ensureRuntimeStorageDirectory,
  resolveRuntimeStoragePaths,
  type RuntimeStoragePaths,
} from "./runtime-storage.js";

const PROJECT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
const CONNECTOR_ENV_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../feishu-connector/.env",
);
const DEFAULT_RUNTIME_STORAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.runtime",
);

if (process.env.ECHO_INSIGHT_SKIP_ENV_FILE_LOAD !== "1") {
  loadOptionalEnvFile(PROJECT_ENV_FILE);
  if (!hasFeishuEnvironment()) {
    loadOptionalEnvFile(CONNECTOR_ENV_FILE);
  }
}

function loadOptionalEnvFile(path: string): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function hasFeishuEnvironment(): boolean {
  return ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BASE_TOKEN"].every(
    (name) => Boolean(process.env[name]?.trim()),
  );
}
interface ServerDependencies {
  reader?: ProjectDataReader;
  baseToken?: string;
  analysisService?: ProjectAnalysisService;
  reportService?: ProjectReportService;
  currentUserContextProvider?: CurrentUserContextProvider;
  feishuIdentityVerifier?: FeishuIdentityVerifier;
  feishuSessionStore?: FeishuSessionStore;
  visitorAiAccountStore?: VisitorAiAccountStore;
  projectService?: ProjectService;
  projectContextReportService?: ProjectContextReportService;
  projectContextSummaryService?: ProjectContextSummaryService;
  projectDataSourceConfigurationService?: ProjectDataSourceConfigurationService;
  projectSourceConfigurationService?: ProjectSourceConfigurationService;
  projectSourceBindingService?: ProjectSourceBindingService;
  projectIntelligenceQueryService?: ProjectIntelligenceQueryService;
  projectJoinService?: FeishuProjectJoinService;
  globalInsightService?: GlobalInsightService;
  globalInsightSynthesisService?: GlobalInsightSynthesisService;
  aiProviderBundleFactory?: (environment: NodeJS.ProcessEnv) => AiProviderBundle;
  verifyVisitorAiProviderBundle?: (bundle: AiProviderBundle) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  projectStorePath?: string;
  dataSourceRegistryPath?: string;
  visitorAiAccountStorePath?: string;
  allowedFrontendOrigin?: string;
}

export function createEchoInsightServer(
  dependencies: ServerDependencies = {},
): Server {
  let reader = dependencies.reader;
  let feishuClient: FeishuApiClient | undefined;

  let reportService = dependencies.reportService;
  let sharedAnalyzer: CachedProjectAnalysisService | undefined;
  let sharedBaseReader: ProjectDataReader | undefined;
  let projectRuntime: DevelopmentProjectRuntime | undefined;
  let globalInsightSynthesisService: GlobalInsightSynthesisService | undefined;
  let projectJoinService: FeishuProjectJoinService | undefined;
  let projectIntelligenceQueryService: ProjectIntelligenceQueryService | undefined;
  let userCredentialProvider: FeishuSessionUserCredentialProvider | undefined;
  let projectSourceBindingService: ProjectSourceBindingService | undefined;
  let aiProviderBundle: AiProviderBundle | undefined;
  let visitorAiAccountStore = dependencies.visitorAiAccountStore;
  let runtimeStoragePaths: RuntimeStoragePaths | undefined;
  let unavailableReportService: ProjectReportService | undefined;
  let unavailableGlobalInsightSynthesisService: GlobalInsightSynthesisService | undefined;
  const visitorReportServices = new WeakMap<AiProviderBundle, ProjectReportService>();
  const visitorGlobalSynthesisServices = new WeakMap<AiProviderBundle, GlobalInsightSynthesisService>();
  const projectSourceOperationalStates = new Map<string, ProjectSourceOperationalState>();
  const environment = dependencies.environment ?? process.env;
  const aiAccessMode = readAiAccessMode(environment);
  const feishuIdentityConfiguration = readFeishuIdentityConfiguration(environment);
  const feishuSessionStore = dependencies.feishuSessionStore
    ?? (feishuIdentityConfiguration ? new InMemoryFeishuSessionStore() : undefined);
  const feishuIdentityVerifier = dependencies.feishuIdentityVerifier
    ?? (feishuIdentityConfiguration
      ? new HttpFeishuIdentityVerifier(feishuIdentityConfiguration)
      : undefined);
  const currentUserContextProvider = dependencies.currentUserContextProvider
    ?? (feishuSessionStore && feishuIdentityConfiguration
      ? new FeishuCurrentUserContextProvider(feishuSessionStore)
      : readDevelopmentCurrentUserContextProvider(environment));
  const allowedFrontendOrigin = dependencies.allowedFrontendOrigin
    ?? readAllowedFrontendOrigin(environment);
  const getRuntimeStoragePaths = (): RuntimeStoragePaths => {
    if (runtimeStoragePaths) return runtimeStoragePaths;
    runtimeStoragePaths = resolveRuntimeStoragePaths(environment, DEFAULT_RUNTIME_STORAGE_DIRECTORY);
    ensureRuntimeStorageDirectory(runtimeStoragePaths);
    return runtimeStoragePaths;
  };
  const getVisitorAiAccountStore = (): VisitorAiAccountStore | undefined => {
    if (aiAccessMode !== "visitor" || !feishuSessionStore) return undefined;
    visitorAiAccountStore ??= new JsonVisitorAiAccountStore(
      dependencies.visitorAiAccountStorePath ?? getRuntimeStoragePaths().visitorAiAccountStorePath,
      readVisitorAiAccountMasterKey(environment),
    );
    return visitorAiAccountStore;
  };
  const getFeishuClient = (): FeishuApiClient => {
    feishuClient ??= createFeishuClient();
    return feishuClient;
  };
  const getReader = (): ProjectDataReader => {
    reader ??= new FeishuBaseReader(getFeishuClient());
    return reader;
  };
  const getBaseToken = (): string =>
    dependencies.baseToken ?? requireEnvironment("FEISHU_BASE_TOKEN");
  const getSharedAnalyzer = (): CachedProjectAnalysisService => {
    sharedAnalyzer ??= new CachedProjectAnalysisService(
      dependencies.analysisService ?? new ProjectAnalysisService(getReader()),
    );
    return sharedAnalyzer;
  };
  const getSharedBaseReader = (): ProjectDataReader => {
    sharedBaseReader ??= {
      readProjectData: async (baseToken) => (await getSharedAnalyzer().analyzeProject(baseToken)).projectData,
    };
    return sharedBaseReader;
  };
  const invalidateSharedAnalysis = (): void => {
    if (sharedAnalyzer instanceof CachedProjectAnalysisService) sharedAnalyzer.invalidate();
  };
  const getAiProviderBundle = (): AiProviderBundle => {
    aiProviderBundle ??= (dependencies.aiProviderBundleFactory ?? createAiProviderBundle)(environment);
    return aiProviderBundle;
  };
  const getReportService = (): ProjectReportService => {
    reportService ??= new ProjectReportService(
      getSharedAnalyzer(),
      getAiProviderBundle().riskAnalyzer,
      120_000,
    );
    return reportService;
  };
  const getSessionAiProviderBundle = (
    subject: ProjectDataSourceSubject | CurrentUserContext,
  ): AiProviderBundle | undefined => {
    if (aiAccessMode === "server") return getAiProviderBundle();
    if (!subject.sessionId || !feishuSessionStore) return undefined;
    const session = feishuSessionStore.get(subject.sessionId);
    if (!session || session.userId !== subject.userId) return undefined;
    return session.aiProvider?.bundle;
  };
  const getReportServiceForSubject = (
    subject: ProjectDataSourceSubject,
  ): ProjectReportService => {
    if (dependencies.reportService) return dependencies.reportService;
    if (aiAccessMode === "server") return getReportService();
    const bundle = getSessionAiProviderBundle(subject);
    if (!bundle) {
      unavailableReportService ??= new ProjectReportService(
        getSharedAnalyzer(),
        unavailableRiskAnalyzer,
      );
      return unavailableReportService;
    }
    const cached = visitorReportServices.get(bundle);
    if (cached) return cached;
    const service = new ProjectReportService(getSharedAnalyzer(), bundle.riskAnalyzer, 120_000);
    visitorReportServices.set(bundle, service);
    return service;
  };
  const getProjectRuntime = (): DevelopmentProjectRuntime => {
    const runtimeStoragePaths = (() => {
      if (dependencies.projectStorePath && dependencies.dataSourceRegistryPath) {
        return {
          projectStorePath: dependencies.projectStorePath,
          dataSourceRegistryPath: dependencies.dataSourceRegistryPath,
        };
      }
      return getRuntimeStoragePaths();
    })();
    projectRuntime ??= createDevelopmentProjectRuntime({
      environment,
      projectStorePath: dependencies.projectStorePath ?? runtimeStoragePaths.projectStorePath,
      dataSourceRegistryPath: dependencies.dataSourceRegistryPath ?? runtimeStoragePaths.dataSourceRegistryPath,
      analysisService: getSharedAnalyzer(),
      invalidateAnalysisCache: invalidateSharedAnalysis,
      reportService: getReportServiceForSubject,
      validateFeishuBase: async (baseToken) => {
        const projectReader = getReader();
        if (hasBaseInfoReader(projectReader)) {
          const baseInfo = await projectReader.getBaseInfo(baseToken);
          return typeof baseInfo.name === "string"
            ? { displayName: baseInfo.name }
            : undefined;
        }
        const projectData = await projectReader.readProjectData(baseToken);
        return { displayName: projectData.project.name };
      },
      seedProject: !dependencies.projectService,
      ...(dependencies.projectService
        ? { projectService: dependencies.projectService }
        : {}),
    });
    return projectRuntime;
  };
  const getGlobalInsightService = (): GlobalInsightService => (
    dependencies.globalInsightService ?? getProjectRuntime().globalInsightService
  );
  const getGlobalInsightSynthesisService = (): GlobalInsightSynthesisService => {
    globalInsightSynthesisService ??= dependencies.globalInsightSynthesisService
      ?? new GlobalInsightSynthesisService(
        getGlobalInsightService(),
        getAiProviderBundle().globalSynthesizer,
      );
    return globalInsightSynthesisService;
  };
  const getGlobalInsightSynthesisServiceForSubject = (
    subject: CurrentUserContext,
  ): GlobalInsightSynthesisService => {
    if (dependencies.globalInsightSynthesisService) {
      return dependencies.globalInsightSynthesisService;
    }
    if (aiAccessMode === "server") return getGlobalInsightSynthesisService();
    const bundle = getSessionAiProviderBundle(subject);
    if (!bundle) {
      unavailableGlobalInsightSynthesisService ??= new GlobalInsightSynthesisService(
        getGlobalInsightService(),
        unavailableGlobalSynthesizer,
      );
      return unavailableGlobalInsightSynthesisService;
    }
    const cached = visitorGlobalSynthesisServices.get(bundle);
    if (cached) return cached;
    const service = new GlobalInsightSynthesisService(
      getGlobalInsightService(),
      bundle.globalSynthesizer,
    );
    visitorGlobalSynthesisServices.set(bundle, service);
    return service;
  };
  const getProjectJoinService = (): FeishuProjectJoinService | undefined => {
    if (dependencies.projectJoinService) return dependencies.projectJoinService;
    if (!feishuIdentityConfiguration || !isFeishuIdentityWithAccessTokenVerifier(feishuIdentityVerifier)) {
      return undefined;
    }
    projectJoinService ??= new FeishuProjectJoinService(
      dependencies.projectService ?? getProjectRuntime().projectService,
      getProjectRuntime().dataSourceRegistry,
      feishuIdentityVerifier,
      new HttpFeishuResourceMembershipVerifier(),
      feishuIdentityConfiguration,
    );
    return projectJoinService;
  };
  const getProjectIntelligenceQueryService = (): ProjectIntelligenceQueryService => {
    projectIntelligenceQueryService ??= dependencies.projectIntelligenceQueryService
      ?? new ProjectIntelligenceQueryService(
        dependencies.projectService ?? getProjectRuntime().projectService,
        createBaseBackedProjectIntelligenceProvider(
          dependencies.projectService ?? getProjectRuntime().projectService,
          getProjectRuntime().dataSourceRegistry,
          getSharedBaseReader(),
          dependencies.reader ? undefined : getFeishuClient(),
          undefined,
          getUserCredentialProvider(),
          createRealTenantCandidateExtractor(),
          (record) => {
            projectSourceOperationalStates.set(
              projectSourceOperationalStateKey(record.projectId, record.sourceRef, record.subjectUserId),
              {
                freshness: record.state,
                visibility: record.authorizationState,
                ...(record.lastSuccessfulReadAt ? { lastSuccessfulReadAt: record.lastSuccessfulReadAt } : {}),
                ...(record.latestFailureCategory ? { failureCategory: record.latestFailureCategory } : {}),
              },
            );
          },
        ),
      );
    return projectIntelligenceQueryService;
  };
  const getUserCredentialProvider = (): FeishuSessionUserCredentialProvider | undefined => {
    if (!feishuSessionStore || !isFeishuIdentityWithAccessTokenVerifier(feishuIdentityVerifier)) return undefined;
    userCredentialProvider ??= new FeishuSessionUserCredentialProvider(feishuSessionStore, feishuIdentityVerifier);
    return userCredentialProvider;
  };

  const projectDataRoute = createProjectDataRoute({
    getReader,
    getBaseToken,
  });
  const projectAnalysisRoute = createProjectAnalysisRoute({
    getAnalysisService: getSharedAnalyzer,
    getBaseToken,
  });  const projectReportRoute = createProjectReportRoute({
    getReportService,
    getBaseToken,
  });
  const authRoute = createAuthRoute({
    getCurrentUserContextProvider: () => currentUserContextProvider,
    getIdentityVerifier: () => feishuIdentityVerifier,
    getSessionStore: () => feishuSessionStore,
    getProjectJoinService,
    ...(feishuIdentityConfiguration ? { feishuAppId: feishuIdentityConfiguration.appId } : {}),
    ...(feishuIdentityConfiguration ? { feishuRedirectUri: feishuIdentityConfiguration.redirectUri } : {}),
    ...(allowedFrontendOrigin ? { frontendOrigin: allowedFrontendOrigin } : {}),
    secureCookies: environment.NODE_ENV === "production",
  });
  const aiSettingsRoute = createAiSettingsRoute({
    mode: aiAccessMode,
    getCurrentUserContextProvider: () => currentUserContextProvider,
    getSessionStore: () => feishuSessionStore,
    getVisitorAccountStore: getVisitorAiAccountStore,
    getServerBundle: getAiProviderBundle,
    isServerConfigured: () => isServerAiProviderConfigured(environment),
    ...(dependencies.aiProviderBundleFactory
      ? { createVisitorBundle: dependencies.aiProviderBundleFactory }
      : {}),
    ...(dependencies.verifyVisitorAiProviderBundle
      ? { verifyBundle: dependencies.verifyVisitorAiProviderBundle }
      : {}),
  });
  const realTenantDevLocatorRoute = isLocalRealTenantValidation(environment)
    ? createRealTenantDevLocatorRoute({
      getCurrentUserContextProvider: () => currentUserContextProvider,
      getUserCredentialProvider,
      getFeishuClient,
    })
    : undefined;
  const realTenantValidationRoute = isRealTenantValidationEnabled(environment)
    ? createRealTenantValidationRoute({
      getCurrentUserContextProvider: () => currentUserContextProvider,
      getUserCredentialProvider,
      getFeishuClient,
      getProjectService: () => dependencies.projectService ?? getProjectRuntime().projectService,
      getRegistry: () => getProjectRuntime().dataSourceRegistry,
      ensureReady: () => getProjectRuntime().ensureReady(),
      getIntelligence: getProjectIntelligenceQueryService,
    })
    : undefined;
  const projectsRoute = createProjectsRoute({
    getCurrentUserContextProvider: () => currentUserContextProvider,
    getProjectService: () => dependencies.projectService ?? getProjectRuntime().projectService,
    getProjectContextReportService: () => (
      dependencies.projectContextReportService
      ?? getProjectRuntime().projectContextReportService
    ),
    getProjectContextSummaryService: () => (
      dependencies.projectContextSummaryService
      ?? getProjectRuntime().projectContextSummaryService
    ),
    getProjectDataSourceConfigurationService: () => (
      dependencies.projectDataSourceConfigurationService
      ?? getProjectRuntime().projectDataSourceConfigurationService
    ),
    getProjectSourceConfigurationService: () => (
      dependencies.projectSourceConfigurationService
      ?? new ProjectSourceConfigurationService(
        dependencies.projectService ?? getProjectRuntime().projectService,
        getProjectRuntime().dataSourceRegistry,
        undefined,
        undefined,
        (projectId, sourceRef, subject) => projectSourceOperationalStates.get(
          projectSourceOperationalStateKey(projectId, sourceRef, subject.userId),
        ),
      )
    ),
    getProjectSourceBindingService: () => (
      dependencies.projectSourceBindingService
      ?? (projectSourceBindingService ??= new ProjectSourceBindingService(
          dependencies.projectService ?? getProjectRuntime().projectService,
          getUserCredentialProvider(),
          getFeishuClient,
        ))
    ),
    getProjectIntelligenceQueryService,
    getProjectJoinService,
    ensureProjectRuntimeReady: () => (
      dependencies.projectService ? Promise.resolve() : getProjectRuntime().ensureReady()
    ),
    secureCookies: environment.NODE_ENV === "production",
  });
  const insightsRoute = createInsightsRoute({
    getCurrentUserContextProvider: () => currentUserContextProvider,
    getGlobalInsightService: () => (
      getGlobalInsightService()
    ),
    getGlobalInsightSynthesisService: getGlobalInsightSynthesisServiceForSubject,
    ensureProjectRuntimeReady: () => (
      dependencies.projectService ? Promise.resolve() : getProjectRuntime().ensureReady()
    ),
  });
  const insightsSynthesisRoute = createInsightsSynthesisRoute({
    getCurrentUserContextProvider: () => currentUserContextProvider,
    getGlobalInsightService,
    getGlobalInsightSynthesisService: getGlobalInsightSynthesisServiceForSubject,
    ensureProjectRuntimeReady: () => (
      dependencies.projectService ? Promise.resolve() : getProjectRuntime().ensureReady()
    ),
  });

  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (
      environment.ECHO_INSIGHT_ENABLE_LEGACY_API !== "1"
      && ["/api/project-data", "/api/project-analysis", "/api/project-report"].includes(requestUrl.pathname)
    ) {
      sendNotFound(response);
      return;
    }

    if (requestUrl.pathname === "/api/project-data") {
      await projectDataRoute(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/project-analysis") {
      await projectAnalysisRoute(request, response);
      return;
    }
    if (requestUrl.pathname === "/api/project-report") {
      applyProjectReportCors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      await projectReportRoute(request, response);
      return;
    }

    if (isAuthApiPath(requestUrl.pathname)) {
      applyV2Cors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (
        requestUrl.pathname === "/api/auth/logout"
        && !isAllowedV2Write(request, environment, allowedFrontendOrigin)
      ) {
        sendCrossOriginWriteDenied(response);
        return;
      }
      await authRoute(request, response, requestUrl);
      return;
    }

    if (isAiSettingsApiPath(requestUrl.pathname)) {
      applyV2Cors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!isAllowedV2Write(request, environment, allowedFrontendOrigin)) {
        sendCrossOriginWriteDenied(response);
        return;
      }
      await aiSettingsRoute(request, response, requestUrl);
      return;
    }

    if (realTenantDevLocatorRoute && isRealTenantDevLocatorPath(requestUrl.pathname)) {
      await realTenantDevLocatorRoute(request, response, requestUrl);
      return;
    }

    if (realTenantValidationRoute && isRealTenantValidationPath(requestUrl.pathname)) {
      await realTenantValidationRoute(request, response, requestUrl);
      return;
    }

    if (isProjectsApiPath(requestUrl.pathname)) {
      applyV2Cors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!isAllowedV2Write(request, environment, allowedFrontendOrigin)) {
        sendCrossOriginWriteDenied(response);
        return;
      }
      await projectsRoute(request, response, requestUrl);
      return;
    }

    if (isInsightsSynthesisApiPath(requestUrl.pathname)) {
      applyV2Cors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!isAllowedV2Write(request, environment, allowedFrontendOrigin)) {
        sendCrossOriginWriteDenied(response);
        return;
      }
      await insightsSynthesisRoute(request, response, requestUrl);
      return;
    }

    if (isInsightsApiPath(requestUrl.pathname)) {
      applyV2Cors(request, response, allowedFrontendOrigin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      await insightsRoute(request, response);
      return;
    }

    sendNotFound(response);
  });
}

function projectSourceOperationalStateKey(projectId: string, sourceRef: string, userId: string): string {
  return `${projectId}\u0000${sourceRef}\u0000${userId}`;
}

function readAllowedFrontendOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment.FRONTEND_ORIGIN?.trim();
  if (!value) return undefined;

  try {
    return new URL(value).origin;
  } catch {
    throw new Error("FRONTEND_ORIGIN must be an absolute URL.");
  }
}

function isLocalRealTenantValidation(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV !== "production" && environment.ECHO_INSIGHT_REAL_TENANT_DEV === "1";
}

function applyProjectReportCors(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  allowedFrontendOrigin: string | undefined,
): void {
  const requestOrigin = request.headers.origin;
  if (!allowedFrontendOrigin || requestOrigin !== allowedFrontendOrigin) return;

  response.setHeader("Access-Control-Allow-Origin", allowedFrontendOrigin);
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Vary", "Origin");
}

function applyV2Cors(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  allowedFrontendOrigin: string | undefined,
): void {
  const requestOrigin = request.headers.origin;
  if (!allowedFrontendOrigin || requestOrigin !== allowedFrontendOrigin) return;

  response.setHeader("Access-Control-Allow-Origin", allowedFrontendOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("Vary", "Origin");
}

function isAllowedV2Write(
  request: import("node:http").IncomingMessage,
  environment: NodeJS.ProcessEnv,
  allowedFrontendOrigin: string | undefined,
): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) return true;
  if (environment.NODE_ENV !== "production") return true;
  return Boolean(allowedFrontendOrigin && request.headers.origin === allowedFrontendOrigin);
}

function sendCrossOriginWriteDenied(response: import("node:http").ServerResponse): void {
  response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    error: { code: "CROSS_ORIGIN_WRITE_DENIED", message: "Cross-origin write is not allowed." },
  }));
}

function sendNotFound(response: import("node:http").ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    error: { code: "NOT_FOUND", message: "Route not found." },
  }));
}

const unavailableRiskAnalyzer = {
  async analyze(): Promise<never> {
    throw new Error("Visitor AI provider is not configured.");
  },
};

const unavailableGlobalSynthesizer = {
  async synthesize(): Promise<never> {
    throw new Error("Visitor AI provider is not configured.");
  },
};
function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} environment variable.`);
  return value;
}

function hasBaseInfoReader(
  reader: ProjectDataReader,
): reader is ProjectDataReader & { getBaseInfo(baseToken: string): Promise<{ name?: unknown }> } {
  return "getBaseInfo" in reader && typeof reader.getBaseInfo === "function";
}

function isFeishuIdentityWithAccessTokenVerifier(
  verifier: FeishuIdentityVerifier | undefined,
): verifier is FeishuIdentityWithAccessTokenVerifier {
  return Boolean(
    verifier
    && "exchangeAuthorizationCodeWithAccessToken" in verifier
    && typeof verifier.exchangeAuthorizationCodeWithAccessToken === "function",
  );
}

const entryPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

async function startStandaloneServer(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  const runtimeStoragePaths = resolveRuntimeStoragePaths(
    process.env,
    DEFAULT_RUNTIME_STORAGE_DIRECTORY,
  );
  ensureRuntimeStorageDirectory(runtimeStoragePaths);
  if (readAiAccessMode(process.env) === "visitor" && readFeishuIdentityConfiguration(process.env)) {
    const accountStore = new JsonVisitorAiAccountStore(
      runtimeStoragePaths.visitorAiAccountStorePath,
      readVisitorAiAccountMasterKey(process.env),
    );
    await accountStore.verify();
  }
  console.log("Echo Insight runtime storage ready.");
  const server = createEchoInsightServer();
  server.listen(port, () => {
    console.log(`Echo Insight backend listening on http://localhost:${port}`);
  });
}

if (entryPath === import.meta.url) {
  startStandaloneServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error.";
    console.error(`Echo Insight backend startup failed: ${message}`);
    process.exitCode = 1;
  });
}


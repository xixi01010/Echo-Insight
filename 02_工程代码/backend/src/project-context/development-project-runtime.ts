import type { ProjectReportService } from "../ai-analysis-service/index.js";
import type { ProjectAnalysisService } from "../analysis-service/index.js";
import { GlobalInsightService } from "../global-insight/index.js";
import {
  JsonProjectRepository,
  ProjectService,
} from "../project-service/index.js";
import { ProjectContextReportService } from "./project-context-report-service.js";
import { ProjectContextSummaryService } from "./project-context-summary-service.js";
import { ProjectDataSourceConfigurationService } from "./project-data-source-configuration-service.js";
import { JsonProjectDataSourceRegistry } from "./project-data-source-registry.js";
import { ProjectContextService } from "./project-context-service.js";
import {
  ProjectDataSourceResolver,
  type ProjectDataSourceRegistration,
} from "./project-data-source-resolver.js";
import type { ProjectDataSourceSubject } from "./project-data-source-visibility.js";

const DEVELOPMENT_SEED_ENABLED = "true";

export interface DevelopmentProjectRuntime {
  projectService: ProjectService;
  dataSourceRegistry: JsonProjectDataSourceRegistry;
  projectContextReportService: ProjectContextReportService;
  projectContextSummaryService: ProjectContextSummaryService;
  globalInsightService: GlobalInsightService;
  projectDataSourceConfigurationService: ProjectDataSourceConfigurationService;
  ensureReady(): Promise<void>;
}

export interface CreateDevelopmentProjectRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  projectStorePath: string;
  dataSourceRegistryPath: string;
  analysisService: Pick<ProjectAnalysisService, "analyzeProject">;
  reportService: Pick<ProjectReportService, "createProjectReport"> | ((
    subject: ProjectDataSourceSubject,
  ) => Pick<ProjectReportService, "createProjectReport">);
  invalidateAnalysisCache?: () => void;
  validateFeishuBase: (baseToken: string) => Promise<void | { displayName?: string }>;
  projectService?: ProjectService;
  seedProject?: boolean;
}

/**
 * Builds the V2 development composition. Credentials stay in environment
 * variables; the JSON store contains only opaque data-source references.
 */
export function createDevelopmentProjectRuntime(
  options: CreateDevelopmentProjectRuntimeOptions,
): DevelopmentProjectRuntime {
  const environment = options.environment ?? process.env;
  const projectService = options.projectService
    ?? new ProjectService(new JsonProjectRepository(options.projectStorePath));
  const dataSourceRegistry = new JsonProjectDataSourceRegistry(options.dataSourceRegistryPath);
  const dataSourceResolver = new ProjectDataSourceResolver(dataSourceRegistry);
  const contextService = new ProjectContextService(projectService, dataSourceResolver);
  const projectContextReportService = new ProjectContextReportService(
    contextService,
    options.reportService,
  );
  const projectContextSummaryService = new ProjectContextSummaryService(
    contextService,
    options.analysisService,
  );
  const globalInsightService = new GlobalInsightService(
    projectService,
    contextService,
    options.analysisService,
  );
  const projectDataSourceConfigurationService = new ProjectDataSourceConfigurationService(
    projectService,
    dataSourceRegistry,
    options.validateFeishuBase,
    (projectId) => {
      projectContextSummaryService.invalidate(projectId);
      globalInsightService.invalidate(projectId);
      options.invalidateAnalysisCache?.();
    },
  );
  let initialization: Promise<void> | undefined;

  return {
    projectService,
    dataSourceRegistry,
    projectContextReportService,
    projectContextSummaryService,
    globalInsightService,
    projectDataSourceConfigurationService,
    ensureReady: () => {
      initialization ??= dataSourceRegistry.ensureReady().then(() => (
        options.seedProject
          ? ensureDevelopmentSeed(projectService, dataSourceRegistry, environment)
          : undefined
      ));
      return initialization;
    },
  };
}

export function readDevelopmentDataSourceRegistry(
  environment: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, ProjectDataSourceRegistration> {
  if (environment.NODE_ENV === "production") return new Map();

  const ref = environment.ECHO_INSIGHT_DEV_DATA_SOURCE_REF?.trim();
  const baseToken = environment.FEISHU_BASE_TOKEN?.trim();
  if (!ref || !baseToken) return new Map();

  return new Map([
    [ref, { kind: "feishu-base", baseToken }],
  ]);
}

async function ensureDevelopmentSeed(
  projectService: ProjectService,
  dataSourceRegistry: JsonProjectDataSourceRegistry,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    environment.NODE_ENV === "production"
    || environment.ECHO_INSIGHT_DEV_SEED_PROJECT !== DEVELOPMENT_SEED_ENABLED
  ) {
    return;
  }

  const userId = requireDevelopmentSetting(environment, "ECHO_INSIGHT_DEV_USER_ID");
  const dataSourceRef = requireDevelopmentSetting(
    environment,
    "ECHO_INSIGHT_DEV_DATA_SOURCE_REF",
  );
  requireDevelopmentSetting(environment, "FEISHU_BASE_TOKEN");

  const existingProjects = await projectService.listProjects(userId);
  const existingSourceProject = existingProjects.find((project) => (
    project.dataSourceRefs.includes(dataSourceRef)
  ));
  if (existingSourceProject) {
    if (!dataSourceRegistry.getForProject(existingSourceProject.id, dataSourceRef)) {
      await dataSourceRegistry.registerFeishuBase(
        existingSourceProject.id,
        dataSourceRef,
        requireDevelopmentSetting(environment, "FEISHU_BASE_TOKEN"),
      );
    }
    return;
  }
  if (existingProjects.length > 0) return;

  const project = await projectService.createProject({
    name: environment.ECHO_INSIGHT_DEV_PROJECT_NAME?.trim()
      || "Echo Insight Development Project",
    creatorId: userId,
    ownerId: userId,
    dataSourceRefs: [dataSourceRef],
  });
  await dataSourceRegistry.registerFeishuBase(
    project.id,
    dataSourceRef,
    requireDevelopmentSetting(environment, "FEISHU_BASE_TOKEN"),
  );
}

function requireDevelopmentSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value) return value;
  throw new Error(`Missing ${name} for development project runtime.`);
}

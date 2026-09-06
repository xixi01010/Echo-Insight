import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CurrentUserContextUnavailableError,
  createJoinOAuthStateCookie,
  readCookie,
  type CurrentUserContextProvider,
  FEISHU_SESSION_COOKIE,
} from "../current-user/index.js";
import {
  ProjectContextSummaryService,
  ProjectContextAccessDeniedError,
  ProjectContextReportService,
  ProjectDataSourceAccessDeniedError,
  ProjectDataSourceConfigurationService,
  ProjectDataSourceForbiddenError,
  ProjectDataSourceResolutionError,
  ProjectDataSourceUrlError,
  ProjectDataSourceValidationError,
  ProjectSourceConfigurationInputError,
  ProjectSourceConfigurationService,
  ProjectSourceBindingInputError,
  ProjectSourceBindingService,
  ProjectSourceBindingUnavailableError,
  type ConfigureProjectSourceInput,
  type ProjectDataSourceKind,
  FeishuProjectJoinService,
  ProjectJoinDeniedError,
  ProjectJoinUnavailableError,
} from "../project-context/index.js";
import {
  ProjectIntelligenceAccessDeniedError,
  ProjectIntelligenceQueryService,
  ProjectIntelligenceUnavailableError,
} from "../intelligence/index.js";
import {
  InvalidProjectNameError,
  normalizeProjectName,
  type Project,
  type ProjectService,
  type UserProjectMembership,
} from "../project-service/index.js";

export interface ProjectResponseDto {
  id: string;
  name: string;
  currentUserRole: "owner" | "member";
  createdAt: string;
  updatedAt: string;
  healthScore?: number;
  healthStatus?: "healthy" | "needs-attention" | "at-risk";
  riskCount?: number;
  summaryState?: "available" | "unconfigured" | "unavailable";
}

type ProjectSummaryResolution =
  | {
      summaryState: "available";
      healthScore: number;
      healthStatus: "healthy" | "needs-attention" | "at-risk";
      riskCount: number;
    }
  | { summaryState: "unconfigured" | "unavailable" };

export interface ProjectsRouteDependencies {
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getProjectService: () => ProjectService | undefined;
  getProjectContextReportService: () => ProjectContextReportService | undefined;
  getProjectContextSummaryService?: () => ProjectContextSummaryService | undefined;
  getProjectDataSourceConfigurationService?: () => ProjectDataSourceConfigurationService | undefined;
  getProjectSourceConfigurationService?: () => ProjectSourceConfigurationService | undefined;
  getProjectSourceBindingService?: () => ProjectSourceBindingService | undefined;
  getProjectIntelligenceQueryService?: () => ProjectIntelligenceQueryService | undefined;
  getProjectJoinService?: () => FeishuProjectJoinService | undefined;
  ensureProjectRuntimeReady?: () => Promise<void>;
  secureCookies?: boolean;
}

export function isProjectsApiPath(pathname: string): boolean {
  return pathname === "/api/projects"
    || pathname === "/api/projects/join"
    || /^\/api\/projects\/[^/]+(?:\/(?:report|data-source|sources|intelligence)(?:\/[^/]+(?:\/events)?)?)?$/u.test(pathname)
    || /^\/api\/projects\/[^/]+\/sources\/options\/(?:chat|calendar)(?:\/[^/]+\/events)?$/u.test(pathname);
}

export function createProjectsRoute(dependencies: ProjectsRouteDependencies) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> => {
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." },
      });
      return;
    }

    try {
      const currentUser = await getCurrentUser(dependencies, request);
      await dependencies.ensureProjectRuntimeReady?.();
      const route = parseProjectRoute(requestUrl.pathname);

      if (request.method === "POST") {
        if (route.kind === "report") {
          await sendProjectReport(response, dependencies, route.projectId, currentUser);
          return;
        }
        if (route.kind === "sources") {
          try {
            const input = await readProjectSourceInput(request, route.projectId, currentUser, getProjectSourceBindingService(dependencies));
            const source = await getProjectSourceConfigurationService(dependencies)
              .add(route.projectId, currentUser.userId, input);
            sendJson(response, 201, source);
          } catch (error) {
            sendDataSourceError(response, error);
          }
          return;
        }
        if (route.kind === "join") {
          const input = await readJoinProjectInput(request);
          const sessionId = readCookie(request, FEISHU_SESSION_COOKIE);
          if (!sessionId) throw new CurrentUserContextUnavailableError();
          const authorization = await getProjectJoinService(dependencies).beginJoin({
            sessionId,
            userId: currentUser.userId,
            baseUrl: input.url,
          });
          response.setHeader(
            "set-cookie",
            createJoinOAuthStateCookie(authorization.state, Boolean(dependencies.secureCookies)),
          );
          sendJson(response, 200, { authorizationUrl: authorization.authorizationUrl });
          return;
        }
        if (route.kind !== "list") return sendMethodNotAllowed(response);
        const input = await readCreateProjectInput(request);
        const projectService = getProjectService(dependencies);
        const project = await projectService.createProject({
          name: input.name,
          creatorId: currentUser.userId,
          ownerId: currentUser.userId,
        });
        const membership = await projectService.getMembership(project.id, currentUser.userId);
        if (!membership) throw new Error("Created project membership is missing.");
        sendJson(response, 201, toProjectResponseDto(project, membership));
        return;
      }

      if (route.kind === "join") return sendMethodNotAllowed(response);

      if (request.method === "PATCH") {
        if (route.kind !== "source") return sendMethodNotAllowed(response);
        try {
          const enabled = await readSourceEnabledInput(request);
          const source = await getProjectSourceConfigurationService(dependencies)
            .setEnabled(route.projectId, currentUser.userId, route.sourceId, enabled);
          sendJson(response, 200, source);
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (request.method === "DELETE") {
        if (route.kind !== "source") return sendMethodNotAllowed(response);
        try {
          await getProjectSourceConfigurationService(dependencies)
            .remove(route.projectId, currentUser.userId, route.sourceId);
          response.writeHead(204);
          response.end();
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (request.method === "PUT") {
        if (route.kind !== "data-source") return sendMethodNotAllowed(response);
        try {
          const input = await readDataSourceInput(request);
          const status = await getProjectDataSourceConfigurationService(dependencies)
            .configureFeishuBase(route.projectId, currentUser.userId, input.url);
          sendJson(response, 200, status);
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (route.kind === "data-source") {
        try {
          const status = await getProjectDataSourceConfigurationService(dependencies)
            .getStatus(route.projectId, currentUser.userId);
          sendJson(response, 200, status);
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (route.kind === "source-options") {
        try {
          const binding = getProjectSourceBindingService(dependencies);
          if (route.sourceType === "feishu-calendar") {
            sendJson(response, 200, await binding.listCalendars(route.projectId, currentUser));
          } else {
            sendJson(response, 200, await binding.listChats(route.projectId, currentUser));
          }
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (route.kind === "calendar-events") {
        try {
          const binding = getProjectSourceBindingService(dependencies);
          sendJson(response, 200, await binding.listCalendarEvents(
            route.projectId,
            currentUser,
            route.calendarSelectionId,
            requestUrl.searchParams.get("start") ?? undefined,
            requestUrl.searchParams.get("end") ?? undefined,
          ));
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (route.kind === "sources") {
        try {
          const sources = await getProjectSourceConfigurationService(dependencies)
            .list(route.projectId, currentUser);
          sendJson(response, 200, sources);
        } catch (error) {
          sendDataSourceError(response, error);
        }
        return;
      }

      if (route.kind === "source") return sendMethodNotAllowed(response);

      if (route.kind === "intelligence") {
        try {
          const intelligence = await getProjectIntelligenceQueryService(dependencies)
            .get(route.projectId, currentUser);
          sendJson(response, 200, intelligence);
        } catch (error) {
          if (error instanceof ProjectIntelligenceAccessDeniedError) return sendProjectNotFound(response);
          if (error instanceof ProjectIntelligenceUnavailableError) {
            sendJson(response, 503, { error: { code: "PROJECT_INTELLIGENCE_UNAVAILABLE", message: "Project intelligence is unavailable." } });
            return;
          }
          throw error;
        }
        return;
      }

      if (route.kind === "list") {
        const projectService = getProjectService(dependencies);
        const projects = await projectService.listProjects(currentUser.userId);
        const summaries = await mapWithConcurrency(projects, 3, async (project) => {
          const membership = await projectService.getMembership(project.id, currentUser.userId);
          if (!membership) throw new Error("Project membership is missing.");
          const summary = await tryCreateProjectSummary(
            dependencies,
            project.id,
            currentUser,
          );
          return toProjectResponseDto(project, membership, summary ?? undefined);
        });
        sendJson(response, 200, { projects: summaries });
        return;
      }

      const projectService = getProjectService(dependencies);
      if (route.kind === "detail") {
        const project = await projectService.getProject(route.projectId, currentUser.userId);
        const membership = await projectService.getMembership(route.projectId, currentUser.userId);
        if (!project || !membership) {
          sendProjectNotFound(response);
          return;
        }
        sendJson(response, 200, toProjectResponseDto(project, membership));
        return;
      }

      sendMethodNotAllowed(response);
    } catch (error) {
      if (error instanceof ProjectJoinDeniedError) {
        sendJson(response, 400, {
          error: { code: "PROJECT_JOIN_UNAVAILABLE", message: "Unable to start project join." },
        });
        return;
      }
      if (error instanceof ProjectJoinUnavailableError) {
        sendJson(response, 503, {
          error: { code: "PROJECT_JOIN_UNAVAILABLE", message: "Project join is unavailable." },
        });
        return;
      }
      if (error instanceof ProjectRequestInputError) {
        sendJson(response, 400, {
          error: { code: error.code, message: "Project request input is invalid." },
        });
        return;
      }
      if (error instanceof InvalidProjectNameError) {
        sendJson(response, 400, {
          error: { code: "INVALID_PROJECT_NAME", message: "Project name is invalid." },
        });
        return;
      }
      if (error instanceof CurrentUserContextUnavailableError) {
        sendJson(response, 503, {
          error: { code: "CURRENT_USER_CONTEXT_UNAVAILABLE", message: "Project API is unavailable." },
        });
        return;
      }
      // Production diagnostics intentionally retain only the error class, never request data or credentials.
      console.error("Echo Insight project API unavailable", error instanceof Error ? error.name : "unknown");
      sendJson(response, 503, {
        error: { code: "PROJECT_API_UNAVAILABLE", message: "Project API is unavailable." },
      });
    }
  };
}

async function sendProjectReport(
  response: ServerResponse,
  dependencies: ProjectsRouteDependencies,
  projectId: string,
  currentUser: Awaited<ReturnType<CurrentUserContextProvider["getCurrentUser"]>>,
): Promise<void> {
  try {
    const report = await getProjectContextReportService(dependencies)
      .createProjectReport(projectId, currentUser);
    sendJson(response, 200, report);
  } catch (error) {
    if (error instanceof ProjectContextAccessDeniedError) {
      sendProjectNotFound(response);
      return;
    }
    if (error instanceof ProjectDataSourceResolutionError) {
      sendJson(response, 500, {
        error: { code: "PROJECT_REPORT_UNAVAILABLE", message: "Project report is unavailable." },
      });
      return;
    }
    sendJson(response, 500, {
      error: { code: "PROJECT_REPORT_FAILED", message: "Unable to generate the project report." },
    });
  }
}

export function toProjectResponseDto(
  project: Project,
  membership: UserProjectMembership,
  summary?: ProjectSummaryResolution,
): ProjectResponseDto {
  return {
    id: project.id,
    name: project.name,
    currentUserRole: membership.role,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(summary ?? {}),
  };
}

async function tryCreateProjectSummary(
  dependencies: ProjectsRouteDependencies,
  projectId: string,
  subject: { userId: string; identity?: import("../current-user/index.js").FeishuIdentityRef },
) {
  const summaryService = dependencies.getProjectContextSummaryService?.();
  if (!summaryService) return null;

  try {
    const summary = await summaryService.createProjectSummary(projectId, subject);
    return { summaryState: "available" as const, ...summary };
  } catch (error) {
    return {
      summaryState: error instanceof ProjectDataSourceResolutionError
        ? "unconfigured" as const
        : "unavailable" as const,
    };
  }
}

function getCurrentUser(
  dependencies: ProjectsRouteDependencies,
  request: IncomingMessage,
) {
  const provider = dependencies.getCurrentUserContextProvider();
  if (!provider) throw new CurrentUserContextUnavailableError();
  return provider.getCurrentUser(request);
}

function getProjectService(dependencies: ProjectsRouteDependencies): ProjectService {
  const projectService = dependencies.getProjectService();
  if (!projectService) throw new CurrentUserContextUnavailableError();
  return projectService;
}

function getProjectContextReportService(
  dependencies: ProjectsRouteDependencies,
): ProjectContextReportService {
  const reportService = dependencies.getProjectContextReportService();
  if (!reportService) throw new CurrentUserContextUnavailableError();
  return reportService;
}

function getProjectDataSourceConfigurationService(
  dependencies: ProjectsRouteDependencies,
): ProjectDataSourceConfigurationService {
  const service = dependencies.getProjectDataSourceConfigurationService?.();
  if (!service) throw new CurrentUserContextUnavailableError();
  return service;
}

function getProjectSourceConfigurationService(
  dependencies: ProjectsRouteDependencies,
): ProjectSourceConfigurationService {
  const service = dependencies.getProjectSourceConfigurationService?.();
  if (!service) throw new CurrentUserContextUnavailableError();
  return service;
}

function getProjectSourceBindingService(
  dependencies: ProjectsRouteDependencies,
): ProjectSourceBindingService {
  const service = dependencies.getProjectSourceBindingService?.();
  if (!service) throw new ProjectSourceBindingUnavailableError();
  return service;
}

function getProjectIntelligenceQueryService(
  dependencies: ProjectsRouteDependencies,
): ProjectIntelligenceQueryService {
  const service = dependencies.getProjectIntelligenceQueryService?.();
  if (!service) throw new ProjectIntelligenceUnavailableError();
  return service;
}

function getProjectJoinService(dependencies: ProjectsRouteDependencies): FeishuProjectJoinService {
  const service = dependencies.getProjectJoinService?.();
  if (!service) throw new ProjectJoinUnavailableError();
  return service;
}

function parseProjectRoute(pathname: string):
  | { kind: "list" }
  | { kind: "join" }
  | { kind: "detail"; projectId: string }
  | { kind: "report"; projectId: string }
  | { kind: "data-source"; projectId: string }
  | { kind: "sources"; projectId: string }
  | { kind: "source"; projectId: string; sourceId: string }
  | { kind: "source-options"; projectId: string; sourceType: "feishu-chat" | "feishu-calendar" }
  | { kind: "calendar-events"; projectId: string; calendarSelectionId: string }
  | { kind: "intelligence"; projectId: string } {
  if (pathname === "/api/projects") return { kind: "list" };
  if (pathname === "/api/projects/join") return { kind: "join" };

  const reportMatch = /^\/api\/projects\/([^/]+)\/report$/u.exec(pathname);
  if (reportMatch?.[1]) return { kind: "report", projectId: decodeSegment(reportMatch[1]) };

  const dataSourceMatch = /^\/api\/projects\/([^/]+)\/data-source$/u.exec(pathname);
  if (dataSourceMatch?.[1]) return { kind: "data-source", projectId: decodeSegment(dataSourceMatch[1]) };

  const calendarEventsMatch = /^\/api\/projects\/([^/]+)\/sources\/options\/calendar\/([^/]+)\/events$/u.exec(pathname);
  if (calendarEventsMatch?.[1] && calendarEventsMatch[2]) return { kind: "calendar-events", projectId: decodeSegment(calendarEventsMatch[1]), calendarSelectionId: decodeSegment(calendarEventsMatch[2]) };
  const sourceOptionsMatch = /^\/api\/projects\/([^/]+)\/sources\/options\/(chat|calendar)$/u.exec(pathname);
  if (sourceOptionsMatch?.[1] && sourceOptionsMatch[2]) return { kind: "source-options", projectId: decodeSegment(sourceOptionsMatch[1]), sourceType: sourceOptionsMatch[2] === "calendar" ? "feishu-calendar" : "feishu-chat" };

  const sourceMatch = /^\/api\/projects\/([^/]+)\/sources\/([^/]+)$/u.exec(pathname);
  if (sourceMatch?.[1] && sourceMatch[2]) return { kind: "source", projectId: decodeSegment(sourceMatch[1]), sourceId: decodeSegment(sourceMatch[2]) };

  const sourcesMatch = /^\/api\/projects\/([^/]+)\/sources$/u.exec(pathname);
  if (sourcesMatch?.[1]) return { kind: "sources", projectId: decodeSegment(sourcesMatch[1]) };

  const intelligenceMatch = /^\/api\/projects\/([^/]+)\/intelligence$/u.exec(pathname);
  if (intelligenceMatch?.[1]) return { kind: "intelligence", projectId: decodeSegment(intelligenceMatch[1]) };

  const detailMatch = /^\/api\/projects\/([^/]+)$/u.exec(pathname);
  if (detailMatch?.[1]) return { kind: "detail", projectId: decodeSegment(detailMatch[1]) };

  throw new CurrentUserContextUnavailableError();
}

async function readCreateProjectInput(request: IncomingMessage): Promise<{ name: string }> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.name !== "string") {
    throw new ProjectRequestInputError("INVALID_PROJECT_INPUT");
  }
  return { name: normalizeProjectName(body.name) };
}

async function readDataSourceInput(request: IncomingMessage): Promise<{ url: string }> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.url !== "string") {
    throw new ProjectRequestInputError("INVALID_DATA_SOURCE_INPUT");
  }
  const url = body.url.trim();
  if (!url || url.length > 2_000) throw new ProjectRequestInputError("INVALID_DATA_SOURCE_INPUT");
  return { url };
}

async function readProjectSourceInput(
  request: IncomingMessage,
  projectId: string,
  subject: Awaited<ReturnType<CurrentUserContextProvider["getCurrentUser"]>>,
  binding: ProjectSourceBindingService,
): Promise<ConfigureProjectSourceInput> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || (body.displayName !== undefined && typeof body.displayName !== "string")) {
    throw new ProjectRequestInputError("INVALID_PROJECT_SOURCE_INPUT");
  }
  const displayName = typeof body.displayName === "string" ? { displayName: body.displayName } : {};
  if (typeof body.selectionId === "string" && Object.keys(body).every((key) => ["displayName", "selectionId"].includes(key))) {
    return { locator: await binding.resolveSelection(projectId, subject, body.selectionId), ...displayName };
  }
  if (typeof body.sourceUrl === "string" && typeof body.sourceType === "string" && Object.keys(body).every((key) => ["displayName", "sourceUrl", "sourceType"].includes(key))) {
    const sourceType = parseUrlSourceType(body.sourceType);
    return { locator: await binding.resolveUrl(projectId, subject, sourceType, body.sourceUrl), ...displayName };
  }
  // Direct locators remain an internal service capability, but are never a public product API input.
  if ("locator" in body) throw new ProjectSourceBindingInputError();
  throw new ProjectRequestInputError("INVALID_PROJECT_SOURCE_INPUT");
}

function parseUrlSourceType(value: string): Exclude<ProjectDataSourceKind, "feishu-base" | "feishu-chat" | "feishu-calendar"> {
  if (value === "feishu-minutes" || value === "feishu-docs" || value === "feishu-wiki-drive" || value === "feishu-task") return value;
  throw new ProjectSourceBindingInputError();
}

async function readSourceEnabledInput(request: IncomingMessage): Promise<boolean> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
    throw new ProjectRequestInputError("INVALID_PROJECT_SOURCE_INPUT");
  }
  return body.enabled;
}

async function readJoinProjectInput(request: IncomingMessage): Promise<{ url: string }> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.url !== "string") {
    throw new ProjectRequestInputError("INVALID_PROJECT_JOIN_INPUT");
  }
  const url = body.url.trim();
  if (!url || url.length > 2_000) throw new ProjectRequestInputError("INVALID_PROJECT_JOIN_INPUT");
  return { url };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 8_192) throw new ProjectRequestInputError("REQUEST_BODY_TOO_LARGE");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProjectRequestInputError("INVALID_REQUEST_JSON");
  }
}

class ProjectRequestInputError extends Error {
  constructor(readonly code: string) {
    super("Project request input is invalid.");
  }
}

function sendDataSourceError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProjectDataSourceAccessDeniedError) return sendProjectNotFound(response);
  if (error instanceof ProjectDataSourceForbiddenError) {
    sendJson(response, 403, { error: { code: "PROJECT_DATA_SOURCE_FORBIDDEN", message: "Only the project owner can update this data source." } });
    return;
  }
  if (error instanceof ProjectDataSourceUrlError) {
    sendJson(response, 400, { error: { code: error.code, message: "Please paste a supported standalone Feishu Base link." } });
    return;
  }
  if (error instanceof ProjectDataSourceValidationError) {
    sendJson(response, 422, { error: { code: "DATA_SOURCE_VALIDATION_FAILED", message: "Unable to access this Feishu Base. Confirm the link and app access, then try again." } });
    return;
  }
  if (error instanceof ProjectSourceConfigurationInputError) {
    sendJson(response, 400, { error: { code: error.code, message: "Project Source configuration is invalid." } });
    return;
  }
  if (error instanceof ProjectSourceBindingInputError) {
    sendJson(response, 400, { error: { code: error.code, message: "Project source binding is invalid." } });
    return;
  }
  if (error instanceof ProjectSourceBindingUnavailableError) {
    sendJson(response, 503, { error: { code: error.code, message: "Project source binding is unavailable." } });
    return;
  }
  if (error instanceof ProjectRequestInputError) {
    sendJson(response, 400, { error: { code: error.code, message: "Project request input is invalid." } });
    return;
  }
  sendJson(response, 503, { error: { code: "PROJECT_DATA_SOURCE_UNAVAILABLE", message: "Project data source is unavailable." } });
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function sendProjectNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    error: { code: "PROJECT_NOT_FOUND", message: "Project not found." },
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method is not supported for this route." } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value);
    }
  }));
  return results;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createInsightsRoute, createInsightsSynthesisRoute } from "../routes/insights.js";
import { createProjectsRoute } from "../routes/projects.js";
import { createDemoEnvironment } from "./demo-environment.js";

const PUBLIC_DEMO_PREFIX = "/api/demo";

export type PublicDemoApi = (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
) => Promise<void>;

export interface PublicDemoApiOptions {
  runtimeDirectory?: string;
}

export function isPublicDemoApiPath(pathname: string): boolean {
  return pathname === PUBLIC_DEMO_PREFIX
    || pathname.startsWith(`${PUBLIC_DEMO_PREFIX}/`);
}

/**
 * Builds a dependency graph that contains only synthetic project data and local
 * deterministic/pre-generated explanation providers. It never inherits the
 * authenticated runtime's Feishu reader, project store, or AI provider.
 */
export async function createPublicDemoApi(
  options: PublicDemoApiOptions = {},
): Promise<PublicDemoApi> {
  const runtimeDirectory = options.runtimeDirectory
    ?? resolve(
      tmpdir(),
      `echo-insight-public-demo-${String(process.pid)}`,
      "backend",
      ".runtime",
      "demo-v3",
    );
  const demo = await createDemoEnvironment(runtimeDirectory, true);

  const projectsRoute = createProjectsRoute({
    getCurrentUserContextProvider: () => demo.currentUserContextProvider,
    getProjectService: () => demo.projectService,
    getProjectContextReportService: () => demo.projectContextReportService,
    getProjectContextSummaryService: () => demo.projectContextSummaryService,
    getProjectDataSourceConfigurationService: () => demo.projectDataSourceConfigurationService,
    getProjectSourceConfigurationService: () => demo.projectSourceConfigurationService,
    getProjectIntelligenceQueryService: () => demo.projectIntelligenceQueryService,
    ensureProjectRuntimeReady: async () => undefined,
  });
  const insightsRoute = createInsightsRoute({
    getCurrentUserContextProvider: () => demo.currentUserContextProvider,
    getGlobalInsightService: () => demo.globalInsightService,
    getGlobalInsightSynthesisService: () => demo.globalInsightSynthesisService,
    ensureProjectRuntimeReady: async () => undefined,
  });
  const synthesisRoute = createInsightsSynthesisRoute({
    getCurrentUserContextProvider: () => demo.currentUserContextProvider,
    getGlobalInsightService: () => demo.globalInsightService,
    getGlobalInsightSynthesisService: () => demo.globalInsightSynthesisService,
    ensureProjectRuntimeReady: async () => undefined,
  });

  return async (request, response, requestUrl) => {
    const translatedUrl = translateDemoUrl(requestUrl);
    if (!isAllowedPublicDemoRequest(request.method, translatedUrl.pathname)) {
      sendDemoReadOnly(response);
      return;
    }

    if (translatedUrl.pathname === "/api/insights") {
      await insightsRoute(request, response);
      return;
    }
    if (translatedUrl.pathname === "/api/insights/synthesis") {
      await synthesisRoute(request, response, translatedUrl);
      return;
    }
    await projectsRoute(request, response, translatedUrl);
  };
}

function translateDemoUrl(requestUrl: URL): URL {
  const translatedUrl = new URL(requestUrl.toString());
  translatedUrl.pathname = `/api${requestUrl.pathname.slice(PUBLIC_DEMO_PREFIX.length)}`;
  return translatedUrl;
}

function isAllowedPublicDemoRequest(
  method: string | undefined,
  pathname: string,
): boolean {
  if (method === "GET") {
    return pathname === "/api/projects"
      || /^\/api\/projects\/[^/]+$/u.test(pathname)
      || /^\/api\/projects\/[^/]+\/(?:data-source|sources|intelligence)$/u.test(pathname)
      || pathname === "/api/insights";
  }
  if (method === "POST") {
    return /^\/api\/projects\/[^/]+\/report$/u.test(pathname)
      || pathname === "/api/insights/synthesis";
  }
  return false;
}

function sendDemoReadOnly(response: ServerResponse): void {
  response.setHeader("Allow", "GET, POST");
  response.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    error: {
      code: "DEMO_READ_ONLY",
      message: "The public demo is read-only.",
    },
  }));
}

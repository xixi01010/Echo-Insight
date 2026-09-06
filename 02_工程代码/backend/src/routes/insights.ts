import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CurrentUserContextUnavailableError,
  type CurrentUserContext,
  type CurrentUserContextProvider,
} from "../current-user/index.js";
import type {
  GlobalInsightService,
  GlobalInsightSynthesisService,
} from "../global-insight/index.js";

export interface InsightsRouteDependencies {
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getGlobalInsightService: () => GlobalInsightService | undefined;
  getGlobalInsightSynthesisService: (
    currentUser: CurrentUserContext,
  ) => GlobalInsightSynthesisService | undefined;
  ensureProjectRuntimeReady?: () => Promise<void>;
}

export function isInsightsApiPath(pathname: string): boolean {
  return pathname === "/api/insights";
}

export function isInsightsSynthesisApiPath(pathname: string): boolean {
  return pathname === "/api/insights/synthesis";
}

export function createInsightsRoute(dependencies: InsightsRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." },
      });
      return;
    }

    try {
      const currentUserProvider = dependencies.getCurrentUserContextProvider();
      const globalInsightService = dependencies.getGlobalInsightService();
      if (!currentUserProvider || !globalInsightService) {
        throw new CurrentUserContextUnavailableError();
      }
      const currentUser = await currentUserProvider.getCurrentUser(request);
      await dependencies.ensureProjectRuntimeReady?.();
      sendJson(response, 200, await globalInsightService.getInsights(currentUser));
    } catch {
      sendJson(response, 503, {
        error: { code: "INSIGHTS_UNAVAILABLE", message: "Insights are unavailable." },
      });
    }
  };
}

export function createInsightsSynthesisRoute(dependencies: InsightsRouteDependencies) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl = new URL(request.url ?? "/", "http://localhost"),
  ): Promise<void> => {
    const forceRefresh = requestUrl.searchParams.get("forceRefresh") === "true";
    if (request.method !== "POST") {
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." },
      });
      return;
    }

    try {
      const currentUserProvider = dependencies.getCurrentUserContextProvider();
      if (!currentUserProvider) {
        throw new CurrentUserContextUnavailableError();
      }
      const currentUser = await currentUserProvider.getCurrentUser(request);
      const synthesisService = dependencies.getGlobalInsightSynthesisService(currentUser);
      if (!synthesisService) throw new CurrentUserContextUnavailableError();
      await dependencies.ensureProjectRuntimeReady?.();
      sendJson(response, 200, await synthesisService.getSynthesis(currentUser.userId, {
        forceRefresh,
      }));
    } catch {
      sendJson(response, 503, {
        error: { code: "INSIGHT_SYNTHESIS_UNAVAILABLE", message: "Insight synthesis is unavailable." },
      });
    }
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ProjectAnalysisService } from "../analysis-service/index.js";

interface ProjectAnalysisRouteDependencies {
  getAnalysisService: () => Pick<ProjectAnalysisService, "analyzeProject">;
  getBaseToken: () => string;
}

export function createProjectAnalysisRoute(
  dependencies: ProjectAnalysisRouteDependencies,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." },
      });
      return;
    }

    try {
      const result = await dependencies
        .getAnalysisService()
        .analyzeProject(dependencies.getBaseToken());
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: "PROJECT_ANALYSIS_FAILED",
          message: error instanceof Error ? error.message : "Unknown analysis error.",
        },
      });
    }
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}


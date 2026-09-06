import type { IncomingMessage, ServerResponse } from "node:http";
import { AiProviderTimeoutError } from "../../../ai-service/src/deepseek-risk-analyzer.js";
import type { ProjectReportService } from "../ai-analysis-service/index.js";

export interface ProjectReportRouteDependencies {
  getBaseToken: () => string;
  getReportService: () => ProjectReportService;
}

export function createProjectReportRoute(dependencies: ProjectReportRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }

    try {
      const report = await dependencies.getReportService().createProjectReport(dependencies.getBaseToken());
      sendJson(response, 200, report);
    } catch (error) {
      if (error instanceof AiProviderTimeoutError) {
        sendJson(response, 504, {
          error: {
            code: "AI_PROVIDER_TIMEOUT",
            message: "AI risk explanation service timed out. Please try again.",
          },
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unable to generate the project report.";
      sendJson(response, 500, { error: { code: "PROJECT_REPORT_FAILED", message } });
    }
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

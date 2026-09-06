import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ProjectDataReader,
  StandardProjectData,
} from "../../../feishu-connector/src/index.js";

interface ProjectDataRouteDependencies {
  getReader: () => ProjectDataReader;
  getBaseToken: () => string;
}

export function createProjectDataRoute(
  dependencies: ProjectDataRouteDependencies,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." },
      });
      return;
    }

    try {
      const data = await dependencies
        .getReader()
        .readProjectData(dependencies.getBaseToken());
      sendJson(response, 200, data);
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: "PROJECT_DATA_READ_FAILED",
          message: error instanceof Error ? error.message : "Unknown read error.",
        },
      });
    }
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: StandardProjectData | Record<string, unknown>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

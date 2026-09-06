import { resolve } from "node:path";

if (process.env.NODE_ENV === "production") {
  throw new Error("The V3 Review environment cannot run in production.");
}

const { createEchoInsightServer } = await import("../backend/src/index.js");
const { createReviewEnvironment } = await import("../backend/src/review/review-environment.js");
const runtimeDirectory = resolve("backend", ".runtime", "review-v3");
const environment = await createReviewEnvironment(runtimeDirectory, true);
const port = Number(process.env.PORT ?? "3000");
const server = createEchoInsightServer({
  ...environment,
  environment: {
    NODE_ENV: "development",
    ECHO_INSIGHT_AI_ACCESS_MODE: "server",
    ECHO_INSIGHT_DEV_USER_ID: "echo-review-user",
  },
  allowedFrontendOrigin: "http://localhost:5173",
});

server.listen(port, "127.0.0.1", () => {
  console.log(`V3 Review backend: http://127.0.0.1:${port}`);
  console.log("Start the existing frontend with: npm run dev:frontend");
  console.log("Open: http://localhost:5173");
});

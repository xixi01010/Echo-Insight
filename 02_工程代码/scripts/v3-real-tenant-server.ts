import { resolve } from "node:path";

if (process.env.NODE_ENV === "production" || process.env.ECHO_INSIGHT_REAL_TENANT_DEV !== "1") {
  throw new Error("Set ECHO_INSIGHT_REAL_TENANT_DEV=1 to start the local real-tenant validation server.");
}

const port = Number(process.env.PORT ?? "3000");
const expectedRedirectUri = `http://localhost:${port}/api/auth/feishu/callback`;
if (process.env.ECHO_INSIGHT_REAL_TENANT_REDIRECT_URI?.trim() !== expectedRedirectUri) {
  throw new Error(`ECHO_INSIGHT_REAL_TENANT_REDIRECT_URI must be ${expectedRedirectUri}.`);
}

const { createEchoInsightServer } = await import("../backend/src/index.js");
const server = createEchoInsightServer({
  environment: {
    ...process.env,
    NODE_ENV: "development",
    ECHO_INSIGHT_REAL_TENANT_DEV: "1",
    ECHO_INSIGHT_RUNTIME_DIR: resolve("backend", ".runtime", "real-tenant-v3"),
    FRONTEND_ORIGIN: "http://localhost:5173",
  },
  allowedFrontendOrigin: "http://localhost:5173",
});

server.listen(port, "127.0.0.1", () => {
  console.log(`V3 real-tenant backend: http://localhost:${port}`);
  console.log("Use the existing frontend at http://localhost:5173 and complete /api/auth/feishu/start in this same process.");
});

function stop(): void {
  server.close(() => process.exit(0));
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

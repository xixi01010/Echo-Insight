import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createAiProviderBundle,
  readAiProviderId,
  type AiProviderBundle,
  type AiProviderId,
  type GlobalInsightSynthesizer,
  type RiskExplanationAnalyzer,
} from "../../../ai-service/src/index.js";
import {
  CurrentUserContextUnavailableError,
  type CurrentUserContext,
  type CurrentUserContextProvider,
  type FeishuSession,
  type FeishuSessionStore,
  type VisitorAiAccountStore,
  visitorAiAccountIdentityKey,
} from "../current-user/index.js";

export type AiAccessMode = "server" | "visitor";

export interface AiSettingsRouteDependencies {
  mode: AiAccessMode;
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getSessionStore: () => FeishuSessionStore | undefined;
  getVisitorAccountStore: () => VisitorAiAccountStore | undefined;
  getServerBundle: () => AiProviderBundle;
  isServerConfigured: () => boolean;
  createVisitorBundle?: (environment: NodeJS.ProcessEnv) => AiProviderBundle;
  verifyBundle?: (bundle: AiProviderBundle) => Promise<void>;
}

interface VisitorProviderInput {
  providerId: "deepseek" | "qwen";
  apiKey: string;
}

const CONNECTION_ATTEMPT_LIMIT = 3;
const AI_REQUEST_LIMIT = 12;
const AI_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const AI_CONCURRENT_REQUEST_LIMIT = 2;

export function isAiSettingsApiPath(pathname: string): boolean {
  return pathname === "/api/settings/ai" || pathname === "/api/settings/ai/skip";
}

export function readAiAccessMode(
  environment: NodeJS.ProcessEnv = process.env,
): AiAccessMode {
  const configured = environment.ECHO_INSIGHT_AI_ACCESS_MODE?.trim().toLowerCase();
  if (configured === "server" || configured === "visitor") return configured;
  if (configured) {
    throw new Error("ECHO_INSIGHT_AI_ACCESS_MODE must be server or visitor.");
  }
  // Fail closed everywhere. Self-hosted deployments opt into server-managed
  // credentials explicitly through the guided setup environment.
  return "visitor";
}

export function isServerAiProviderConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  let providerId: AiProviderId;
  try {
    providerId = readAiProviderId(environment);
  } catch {
    return false;
  }
  if (providerId === "deepseek") return Boolean(environment.DEEPSEEK_API_KEY?.trim());
  if (providerId === "qwen") return Boolean(environment.DASHSCOPE_API_KEY?.trim());
  return Boolean(
    environment.OPENAI_COMPATIBLE_API_KEY?.trim()
    && environment.OPENAI_COMPATIBLE_MODEL?.trim()
    && environment.OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL?.trim(),
  );
}

export function createAiSettingsRoute(dependencies: AiSettingsRouteDependencies) {
  const createVisitorBundle = dependencies.createVisitorBundle ?? createAiProviderBundle;
  const verifyBundle = dependencies.verifyBundle ?? verifyAiProviderBundle;
  const connectionLimiters = new Map<string, OperationLimiter>();
  const requestLimiters = new Map<string, OperationLimiter>();
  const accountOperations = new AccountOperationQueue();

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl = new URL(request.url ?? "/", "http://localhost"),
  ): Promise<void> => {
    try {
      const currentUser = await requireCurrentUser(request, dependencies);

      if (requestUrl.pathname === "/api/settings/ai" && request.method === "GET") {
        if (dependencies.mode === "visitor") {
          const session = requireSession(currentUser, dependencies.getSessionStore());
          await restoreVisitorProvider(
            session,
            dependencies,
            createVisitorBundle,
            requestLimiters,
            accountOperations,
          );
        }
        sendJson(response, 200, createStatus(currentUser, dependencies, requestUrl));
        return;
      }

      if (dependencies.mode !== "visitor") {
        sendJson(response, 403, {
          error: {
            code: "AI_SETTINGS_MANAGED_BY_SERVER",
            message: "AI settings are managed by this deployment.",
          },
        });
        return;
      }

      const session = requireSession(currentUser, dependencies.getSessionStore());
      const accountKey = visitorAiAccountIdentityKey(session.identity);
      if (requestUrl.pathname === "/api/settings/ai/skip" && request.method === "POST") {
        await accountOperations.run(accountKey, async () => {
          dependencies.getSessionStore()!.skipAiSetup(session.id);
        });
        sendJson(response, 200, createStatus(currentUser, dependencies, requestUrl));
        return;
      }
      if (requestUrl.pathname === "/api/settings/ai" && request.method === "DELETE") {
        await accountOperations.run(accountKey, async () => {
          await requireVisitorAccountStore(dependencies).delete(session.identity);
          dependencies.getSessionStore()!.clearAiProviderForIdentity(session.identity);
        });
        sendJson(response, 200, createStatus(currentUser, dependencies, requestUrl));
        return;
      }
      if (requestUrl.pathname === "/api/settings/ai" && request.method === "PUT") {
        const input = await readVisitorProviderInput(request);
        const expectedRevision = session.aiConfigurationRevision ?? 0;
        let connectionLimiter = connectionLimiters.get(accountKey);
        if (!connectionLimiter) {
          connectionLimiter = new OperationLimiter(CONNECTION_ATTEMPT_LIMIT, AI_LIMIT_WINDOW_MS, 1);
          connectionLimiters.set(accountKey, connectionLimiter);
        }
        let bundle: AiProviderBundle;
        try {
          bundle = await connectionLimiter.run(async () => {
            const candidate = createVisitorBundle(createVisitorEnvironment(input));
            await verifyBundle(candidate);
            return candidate;
          });
        } catch (error) {
          if (error instanceof AiUsageLimitError) {
            sendJson(response, 429, {
              error: {
                code: "AI_CONNECTION_RATE_LIMITED",
                message: "Too many AI provider connection attempts.",
              },
            });
            return;
          }
          sendJson(response, 422, {
            error: {
              code: "AI_PROVIDER_CONNECTION_FAILED",
              message: "Unable to verify this AI provider connection.",
            },
          });
          return;
        }
        let requestLimiter = requestLimiters.get(accountKey);
        if (!requestLimiter) {
          requestLimiter = new OperationLimiter(
            AI_REQUEST_LIMIT,
            AI_LIMIT_WINDOW_MS,
            AI_CONCURRENT_REQUEST_LIMIT,
          );
          requestLimiters.set(accountKey, requestLimiter);
        }
        const rateLimitedBundle = createRateLimitedVisitorBundle(bundle, requestLimiter);
        const updatedSession = await accountOperations.run(accountKey, async () => {
          const currentSession = dependencies.getSessionStore()!.get(session.id);
          if (
            !currentSession
            || currentSession.userId !== currentUser.userId
            || (currentSession.aiConfigurationRevision ?? 0) !== expectedRevision
          ) return undefined;
          const saved = await requireVisitorAccountStore(dependencies).save(
            session.identity,
            input,
          );
          return dependencies.getSessionStore()!.setAiProviderForIdentityIfRevision(
            session.id,
            session.identity,
            rateLimitedBundle,
            saved.revision,
            expectedRevision,
          );
        });
        if (!updatedSession) {
          sendJson(response, 409, {
            error: {
              code: "AI_CONFIGURATION_CHANGED",
              message: "AI settings changed while the connection was being verified.",
            },
          });
          return;
        }
        sendJson(response, 200, createStatus(currentUser, dependencies, requestUrl));
        return;
      }

      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Method is not supported for this route." },
      });
    } catch (error) {
      if (error instanceof CurrentUserContextUnavailableError) {
        sendJson(response, 401, {
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." },
        });
        return;
      }
      if (error instanceof AiSettingsInputError) {
        sendJson(response, 400, {
          error: { code: error.code, message: "AI provider settings are invalid." },
        });
        return;
      }
      sendJson(response, 503, {
        error: { code: "AI_SETTINGS_UNAVAILABLE", message: "AI settings are unavailable." },
      });
    }
  };
}

async function requireCurrentUser(
  request: IncomingMessage,
  dependencies: AiSettingsRouteDependencies,
): Promise<CurrentUserContext> {
  const provider = dependencies.getCurrentUserContextProvider();
  if (!provider) throw new CurrentUserContextUnavailableError();
  return provider.getCurrentUser(request);
}

function requireSession(
  currentUser: CurrentUserContext,
  store: FeishuSessionStore | undefined,
): FeishuSession {
  if (!store || !currentUser.sessionId) throw new CurrentUserContextUnavailableError();
  const session = store.get(currentUser.sessionId);
  if (!session || session.userId !== currentUser.userId) {
    throw new CurrentUserContextUnavailableError();
  }
  return session;
}

function createStatus(
  currentUser: CurrentUserContext,
  dependencies: AiSettingsRouteDependencies,
  requestUrl: URL,
) {
  if (dependencies.mode === "server") {
    const bundle = dependencies.getServerBundle();
    return {
      mode: "server" as const,
      configured: dependencies.isServerConfigured(),
      setupRequired: false,
      storage: "deployment-environment" as const,
      providerId: bundle.providerId,
      providerName: bundle.displayName,
      model: bundle.model,
    };
  }

  const session = requireSession(currentUser, dependencies.getSessionStore());
  const bundle = session.aiProvider?.bundle;
  return {
    mode: "visitor" as const,
    configured: Boolean(bundle),
    setupRequired: !bundle && !session.aiSetupSkipped,
    storage: requestUrl.searchParams.get("storage-contract") === "account-v1"
      ? "server-account-encrypted" as const
      : "server-session-memory" as const,
    ...(bundle ? {
      providerId: bundle.providerId,
      providerName: bundle.displayName,
      model: bundle.model,
    } : {}),
  };
}

async function restoreVisitorProvider(
  session: FeishuSession,
  dependencies: AiSettingsRouteDependencies,
  createVisitorBundle: (environment: NodeJS.ProcessEnv) => AiProviderBundle,
  requestLimiters: Map<string, OperationLimiter>,
  accountOperations: AccountOperationQueue,
): Promise<void> {
  if (session.aiProvider) return;
  const accountKey = visitorAiAccountIdentityKey(session.identity);
  await accountOperations.run(accountKey, async () => {
    const currentSession = dependencies.getSessionStore()?.get(session.id);
    if (!currentSession || currentSession.aiProvider) return;
    const stored = await requireVisitorAccountStore(dependencies).find(session.identity);
    if (!stored) return;
    let requestLimiter = requestLimiters.get(accountKey);
    if (!requestLimiter) {
      requestLimiter = new OperationLimiter(
        AI_REQUEST_LIMIT,
        AI_LIMIT_WINDOW_MS,
        AI_CONCURRENT_REQUEST_LIMIT,
      );
      requestLimiters.set(accountKey, requestLimiter);
    }
    const bundle = createVisitorBundle(createVisitorEnvironment(stored));
    dependencies.getSessionStore()!.setAiProviderForIdentity(
      session.identity,
      createRateLimitedVisitorBundle(bundle, requestLimiter),
      stored.revision,
    );
  });
}

function requireVisitorAccountStore(
  dependencies: AiSettingsRouteDependencies,
): VisitorAiAccountStore {
  const store = dependencies.getVisitorAccountStore();
  if (!store) throw new Error("Visitor AI account storage is unavailable.");
  return store;
}

async function readVisitorProviderInput(
  request: IncomingMessage,
): Promise<VisitorProviderInput> {
  const body = await readJsonBody(request);
  if (!isRecord(body)) throw new AiSettingsInputError("INVALID_AI_SETTINGS");
  const keys = Object.keys(body);
  if (
    keys.length !== 2
    || !keys.every((key) => key === "providerId" || key === "apiKey")
    || (body.providerId !== "deepseek" && body.providerId !== "qwen")
    || typeof body.apiKey !== "string"
  ) {
    throw new AiSettingsInputError("INVALID_AI_SETTINGS");
  }
  const apiKey = body.apiKey.trim();
  if (!apiKey || apiKey.length > 2_048 || /[\r\n\0]/u.test(apiKey)) {
    throw new AiSettingsInputError("INVALID_AI_API_KEY");
  }
  return { providerId: body.providerId, apiKey };
}

function createVisitorEnvironment(input: VisitorProviderInput): NodeJS.ProcessEnv {
  return input.providerId === "deepseek"
    ? { AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: input.apiKey }
    : { AI_PROVIDER: "qwen", DASHSCOPE_API_KEY: input.apiKey };
}

async function verifyAiProviderBundle(bundle: AiProviderBundle): Promise<void> {
  await bundle.modelAdapter.invoke({
    model: bundle.model,
    systemPrompt: "You are checking an API connection. Return one small JSON object only.",
    prompt: "Return {\"connected\":true}.",
    testCase: {
      name: "visitor-ai-connection-test",
      filePath: "server-memory-only",
      input: { purpose: "connection-test" },
    },
  });
}

function createRateLimitedVisitorBundle(
  bundle: AiProviderBundle,
  limiter: OperationLimiter,
): AiProviderBundle {
  const riskAnalyzer: RiskExplanationAnalyzer = {
    analyze: (input) => limiter.run(() => bundle.riskAnalyzer.analyze(input)),
  };
  const globalSynthesizer: GlobalInsightSynthesizer = {
    synthesize: (input) => limiter.run(() => bundle.globalSynthesizer.synthesize(input)),
  };
  return { ...bundle, riskAnalyzer, globalSynthesizer };
}

class OperationLimiter {
  private readonly startedAt: number[] = [];
  private inFlight = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxConcurrent: number,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    while (this.startedAt[0] !== undefined && this.startedAt[0] <= now - this.windowMs) {
      this.startedAt.shift();
    }
    if (this.startedAt.length >= this.maxRequests || this.inFlight >= this.maxConcurrent) {
      throw new AiUsageLimitError();
    }
    this.startedAt.push(now);
    this.inFlight += 1;
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
    }
  }
}

class AiUsageLimitError extends Error {
  constructor() {
    super("AI usage is rate limited for this account.");
  }
}

class AccountOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountKey) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const tail = running.then(() => undefined, () => undefined);
    this.tails.set(accountKey, tail);
    try {
      return await running;
    } finally {
      if (this.tails.get(accountKey) === tail) this.tails.delete(accountKey);
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 4_096) throw new AiSettingsInputError("REQUEST_BODY_TOO_LARGE");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AiSettingsInputError("INVALID_REQUEST_JSON");
  }
}

class AiSettingsInputError extends Error {
  constructor(readonly code: string) {
    super("AI settings request is invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

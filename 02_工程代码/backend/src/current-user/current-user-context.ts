import type { IncomingMessage } from "node:http";

import type { FeishuIdentityRef } from "./feishu-identity-reference.js";

export interface CurrentUserContext {
  userId: string;
  source: "development-fixed" | "feishu";
  identity?: FeishuIdentityRef;
  /** Internal session reference. It must never be serialized into an API DTO. */
  sessionId?: string;
}

export interface CurrentUserContextProvider {
  getCurrentUser(request: IncomingMessage): Promise<CurrentUserContext>;
}

export class CurrentUserContextUnavailableError extends Error {
  readonly code = "CURRENT_USER_CONTEXT_UNAVAILABLE";

  constructor() {
    super("Current user context is unavailable.");
    this.name = "CurrentUserContextUnavailableError";
  }
}

/** Development-only provider. It intentionally ignores every request attribute. */
export class FixedCurrentUserContextProvider implements CurrentUserContextProvider {
  private readonly userId: string;

  constructor(userId: string) {
    this.userId = requireText(userId);
  }

  async getCurrentUser(_request: IncomingMessage): Promise<CurrentUserContext> {
    return { userId: this.userId, source: "development-fixed" };
  }
}

export function readDevelopmentCurrentUserContextProvider(
  environment: NodeJS.ProcessEnv = process.env,
): FixedCurrentUserContextProvider | undefined {
  if (environment.NODE_ENV === "production") return undefined;

  const userId = environment.ECHO_INSIGHT_DEV_USER_ID?.trim();
  return userId ? new FixedCurrentUserContextProvider(userId) : undefined;
}

function requireText(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CurrentUserContextUnavailableError();
  return normalized;
}

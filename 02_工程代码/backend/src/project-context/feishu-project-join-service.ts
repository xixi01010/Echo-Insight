import { randomUUID } from "node:crypto";

import {
  toFeishuUserId,
  type FeishuIdentityWithAccessTokenVerifier,
  type FeishuResourceMembershipVerifier,
} from "../current-user/index.js";
import type { Project, ProjectService } from "../project-service/index.js";
import { parseStandaloneFeishuBaseUrl } from "./project-data-source-configuration-service.js";
import { JsonProjectDataSourceRegistry } from "./project-data-source-registry.js";

const JOIN_INTENT_LIFETIME_MS = 10 * 60 * 1_000;
const JOIN_USER_SCOPE = "docs:permission.member:auth";

interface ProjectJoinIntent {
  state: string;
  sessionId: string;
  userId: string;
  projectId: string;
  baseToken: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface BeginProjectJoinInput {
  sessionId: string;
  userId: string;
  baseUrl: string;
}

export interface ProjectJoinAuthorization {
  authorizationUrl: string;
  state: string;
}

export interface CompleteProjectJoinInput {
  state: string;
  cookieState: string | undefined;
  sessionId: string | undefined;
  currentUserId: string;
  authorizationCode: string;
}

export class ProjectJoinUnavailableError extends Error {
  constructor() {
    super("Project joining is unavailable.");
    this.name = "ProjectJoinUnavailableError";
  }
}

export class ProjectJoinDeniedError extends Error {
  constructor() {
    super("Project join access was not verified.");
    this.name = "ProjectJoinDeniedError";
  }
}

/**
 * Holds only short-lived, in-memory Join intents. Resource links identify a
 * candidate project but never grant membership without user-token validation.
 */
export class FeishuProjectJoinService {
  private readonly intents = new Map<string, ProjectJoinIntent>();

  constructor(
    private readonly projectService: ProjectService,
    private readonly registry: JsonProjectDataSourceRegistry,
    private readonly identityVerifier: FeishuIdentityWithAccessTokenVerifier,
    private readonly membershipVerifier: FeishuResourceMembershipVerifier,
    private readonly authorizationConfiguration: { appId: string; redirectUri: string },
    private readonly now: () => number = Date.now,
    private readonly generateState: () => string = randomUUID,
  ) {}

  async beginJoin(input: BeginProjectJoinInput): Promise<ProjectJoinAuthorization> {
    const sessionId = requireText(input.sessionId);
    const userId = requireText(input.userId);
    let baseToken: string;
    try {
      baseToken = parseStandaloneFeishuBaseUrl(input.baseUrl);
    } catch {
      throw new ProjectJoinDeniedError();
    }

    const projectIds = await this.registry.findProjectIdsByFeishuBaseToken(baseToken);
    if (projectIds.length !== 1 || !projectIds[0]) throw new ProjectJoinDeniedError();

    const state = requireText(this.generateState());
    const createdAt = this.now();
    this.intents.set(state, {
      state,
      sessionId,
      userId,
      projectId: projectIds[0],
      baseToken,
      createdAt,
      expiresAt: createdAt + JOIN_INTENT_LIFETIME_MS,
      consumed: false,
    });
    return { state, authorizationUrl: createAuthorizationUrl(this.authorizationConfiguration, state) };
  }

  /** Lets the callback return one generic Join failure for expired intents. */
  hasRecordedState(state: string | undefined): boolean {
    return Boolean(state && this.intents.has(state));
  }

  async completeJoin(input: CompleteProjectJoinInput): Promise<Project> {
    const intent = this.intents.get(input.state);
    if (
      !intent
      || intent.consumed
      || intent.expiresAt <= this.now()
      || input.cookieState !== intent.state
      || input.sessionId !== intent.sessionId
      || input.currentUserId !== intent.userId
      || !input.authorizationCode.trim()
    ) {
      if (intent) this.intents.delete(intent.state);
      throw new ProjectJoinDeniedError();
    }

    intent.consumed = true;
    try {
      const authorization = await this.identityVerifier.exchangeAuthorizationCodeWithAccessToken(
        input.authorizationCode,
      );
      if (toFeishuUserId(authorization.identity.openId) !== intent.userId) {
        throw new ProjectJoinDeniedError();
      }
      const verified = await this.membershipVerifier.verifyBaseViewAccess(
        authorization.userAccessToken,
        intent.baseToken,
      );
      if (!verified) throw new ProjectJoinDeniedError();

      const project = await this.projectService.addMemberAfterVerifiedAccess(
        intent.projectId,
        intent.userId,
      );
      if (!project) throw new ProjectJoinDeniedError();
      return project;
    } catch (error) {
      if (error instanceof ProjectJoinDeniedError) throw error;
      throw new ProjectJoinDeniedError();
    } finally {
      this.intents.delete(intent.state);
    }
  }
}

function createAuthorizationUrl(
  configuration: { appId: string; redirectUri: string },
  state: string,
): string {
  const authorizationUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorizationUrl.searchParams.set("client_id", configuration.appId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", configuration.redirectUri);
  authorizationUrl.searchParams.set("scope", JOIN_USER_SCOPE);
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl.toString();
}

function requireText(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ProjectJoinUnavailableError();
  return normalized;
}

import {
  FeishuBaseSourceReaderAdapter,
  FeishuCalendarReader,
  FeishuChatReader,
  FeishuDocsReader,
  FeishuMinutesReader,
  FeishuTaskReader,
  createFeishuUserAccessClient,
  createSourceReadFailure,
  FeishuWikiDriveReader,
  createSourceReadUnavailable,
  type ProjectDataReader,
  type FeishuApiClient,
  type ProjectSourceReadContext,
  type ProjectSourceReadResult,
  type StandardProjectData,
} from "../../../feishu-connector/src/index.js";
import {
  FeishuUserCredentialUnavailableError,
  type FeishuSessionUserCredentialProvider,
} from "../current-user/index.js";
import type { ProjectDataSourceSubject } from "../project-context/index.js";
import {
  DefaultProjectDataSourceVisibilityChecker,
  JsonProjectDataSourceRegistry,
  toProjectDataSourceVisibility,
  type ConfiguredProjectDataSourceRegistration,
  type ProjectDataSourceRegistration,
  type ProjectDataSourceVisibilityChecker,
} from "../project-context/index.js";
import type { ProjectService } from "../project-service/index.js";
import { MultiSourceIntelligenceService } from "./multi-source-intelligence-service.js";
import type { SourceFreshnessRecord } from "./project-intelligence/index.js";
import type { NaturalLanguageCandidateExtractor } from "./source-intelligence-projection.js";
import type { ProjectIntelligenceProvider } from "./project-intelligence-api.js";

/**
 * Keeps the default runtime useful for Base-only projects. Non-Base Sources are
 * reported as unknown until their real-tenant authorization is wired; they are
 * never read optimistically.
 */
export function createBaseBackedProjectIntelligenceProvider(
  projectService: ProjectService,
  registry: JsonProjectDataSourceRegistry,
  reader: ProjectDataReader,
  client?: FeishuApiClient,
  visibilityChecker: ProjectDataSourceVisibilityChecker = new DefaultProjectDataSourceVisibilityChecker(),
  userCredentials?: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken">,
  candidateExtractor?: NaturalLanguageCandidateExtractor,
  onOperationalState?: (record: SourceFreshnessRecord) => void,
): ProjectIntelligenceProvider {
  const baseReader = new FeishuBaseSourceReaderAdapter(reader);
  const intelligence = new MultiSourceIntelligenceService(undefined, candidateExtractor);
  return async (projectId: string, subject: ProjectDataSourceSubject) => {
    const project = await projectService.getProject(projectId, subject.userId);
    if (!project) throw new Error("Project is unavailable.");
    await registry.ensureReady();
    const sourceResults: ProjectSourceReadResult<unknown>[] = [];
    let baseProjectData: StandardProjectData | undefined;

    // Sources are read concurrently to keep V3 pages responsive; Promise.all
    // preserves sourceResults ordering, and a failing read still rejects the
    // whole provider while every promise stays awaited (no unhandled rejection).
    const readableSources = project.dataSourceRefs
      .map((ref) => {
        const registration = registry.getForProject(project.id, ref);
        return registration ? { ref, registration } : undefined;
      })
      .filter((entry): entry is { ref: string; registration: ProjectDataSourceRegistration } => entry !== undefined);

    const settledSources = await Promise.all(readableSources.map(async ({ ref, registration }) => {
      const authorization = visibilityChecker.check({ projectId: project.id, sourceRef: ref, source: registration, subject });
      const context: ProjectSourceReadContext = {
        projectId: project.id,
        sourceRef: ref,
        sourceKind: registration.kind,
        subject,
        authorization,
        visibility: toProjectDataSourceVisibility(authorization),
      };
      if (registration.kind !== "feishu-base") {
        const result = await readConfiguredSource(client, registration, context, userCredentials);
        return { result, baseProjectData: undefined as StandardProjectData | undefined };
      }
      const result = await baseReader.read({ context, baseToken: registration.baseToken });
      return {
        result: result as ProjectSourceReadResult<unknown>,
        baseProjectData: result.status === "success"
          ? {
              project: result.data.project,
              tasks: result.data.tasks,
              metadata: { ...result.data.metadata, baseToken: registration.baseToken },
            }
          : undefined,
      };
    }));

    // Preserve the original ref-order walk so a later successful Base read
    // still wins (last-wins) exactly as the serial loop did.
    for (const settled of settledSources) {
      sourceResults.push(settled.result);
      if (settled.baseProjectData) baseProjectData = settled.baseProjectData;
    }

    if (!baseProjectData) throw new Error("A readable Base is required for the current deterministic risk path.");
    const result = await intelligence.build({ baseProjectData, sourceResults });
    for (const entry of result.sourceFreshness) onOperationalState?.(entry.record);
    return { result };
  };
}

async function readConfiguredSource(
  client: FeishuApiClient | undefined,
  registration: Exclude<ProjectDataSourceRegistration, { kind: "feishu-base" }>,
  context: ProjectSourceReadContext,
  userCredentials?: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken">,
): Promise<ProjectSourceReadResult<unknown>> {
  const authorizedContext = await resolveExplicitUserSourceAuthorization(client, registration, context, userCredentials);
  if (!client || !("locator" in registration) || authorizedContext.visibility !== "allowed") {
    return createSourceReadUnavailable({ context: authorizedContext, freshness: { fetchedAt: new Date().toISOString() } });
  }
  return readWithLocator(client, registration, authorizedContext, userCredentials);
}

async function readWithLocator(
  client: FeishuApiClient,
  registration: ConfiguredProjectDataSourceRegistration,
  context: ProjectSourceReadContext,
  userCredentials?: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken">,
): Promise<ProjectSourceReadResult<unknown>> {
  const identityContext = context.subject.identity?.context;
  const locator = registration.locator;
  if (locator.kind === "feishu-chat") {
    if (!identityContext) return createSourceReadUnavailable({ context, freshness: { fetchedAt: new Date().toISOString() } });
    // The user-token membership probe has already produced FND-03 evidence.
    // Feishu requires the application/bot identity for history reads.
    return new FeishuChatReader(client, { identityContext }).read({
      context,
      locator: { containerType: locator.containerType, containerId: locator.containerId },
    });
  }
  if (locator.kind === "feishu-minutes") {
    if (!identityContext) return createSourceReadUnavailable({ context, freshness: { fetchedAt: new Date().toISOString() } });
    return readWithUserCredential(
      context,
      userCredentials,
      (userClient) => new FeishuMinutesReader(userClient, { identityContext }).read({ context, locator: { minuteToken: locator.minuteToken } }),
      client,
    );
  }
  if (locator.kind === "feishu-docs") {
    return readWithUserCredential(
      context,
      userCredentials,
      (userClient) => new FeishuDocsReader(userClient).read({ context, locator: { documentToken: locator.documentToken } }),
      client,
    );
  }
  if (locator.kind === "feishu-wiki-drive") {
    const sourceLocator = locator.resourceKind === "wiki-node"
      ? { kind: "wiki-node" as const, nodeToken: locator.token }
      : { kind: "drive-file" as const, fileToken: locator.token, fileType: locator.fileType ?? "file" };
    return readWithUserCredential(
      context,
      userCredentials,
      (userClient) => new FeishuWikiDriveReader(userClient).read({ context, locator: sourceLocator }),
      client,
    );
  }
  if (locator.kind === "feishu-task") {
    if (!identityContext) return createSourceReadUnavailable({ context, freshness: { fetchedAt: new Date().toISOString() } });
    return readWithUserCredential(
      context,
      userCredentials,
      (userClient) => new FeishuTaskReader(userClient, { identityContext }).read({ context, locator: { taskIds: locator.taskIds } }),
      client,
    );
  }
  if (!identityContext) return createSourceReadUnavailable({ context, freshness: { fetchedAt: new Date().toISOString() } });
  return readWithUserCredential(
    context,
    userCredentials,
    (userClient) => new FeishuCalendarReader(userClient, { identityContext }).read({ context, locator: { calendarId: locator.calendarId, eventIds: locator.eventIds } }),
    client,
  );
}

async function readWithUserCredential(
  context: ProjectSourceReadContext,
  credentials: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken"> | undefined,
  read: (client: Pick<FeishuApiClient, "im" | "task" | "minutes" | "docx" | "wiki" | "drive" | "calendar">) => Promise<ProjectSourceReadResult<unknown>>,
  client: FeishuApiClient,
): Promise<ProjectSourceReadResult<unknown>> {
  if (!credentials) return credentialUnavailable(context);
  try {
    let result = await read(createFeishuUserAccessClient(client, await credentials.getUserAccessToken(context.subject)));
    if (result.status === "failure" && result.category === "invalid-credential") {
      result = await read(createFeishuUserAccessClient(client, await credentials.getUserAccessToken(context.subject, true)));
    }
    return result;
  } catch (error) {
    if (error instanceof FeishuUserCredentialUnavailableError) return credentialUnavailable(context);
    return credentialUnavailable(context);
  }
}

/**
 * FND-03 evidence for user-identity Sources is obtained from the same current
 * user's token against only the configured resource IDs. A successful probe
 * proves that this subject, not merely the application, can access the bound
 * resource. Application-identity Sources remain fail-closed until they gain
 * equivalent subject-specific evidence.
 */
async function resolveExplicitUserSourceAuthorization(
  client: FeishuApiClient | undefined,
  registration: Exclude<ProjectDataSourceRegistration, { kind: "feishu-base" }>,
  context: ProjectSourceReadContext,
  credentials?: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken">,
): Promise<ProjectSourceReadContext> {
  if (context.visibility !== "unknown" || !client || !("locator" in registration) || !credentials) return context;
  if (!isUserIdentityLocator(registration.locator)) return context;
  try {
    let probe = await probeExplicitUserResources(
      createFeishuUserAccessClient(client, await credentials.getUserAccessToken(context.subject)),
      registration.locator,
    );
    if (probe === "invalid-credential") {
      probe = await probeExplicitUserResources(
        createFeishuUserAccessClient(client, await credentials.getUserAccessToken(context.subject, true)),
        registration.locator,
      );
    }
    return probe === "allowed"
      ? { ...context, authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" }, visibility: "allowed" }
      : context;
  } catch {
    return context;
  }
}

function isUserIdentityLocator(locator: ConfiguredProjectDataSourceRegistration["locator"]): boolean {
  return locator.kind === "feishu-chat"
    || locator.kind === "feishu-minutes"
    || locator.kind === "feishu-docs"
    || locator.kind === "feishu-wiki-drive"
    || locator.kind === "feishu-task"
    || locator.kind === "feishu-calendar";
}

async function probeExplicitUserResources(
  client: Pick<FeishuApiClient, "im" | "task" | "minutes" | "docx" | "wiki" | "drive" | "calendar">,
  locator: ConfiguredProjectDataSourceRegistration["locator"],
): Promise<"allowed" | "invalid-credential" | "unknown"> {
  if (locator.kind === "feishu-chat") {
    const api = client.im?.v1?.chatMembers;
    if (!api) return "unknown";
    const response = await api.isInChat({ path: { chat_id: locator.containerId } });
    return response.code === 0 && response.data?.is_in_chat === true
      ? "allowed"
      : response.code === 99991668 ? "invalid-credential" : "unknown";
  }
  if (locator.kind === "feishu-minutes") {
    const response = await client.minutes?.v1?.minute.get({ path: { minute_token: locator.minuteToken } });
    return toProbeResult([response?.code]);
  }
  if (locator.kind === "feishu-docs") {
    return toProbeResult([(await client.docx?.v1?.document.get({ path: { document_id: locator.documentToken } }))?.code]);
  }
  if (locator.kind === "feishu-wiki-drive") {
    if (locator.resourceKind === "wiki-node") {
      return toProbeResult([(await client.wiki?.v2?.space.getNode({ params: { token: locator.token } }))?.code]);
    }
    return toProbeResult([(await client.drive?.v1?.meta.batchQuery({ data: { request_docs: [{ doc_token: locator.token, doc_type: locator.fileType ?? "file" }] } }))?.code]);
  }
  if (locator.kind === "feishu-task") {
    const api = client.task?.v1?.task;
    if (!api) return "unknown";
    const responses = await Promise.all(locator.taskIds.map((taskId) => api.get({ path: { task_id: taskId }, params: { user_id_type: "open_id" } })));
    return toProbeResult(responses.map((response) => response.code));
  }
  if (locator.kind === "feishu-calendar") {
    const api = client.calendar?.v4?.calendarEvent;
    if (!api) return "unknown";
    const responses = await Promise.all(locator.eventIds.map((eventId) => api.get({ path: { calendar_id: locator.calendarId, event_id: eventId }, params: { need_attendee: false, user_id_type: "open_id" } })));
    return toProbeResult(responses.map((response) => response.code));
  }
  return "unknown";
}

function toProbeResult(codes: Array<number | undefined>): "allowed" | "invalid-credential" | "unknown" {
  if (codes.every((code) => code === 0)) return "allowed";
  return codes.some((code) => code === 99991668) ? "invalid-credential" : "unknown";
}

function credentialUnavailable(context: ProjectSourceReadContext): ProjectSourceReadResult<unknown> {
  return createSourceReadFailure({
    context,
    category: "invalid-credential",
    freshness: { fetchedAt: new Date().toISOString() },
  });
}

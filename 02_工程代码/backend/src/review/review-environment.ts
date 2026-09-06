import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type {
  AiExplanationInput,
  AiExplanationOutput,
  GlobalSynthesisInput,
  GlobalSynthesisOutput,
  RiskExplanationAnalyzer,
} from "../../../ai-service/src/index.js";
import type {
  FeishuBaseSourceSnapshot,
  FeishuChatSourceSnapshot,
  FeishuDocsSourceSnapshot,
  FeishuMinutesSourceSnapshot,
  FeishuTaskSourceSnapshot,
  ProjectDataReader,
  ProjectSourceReadContext,
  ProjectSourceReadResult,
  StandardProjectData,
  StandardTask,
} from "../../../feishu-connector/src/index.js";
import {
  createSourceReadFailure,
  createSourceReadSuccess,
  createSourceReadUnavailable,
} from "../../../feishu-connector/src/index.js";
import { ProjectAnalysisService } from "../analysis-service/index.js";
import { ProjectReportService } from "../ai-analysis-service/index.js";
import { FixedCurrentUserContextProvider } from "../current-user/index.js";
import { GlobalInsightService, GlobalInsightSynthesisService } from "../global-insight/index.js";
import {
  JsonProjectDataSourceRegistry,
  ProjectContextReportService,
  ProjectContextService,
  ProjectContextSummaryService,
  ProjectDataSourceConfigurationService,
  ProjectDataSourceResolver,
  ProjectSourceConfigurationService,
  type ProjectDataSourceAuthorization,
  type ProjectDataSourceVisibilityCheck,
  type ProjectDataSourceVisibilityChecker,
  type ProjectSourceOperationalState,
} from "../project-context/index.js";
import {
  MultiSourceIntelligenceService,
  ProjectIntelligenceQueryService,
  SourceFreshnessService,
  type MultiSourceIntelligenceResult,
  type NaturalLanguageCandidateExtractor,
} from "../intelligence/index.js";
import { JsonProjectRepository, ProjectService } from "../project-service/index.js";

export const REVIEW_USER_ID = "echo-review-user";
export const REVIEW_NOW = new Date("2026-08-30T10:00:00.000+08:00");

export interface ReviewEnvironment {
  currentUserContextProvider: FixedCurrentUserContextProvider;
  projectService: ProjectService;
  projectContextReportService: ProjectContextReportService;
  projectContextSummaryService: ProjectContextSummaryService;
  projectDataSourceConfigurationService: ProjectDataSourceConfigurationService;
  projectSourceConfigurationService: ProjectSourceConfigurationService;
  projectIntelligenceQueryService: ProjectIntelligenceQueryService;
  globalInsightService: GlobalInsightService;
  globalInsightSynthesisService: GlobalInsightSynthesisService;
  reader: ProjectDataReader;
  analysisService: ProjectAnalysisService;
  reportService: ProjectReportService;
  projectStorePath: string;
  dataSourceRegistryPath: string;
}

const REVIEW_PROJECTS = [
  { id: "review-a", name: "Project A｜健康项目", ownerId: REVIEW_USER_ID },
  { id: "review-b", name: "Project B｜明确风险项目", ownerId: REVIEW_USER_ID },
  { id: "review-c", name: "Project C｜自然语言潜在风险", ownerId: REVIEW_USER_ID },
  { id: "review-d", name: "Project D｜来源冲突", ownerId: REVIEW_USER_ID },
  { id: "review-e", name: "Project E｜Source Failure / Permission", ownerId: "review-owner-e", members: [REVIEW_USER_ID] },
] as const;

const SOURCE_DEFINITIONS = {
  "review-a": [{ ref: "review-a-base", kind: "feishu-base", name: "健康项目 Base" }],
  "review-b": [
    { ref: "review-b-base", kind: "feishu-base", name: "风险项目 Base" },
    { ref: "review-b-task", kind: "feishu-task", name: "风险任务" },
  ],
  "review-c": [
    { ref: "review-c-base", kind: "feishu-base", name: "正式计划 Base" },
    { ref: "review-c-chat", kind: "feishu-chat", name: "项目讨论群" },
    { ref: "review-c-minutes", kind: "feishu-minutes", name: "项目晨会妙记" },
  ],
  "review-d": [
    { ref: "review-d-base", kind: "feishu-base", name: "正式排期 Base" },
    { ref: "review-d-task", kind: "feishu-task", name: "执行 Task" },
  ],
  "review-e": [
    { ref: "review-e-base", kind: "feishu-base", name: "可用 Base" },
    { ref: "review-e-docs", kind: "feishu-docs", name: "数据较旧的项目文档" },
    { ref: "review-e-chat", kind: "feishu-chat", name: "当前读取受限的项目群" },
    { ref: "review-e-minutes", kind: "feishu-minutes", name: "成员无权查看的妙记" },
  ],
} as const;

const REVIEW_DATA = new Map<string, StandardProjectData>([
  ["review-a-base-token", projectData("review-a", "Project A｜健康项目", [task("a-1", "稳定交付", "进行中", "2026-09-20")])],
  ["review-b-base-token", projectData("review-b", "Project B｜明确风险项目", [task("b-1", "关键接口联调", "阻塞", "2026-08-01", "依赖未解除")])],
  ["review-c-base-token", projectData("review-c", "Project C｜自然语言潜在风险", [task("c-1", "正式发布计划", "进行中", "2026-09-20")])],
  ["review-d-base-token", projectData("review-d", "Project D｜来源冲突", [task("d-1", "宣发上线", "进行中", "2026-09-04")])],
  ["review-e-base-token", projectData("review-e", "Project E｜Source Failure / Permission", [task("e-1", "正常推进事项", "进行中", "2026-09-25")])],
]);

export async function createReviewEnvironment(runtimeDirectory: string, reset = true): Promise<ReviewEnvironment> {
  assertReviewRuntimeDirectory(runtimeDirectory);
  if (reset) await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const projectStorePath = resolve(runtimeDirectory, "projects.json");
  const dataSourceRegistryPath = resolve(runtimeDirectory, "data-sources.json");
  const ids = REVIEW_PROJECTS.map((project) => project.id);
  const projectService = new ProjectService(
    new JsonProjectRepository(projectStorePath),
    () => REVIEW_NOW,
    () => ids.shift() ?? "unexpected-review-project",
  );
  const registry = new JsonProjectDataSourceRegistry(dataSourceRegistryPath);
  await registry.ensureReady();

  for (const project of REVIEW_PROJECTS) {
    const definitions = SOURCE_DEFINITIONS[project.id];
    await projectService.createProject({
      name: project.name,
      creatorId: project.ownerId,
      ownerId: project.ownerId,
      members: "members" in project ? [...project.members] : [],
      dataSourceRefs: definitions.map((source) => source.ref),
    });
    for (const source of definitions) {
      if (source.kind === "feishu-base") {
        await registry.registerFeishuBase(project.id, source.ref, `${project.id}-base-token`);
      } else {
        await registry.registerConfiguredSource({
          projectId: project.id,
          ref: source.ref,
          publicId: `${source.ref}-public`,
          displayName: source.name,
          locator: locatorFor(source.kind, source.ref),
        });
      }
    }
  }

  const reader: ProjectDataReader = {
    async readProjectData(baseToken) {
      const value = REVIEW_DATA.get(baseToken);
      if (!value) throw new Error("Unknown review Base.");
      return structuredClone(value);
    },
  };
  const visibilityChecker = new ReviewVisibilityChecker();
  const resolver = new ProjectDataSourceResolver(registry, visibilityChecker);
  const contextService = new ProjectContextService(projectService, resolver);
  const analysisService = new ProjectAnalysisService(reader, () => REVIEW_NOW);
  const reportService = new ProjectReportService(analysisService, new ReviewExplanationAnalyzer());
  const operationalStates = reviewOperationalStates();
  const projectSourceConfigurationService = new ProjectSourceConfigurationService(
    projectService,
    registry,
    visibilityChecker,
    () => "review-source-id",
    (projectId, sourceRef) => operationalStates.get(`${projectId}:${sourceRef}`),
  );
  const globalInsightService = new GlobalInsightService(projectService, contextService, analysisService, () => REVIEW_NOW.getTime());
  const globalInsightSynthesisService = new GlobalInsightSynthesisService(globalInsightService, {
    async synthesize(input: GlobalSynthesisInput): Promise<GlobalSynthesisOutput> {
      return {
        summary: "Review 环境仅综合已确认的规则风险。",
        priorities: input.insights.map((item) => ({ insightId: item.insightId, explanation: item.ruleBasis, suggestedAction: "请项目负责人确认并处理已识别风险。" })),
        limitations: ["本地 Review 数据不代表真实飞书租户。"],
      };
    },
  });
  const intelligence = await buildReviewIntelligence();

  return {
    currentUserContextProvider: new FixedCurrentUserContextProvider(REVIEW_USER_ID),
    projectService,
    projectContextReportService: new ProjectContextReportService(contextService, reportService),
    projectContextSummaryService: new ProjectContextSummaryService(contextService, analysisService, () => REVIEW_NOW.getTime()),
    projectDataSourceConfigurationService: new ProjectDataSourceConfigurationService(
      projectService,
      registry,
      async (baseToken) => ({ displayName: (await reader.readProjectData(baseToken)).project.name }),
    ),
    projectSourceConfigurationService,
    projectIntelligenceQueryService: new ProjectIntelligenceQueryService(projectService, async (projectId) => {
      const value = intelligence.get(projectId);
      if (!value) throw new Error("Review intelligence not found.");
      return value;
    }),
    globalInsightService,
    globalInsightSynthesisService,
    reader,
    analysisService,
    reportService,
    projectStorePath,
    dataSourceRegistryPath,
  };
}

function assertReviewRuntimeDirectory(directory: string): void {
  const normalized = resolve(directory);
  const expectedSuffix = `${sep}backend${sep}.runtime${sep}review-v3`.toLowerCase();
  if (!normalized.toLowerCase().endsWith(expectedSuffix)) {
    throw new Error("Review runtime must be the dedicated backend/.runtime/review-v3 directory.");
  }
}

class ReviewVisibilityChecker implements ProjectDataSourceVisibilityChecker {
  check(input: ProjectDataSourceVisibilityCheck): ProjectDataSourceAuthorization {
    if (input.source.enabled === false) return { sourceAuthorization: "unavailable", subjectEligibility: "unknown" };
    if (input.projectId === "review-e" && input.sourceRef === "review-e-minutes" && input.subject.userId === REVIEW_USER_ID) {
      return { sourceAuthorization: "authorized", subjectEligibility: "denied" };
    }
    return { sourceAuthorization: "authorized", subjectEligibility: "allowed" };
  }
}

class ReviewExplanationAnalyzer implements RiskExplanationAnalyzer {
  async analyze(input: AiExplanationInput): Promise<AiExplanationOutput> {
    return {
      risks: input.riskContexts.map((risk) => ({
        id: risk.signalId,
        title: risk.primaryTask?.name ?? "已确认项目风险",
        evidenceRefs: [risk.signalId],
        reason: risk.factualEvidence.join("；") || "由确定性规则识别。",
        impact: "可能影响当前项目计划，需要负责人处理。",
        suggestedActions: ["核对结构化事实并处理已确认风险。"],
      })),
      limitations: ["Review 环境使用确定性本地解释器，不调用外部 AI。"],
    };
  }
}

async function buildReviewIntelligence(): Promise<Map<string, { result: MultiSourceIntelligenceResult; aiOutput: AiExplanationOutput }>> {
  const map = new Map<string, { result: MultiSourceIntelligenceResult; aiOutput: AiExplanationOutput }>();
  const extractor: NaturalLanguageCandidateExtractor = {
    async extract({ excerpt }) {
      if (excerpt.includes("9 月 4 日")) return [{ kind: "prediction", summary: "技术问题可能在 9 月 4 日解决（待确认）" }];
      if (excerpt.includes("9 月 10 日")) return [{ kind: "proposal", summary: "宣发可能调整到 9 月 10 日（待确认）" }];
      if (excerpt.includes("明天上午")) return [{ kind: "pending-confirmation", summary: "明天上午再次确认（待确认）" }];
      return [];
    },
  };
  for (const project of REVIEW_PROJECTS) {
    const baseData = REVIEW_DATA.get(`${project.id}-base-token`)!;
    const results = reviewSourceResults(project.id, baseData);
    const freshness = new SourceFreshnessService(() => REVIEW_NOW);
    if (project.id === "review-e") freshness.record(staleDocsSuccess());
    const service = new MultiSourceIntelligenceService(freshness, extractor, () => REVIEW_NOW);
    const result = await service.build({ baseProjectData: baseData, sourceResults: results });
    map.set(project.id, { result, aiOutput: reviewAiOutput(project.id, result) });
  }
  return map;
}

function reviewSourceResults(projectId: string, data: StandardProjectData): ProjectSourceReadResult<unknown>[] {
  const base = success(baseContext(projectId), safeBaseSnapshot(data), "feishu-base");
  if (projectId === "review-a") return [base];
  if (projectId === "review-b") return [base, success(context(projectId, "review-b-task", "feishu-task"), taskSnapshot("b-1", "2026-08-01"), "feishu-task")];
  if (projectId === "review-c") return [
    base,
    success(context(projectId, "review-c-chat", "feishu-chat"), chatSnapshot(), "chat"),
    success(context(projectId, "review-c-minutes", "feishu-minutes"), minutesSnapshot(), "feishu-minutes"),
  ];
  if (projectId === "review-d") return [base, success(context(projectId, "review-d-task", "feishu-task"), taskSnapshot("d-1", "2026-09-08"), "feishu-task")];
  return [
    base,
    createSourceReadFailure({ context: context(projectId, "review-e-docs", "feishu-docs"), category: "rate-limited", freshness: { fetchedAt: REVIEW_NOW.toISOString() } }),
    createSourceReadFailure({ context: context(projectId, "review-e-chat", "feishu-chat"), category: "rate-limited", freshness: { fetchedAt: REVIEW_NOW.toISOString() } }),
    createSourceReadUnavailable({ context: context(projectId, "review-e-minutes", "feishu-minutes", "denied"), freshness: { fetchedAt: REVIEW_NOW.toISOString() } }),
  ];
}

function baseContext(projectId: string): ProjectSourceReadContext { return context(projectId, `${projectId}-base`, "feishu-base"); }
function context(projectId: string, sourceRef: string, sourceKind: ProjectSourceReadContext["sourceKind"], visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext {
  return {
    projectId,
    sourceRef,
    sourceKind,
    subject: { userId: REVIEW_USER_ID },
    authorization: visibility === "denied"
      ? { sourceAuthorization: "authorized", subjectEligibility: "denied" }
      : { sourceAuthorization: "authorized", subjectEligibility: "allowed" },
    visibility,
  };
}

function success<T>(readContext: ProjectSourceReadContext, data: T, resourceType: string) {
  return createSourceReadSuccess({ context: readContext, data, resources: [{ sourceRef: readContext.sourceRef, resourceType }], freshness: { fetchedAt: REVIEW_NOW.toISOString(), sourceUpdatedAt: "2026-08-30T01:00:00.000Z" } });
}

function staleDocsSuccess() {
  const data: FeishuDocsSourceSnapshot = { locator: { documentToken: "review-e-doc" }, document: { documentToken: "review-e-doc", title: "历史项目说明", revisionId: 1 }, blocks: [{ blockId: "block-1", text: "这是上次成功读取的内容。" }] };
  return createSourceReadSuccess({ context: context("review-e", "review-e-docs", "feishu-docs"), data, resources: [{ sourceRef: "review-e-docs", resourceType: "feishu-docx" }], freshness: { fetchedAt: "2026-08-20T02:00:00.000Z" } });
}

function safeBaseSnapshot(data: StandardProjectData): FeishuBaseSourceSnapshot {
  const { baseToken: _baseToken, ...metadata } = data.metadata;
  return { project: { ...data.project }, tasks: structuredClone(data.tasks), metadata };
}

function taskSnapshot(taskId: string, due: string): FeishuTaskSourceSnapshot {
  return { locator: { taskIds: [taskId] }, tasks: [{ taskId, title: "结构化任务", due: { time: due, timezone: "Asia/Shanghai", isAllDay: true }, collaborators: [], followers: [] }] };
}

function chatSnapshot(): FeishuChatSourceSnapshot {
  return { locator: { containerType: "chat", containerId: "review-c-chat" }, messages: [
    { messageId: "message-c-1", content: "技术问题可能会在 9 月 4 日解决。", createTime: "2026-08-30T01:00:00.000Z", messageType: "text" },
    { messageId: "message-c-2", content: "那么宣发可能调整到 9 月 10 日。", createTime: "2026-08-30T01:01:00.000Z", messageType: "text" },
  ] };
}

function minutesSnapshot(): FeishuMinutesSourceSnapshot {
  return { locator: { minuteToken: "review-c-minutes" }, metadata: { minuteToken: "review-c-minutes", title: "项目晨会" }, transcript: { kind: "raw-transcript", state: "available", content: "明天上午再确认。" }, artifacts: [], meetingRelation: { state: "unknown" } };
}

function reviewAiOutput(projectId: string, result: MultiSourceIntelligenceResult): AiExplanationOutput {
  const limitations: Record<string, string> = {
    "review-a": "仅解释已确认的结构化事实。",
    "review-b": "已确认风险来自 Base / Task 结构化事实，AI 未修改风险等级。",
    "review-c": "聊天与妙记内容仅为待确认信息，尚未改变正式 Deadline、风险或健康度。",
    "review-d": "Base 与 Task 排期冲突尚未解决，需要负责人确认；AI 未选择赢家。",
    "review-e": "部分来源数据较旧、读取受限或成员无权查看；AI 未补全缺失内容。",
  };
  return {
    risks: result.risk.analysis.riskSignals.map((risk) => ({ id: risk.signalId, title: "已确认规则风险", evidenceRefs: [risk.signalId], reason: risk.evidence, impact: "可能影响当前交付计划。", suggestedActions: ["优先处理已确认风险。"] })),
    limitations: [limitations[projectId]!],
  };
}

function reviewOperationalStates(): Map<string, ProjectSourceOperationalState> {
  const fresh = { freshness: "fresh" as const, lastSuccessfulReadAt: REVIEW_NOW.toISOString() };
  const values = new Map<string, ProjectSourceOperationalState>();
  for (const project of REVIEW_PROJECTS) for (const source of SOURCE_DEFINITIONS[project.id]) values.set(`${project.id}:${source.ref}`, fresh);
  values.set("review-e:review-e-docs", { freshness: "stale", lastSuccessfulReadAt: "2026-08-20T02:00:00.000Z", failureCategory: "rate-limited" });
  values.set("review-e:review-e-chat", { freshness: "unknown", failureCategory: "rate-limited" });
  values.set("review-e:review-e-minutes", { freshness: "unavailable", failureCategory: "permission-denied" });
  return values;
}

function locatorFor(kind: Exclude<ProjectSourceReadContext["sourceKind"], "feishu-base">, ref: string) {
  if (kind === "feishu-chat") return { kind, containerType: "chat" as const, containerId: ref };
  if (kind === "feishu-minutes") return { kind, minuteToken: ref };
  if (kind === "feishu-docs") return { kind, documentToken: ref };
  if (kind === "feishu-task") return { kind, taskIds: [ref] };
  if (kind === "feishu-wiki-drive") return { kind, resourceKind: "wiki-node" as const, token: ref };
  return { kind, calendarId: ref, eventIds: [`${ref}-event`] };
}

function projectData(id: string, name: string, tasks: StandardTask[]): StandardProjectData {
  return { project: { id, name, source: "feishu-base" }, tasks, metadata: { baseToken: `${id}-base-token`, tableCount: 1, recordCount: tasks.length, retrievedAt: REVIEW_NOW.toISOString(), accessMode: "read-only", tables: [{ id: `${id}-table`, name: "Review Tasks", recordCount: tasks.length }] } };
}

function task(id: string, name: string, status: string, deadline: string, description: string | null = null): StandardTask {
  return { id, tableId: "review-table", tableName: "Review Tasks", name, owner: "Review Owner", status, deadline, riskLevel: "L1", description, attributes: {} };
}

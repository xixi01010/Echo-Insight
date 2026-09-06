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
  FeishuCalendarSourceSnapshot,
  FeishuChatSourceSnapshot,
  FeishuDocsSourceSnapshot,
  FeishuMinutesSourceSnapshot,
  FeishuTaskSourceSnapshot,
  FeishuWikiDriveSourceSnapshot,
  ProjectDataReader,
  ProjectSourceReadContext,
  ProjectSourceReadResult,
  StandardProjectData,
  StandardTask,
} from "../../../feishu-connector/src/index.js";
import { createSourceReadSuccess } from "../../../feishu-connector/src/index.js";
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

export const DEMO_USER_ID = "echo-demo-user";
export const DEMO_NOW = new Date("2026-09-06T10:00:00.000+08:00");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_BASE_NOW = DEMO_NOW.getTime();

function dateAt(offsetDays: number, hour = 9, minute = 0): string {
  const value = new Date(DEMO_BASE_NOW + offsetDays * DAY_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return value.getFullYear() + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate()) + "T" + pad(hour) + ":" + pad(minute) + ":00.000+08:00";
}

function isoAt(offsetDays: number, hour = 1, minute = 0): string {
  return new Date(DEMO_BASE_NOW + offsetDays * DAY_MS + hour * 3_600_000 + minute * 60_000).toISOString();
}

interface DemoSourceDef {
  ref: string;
  kind: "feishu-base" | "feishu-chat" | "feishu-minutes" | "feishu-docs" | "feishu-task" | "feishu-wiki-drive" | "feishu-calendar";
  name: string;
}

interface DemoProjectDef {
  id: string;
  name: string;
  sources: DemoSourceDef[];
}

const DEMO_PROJECTS: DemoProjectDef[] = [
  {
    id: "demo-brand",
    name: "【演示】品牌焕新计划",
    sources: [
      { ref: "demo-brand-base", kind: "feishu-base", name: "飞书多维表格" },
      { ref: "demo-brand-docs", kind: "feishu-docs", name: "飞书文档" },
    ],
  },
  {
    id: "demo-growth",
    name: "【演示】秋季增长活动",
    sources: [
      { ref: "demo-growth-base", kind: "feishu-base", name: "飞书多维表格" },
      { ref: "demo-growth-chat", kind: "feishu-chat", name: "飞书群聊" },
      { ref: "demo-growth-calendar", kind: "feishu-calendar", name: "飞书日历" },
    ],
  },
  {
    id: "demo-content",
    name: "【演示】内容平台重构",
    sources: [
      { ref: "demo-content-base", kind: "feishu-base", name: "飞书多维表格" },
      { ref: "demo-content-chat", kind: "feishu-chat", name: "飞书群聊" },
      { ref: "demo-content-minutes", kind: "feishu-minutes", name: "飞书妙记" },
      { ref: "demo-content-docs", kind: "feishu-docs", name: "飞书文档" },
      { ref: "demo-content-wiki", kind: "feishu-wiki-drive", name: "飞书知识库/云盘" },
      { ref: "demo-content-task", kind: "feishu-task", name: "飞书任务" },
      { ref: "demo-content-calendar", kind: "feishu-calendar", name: "飞书日历" },
    ],
  },
  {
    id: "demo-explore",
    name: "【演示】新产品探索",
    sources: [
      { ref: "demo-explore-base", kind: "feishu-base", name: "飞书多维表格" },
      { ref: "demo-explore-wiki", kind: "feishu-wiki-drive", name: "飞书知识库/云盘" },
      { ref: "demo-explore-task", kind: "feishu-task", name: "飞书任务" },
    ],
  },
  {
    id: "demo-recruit",
    name: "【演示】智能招聘助手",
    sources: [
      { ref: "demo-recruit-base", kind: "feishu-base", name: "飞书多维表格" },
      { ref: "demo-recruit-chat", kind: "feishu-chat", name: "飞书群聊" },
      { ref: "demo-recruit-minutes", kind: "feishu-minutes", name: "飞书妙记" },
      { ref: "demo-recruit-docs", kind: "feishu-docs", name: "飞书文档" },
    ],
  },
];

function t(id: string, name: string, owner: string, status: string, deadline: string, description: string | null = null, dependencyIds: string[] = []): StandardTask {
  return {
    id,
    tableId: "demo-table",
    tableName: "项目任务",
    name,
    owner,
    status,
    deadline,
    riskLevel: "L1",
    description,
    attributes: dependencyIds.length > 0 ? { dependencyIds } : {},
  };
}

const DEMO_DATA = new Map<string, StandardProjectData>([
  ["demo-brand-base-token", projectData("demo-brand", "【演示】品牌焕新计划", [
    t("brand-1", "主视觉方向确认", "林晓", "已完成", dateAt(-2), "两版主视觉评审通过，A 版定稿。"),
    t("brand-2", "多渠道物料适配", "苏婉", "已完成", dateAt(-1), "全渠道适配物料已交付并验收。"),
    t("brand-3", "品牌手册更新", "林晓", "进行中", dateAt(6)),
    t("brand-4", "官网新版上线", "周奕", "进行中", dateAt(7)),
    t("brand-5", "发布会物料准备", "陈默", "进行中", dateAt(9)),
    t("brand-6", "渠道反馈收集", "苏婉", "进行中", dateAt(-1), "首批渠道反馈仍在回收，计划略有延后。"),
  ])],
  ["demo-growth-base-token", projectData("demo-growth", "【演示】秋季增长活动", [
    t("growth-1", "活动页开发", "周奕", "已完成", dateAt(-4)),
    t("growth-2", "广告素材制作", "陈默", "进行中", dateAt(-1), "短视频素材仍在制作，等待最终脚本确认。"),
    t("growth-3", "KOL 名单确认", "苏婉", "进行中", dateAt(5)),
    t("growth-4", "投放排期确认", "周奕", "阻塞", dateAt(8), "等待预算评审结论后锁定排期。"),
  ])],
  ["demo-content-base-token", projectData("demo-content", "【演示】内容平台重构", [
    t("content-1", "旧数据迁移演练", "林晓", "阻塞", dateAt(3), "源库权限审批未完成，迁移演练暂停。"),
    t("content-2", "内容模型迁移", "周奕", "进行中", dateAt(-5), "新内容模型仍在补充字段定义。"),
    t("content-3", "搜索服务重构", "陈默", "无法继续", dateAt(-7), "依赖算法侧接口尚未提供。", ["content-1"]),
    t("content-4", "前端内容页适配", "苏婉", "进行中", dateAt(-2)),
  ])],
  ["demo-explore-base-token", projectData("demo-explore", "【演示】新产品探索", [
    t("explore-1", "核心价值假设", "林晓", "进行中", dateAt(-1), "正在结合访谈反馈验证需求是否真实存在。"),
    t("explore-2", "用户访谈", "周奕", "进行中", dateAt(-3), "已完成 4 场访谈，样本覆盖不足。"),
    t("explore-3", "竞品与替代方案调研", "陈默", "待开始", dateAt(-2), "调研范围与完成时间待确认。"),
    t("explore-4", "目标使用场景梳理", "苏婉", "进行中", dateAt(-1)),
    t("explore-5", "用户验证准备", "林晓", "待开始", dateAt(12), "验证对象与测试方式待定。"),
    t("explore-6", "第一轮用户验证", "周奕", "待开始", dateAt(15)),
  ])],
  ["demo-recruit-base-token", projectData("demo-recruit", "【演示】智能招聘助手", [
    t("recruit-1", "简历解析准确率优化", "陈默", "阻塞", dateAt(2), "解析结果抽检不达标，等待标注数据补充。"),
    t("recruit-2", "评测数据集整理", "林晓", "无法继续", dateAt(-3), "缺少已确认的评测通过标准。"),
    t("recruit-3", "职位匹配能力", "周奕", "进行中", dateAt(-2), "匹配模型仍在小流量验证。"),
    t("recruit-4", "面试题生成", "苏婉", "阻塞", dateAt(4), "生成题目与岗位画像对齐度不足，等待规则评审。"),
    t("recruit-5", "候选人反馈闭环", "陈默", "进行中", dateAt(10)),
  ])],
]);

export interface DemoEnvironment {
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

export async function createDemoEnvironment(runtimeDirectory: string, reset = true): Promise<DemoEnvironment> {
  assertDemoRuntimeDirectory(runtimeDirectory);
  const now = new Date(DEMO_NOW);
  if (reset) await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const projectStorePath = resolve(runtimeDirectory, "projects.json");
  const dataSourceRegistryPath = resolve(runtimeDirectory, "data-sources.json");
  const ids = DEMO_PROJECTS.map((project) => project.id);
  const projectService = new ProjectService(
    new JsonProjectRepository(projectStorePath),
    () => now,
    () => ids.shift() ?? "unexpected-demo-project",
  );
  const registry = new JsonProjectDataSourceRegistry(dataSourceRegistryPath);
  await registry.ensureReady();

  for (const project of DEMO_PROJECTS) {
    await projectService.createProject({
      name: project.name,
      creatorId: DEMO_USER_ID,
      ownerId: DEMO_USER_ID,
      members: [],
      dataSourceRefs: project.sources.map((source) => source.ref),
    });
    for (const source of project.sources) {
      if (source.kind === "feishu-base") {
        await registry.registerFeishuBase(project.id, source.ref, source.ref + "-token");
      } else {
        await registry.registerConfiguredSource({
          projectId: project.id,
          ref: source.ref,
          publicId: source.ref + "-public",
          displayName: source.name,
          locator: locatorFor(source.kind, source.ref),
        });
      }
    }
  }

  const reader: ProjectDataReader = {
    async readProjectData(baseToken) {
      const value = DEMO_DATA.get(baseToken);
      if (!value) throw new Error("Unknown demo Base.");
      return structuredClone(value);
    },
  };
  const visibilityChecker = new DemoVisibilityChecker();
  const resolver = new ProjectDataSourceResolver(registry, visibilityChecker);
  const contextService = new ProjectContextService(projectService, resolver);
  const analysisService = new ProjectAnalysisService(reader, () => now);
  const reportService = new ProjectReportService(analysisService, new DemoExplanationAnalyzer());
  const operationalStates = demoOperationalStates();
  const projectSourceConfigurationService = new ProjectSourceConfigurationService(
    projectService,
    registry,
    visibilityChecker,
    () => "demo-source-id",
    (projectId, sourceRef) => operationalStates.get(projectId + ":" + sourceRef),
  );
  const globalInsightService = new GlobalInsightService(projectService, contextService, analysisService, () => now.getTime());
  const globalInsightSynthesisService = new GlobalInsightSynthesisService(globalInsightService, {
    async synthesize(input: GlobalSynthesisInput): Promise<GlobalSynthesisOutput> {
      return {
        summary: "Demo 环境仅综合已确认的规则风险，用于产品展示。",
        priorities: input.insights.map((item) => ({ insightId: item.insightId, explanation: item.ruleBasis, suggestedAction: "请项目负责人确认并处理已识别风险。" })),
        limitations: ["Demo 数据为合成演示数据，不代表真实飞书租户。"],
      };
    },
  });
  const intelligence = await buildDemoIntelligence(now);

  return {
    currentUserContextProvider: new FixedCurrentUserContextProvider(DEMO_USER_ID),
    projectService,
    projectContextReportService: new ProjectContextReportService(contextService, reportService),
    projectContextSummaryService: new ProjectContextSummaryService(contextService, analysisService, () => now.getTime()),
    projectDataSourceConfigurationService: new ProjectDataSourceConfigurationService(
      projectService,
      registry,
      async (baseToken) => ({ displayName: (await reader.readProjectData(baseToken)).project.name }),
    ),
    projectSourceConfigurationService,
    projectIntelligenceQueryService: new ProjectIntelligenceQueryService(projectService, async (projectId) => {
      const value = intelligence.get(projectId);
      if (!value) throw new Error("Demo intelligence not found.");
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

function assertDemoRuntimeDirectory(directory: string): void {
  const normalized = resolve(directory);
  const expectedSuffix = sep + "backend" + sep + ".runtime" + sep + "demo-v3";
  if (!normalized.toLowerCase().endsWith(expectedSuffix.toLowerCase())) {
    throw new Error("Demo runtime must be the dedicated backend/.runtime/demo-v3 directory.");
  }
}

class DemoVisibilityChecker implements ProjectDataSourceVisibilityChecker {
  check(_input: ProjectDataSourceVisibilityCheck): ProjectDataSourceAuthorization {
    return { sourceAuthorization: "authorized", subjectEligibility: "allowed" };
  }
}

class DemoExplanationAnalyzer implements RiskExplanationAnalyzer {
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
      limitations: ["Demo 环境使用确定性本地解释器，不调用外部 AI。"],
    };
  }
}

async function buildDemoIntelligence(now: Date): Promise<Map<string, { result: MultiSourceIntelligenceResult; aiOutput: AiExplanationOutput }>> {
  const map = new Map<string, { result: MultiSourceIntelligenceResult; aiOutput: AiExplanationOutput }>();
  const extractor: NaturalLanguageCandidateExtractor = {
    async extract({ excerpt }) {
      if (excerpt.includes("可能提前")) return [{ kind: "prediction", summary: "投放排期可能提前（待确认）" }];
      if (excerpt.includes("争取下周")) return [{ kind: "pending-confirmation", summary: "算法接口争取下周提供（待确认）" }];
      if (excerpt.includes("计划调整")) return [{ kind: "proposal", summary: "面试安排计划调整（待确认）" }];
      return [];
    },
  };
  for (const project of DEMO_PROJECTS) {
    const baseData = DEMO_DATA.get(project.id + "-base-token")!;
    const results = demoSourceResults(project.id, baseData);
    const freshness = new SourceFreshnessService(() => now);
    const service = new MultiSourceIntelligenceService(freshness, extractor, () => now);
    const result = await service.build({ baseProjectData: baseData, sourceResults: results });
    map.set(project.id, { result, aiOutput: demoAiOutput(project.id, result) });
  }
  return map;
}

function demoSourceResults(projectId: string, data: StandardProjectData): ProjectSourceReadResult<unknown>[] {
  const base = success(baseContext(projectId), safeBaseSnapshot(data));
  if (projectId === "demo-brand") return [
    base,
    success(context(projectId, "demo-brand-docs", "feishu-docs"), docsSnapshot("demo-brand-doc", "品牌焕新视觉规范 V2", "主视觉延展规则已定稿，渠道适配清单见附表。")),
  ];
  if (projectId === "demo-growth") return [
    base,
    success(context(projectId, "demo-growth-chat", "feishu-chat"), chatSnapshot("demo-growth-chat", [
      ["g-msg-1", "如果素材本周能定稿，投放排期可能提前两天。"],
      ["g-msg-2", "素材还在改，预计明天给初版。"],
    ])),
    success(context(projectId, "demo-growth-calendar", "feishu-calendar"), calendarSnapshot()),
  ];
  if (projectId === "demo-content") return [
    base,
    success(context(projectId, "demo-content-chat", "feishu-chat"), chatSnapshot("demo-content-chat", [
      ["c-msg-1", "算法接口那边争取下周给到，我们先按现状排。"],
      ["c-msg-2", "迁移演练的审批还在等安全团队回复。"],
    ])),
    success(context(projectId, "demo-content-minutes", "feishu-minutes"), minutesSnapshot("demo-content-minutes", "重构周会纪要", "会上确认：搜索服务重构依赖算法侧接口，当前暂停；数据迁移演练等待权限审批。行动项：林晓跟进审批，陈默整理接口依赖清单。")),
    success(context(projectId, "demo-content-docs", "feishu-docs"), docsSnapshot("demo-content-doc", "内容平台重构技术方案", "检索链路改造采用双写过渡方案，切换窗口与回滚条件见方案附录。")),
    success(context(projectId, "demo-content-wiki", "feishu-wiki-drive"), wikiSnapshot("demo-content-wiki", "内容平台重构知识库")),
    success(context(projectId, "demo-content-task", "feishu-task"), taskSnapshot("content-1", dateAt(3))),
    success(context(projectId, "demo-content-calendar", "feishu-calendar"), calendarSnapshot("demo-content-calendar", "content-event-1", "迁移演练窗口评审会")),
  ];
  if (projectId === "demo-explore") return [
    base,
    success(context(projectId, "demo-explore-wiki", "feishu-wiki-drive"), wikiSnapshot()),
    success(context(projectId, "demo-explore-task", "feishu-task"), taskSnapshot("explore-2", dateAt(4))),
  ];
  return [
    base,
    success(context(projectId, "demo-recruit-chat", "feishu-chat"), chatSnapshot("demo-recruit-chat", [
      ["r-msg-1", "第二批候选人面试安排计划调整到下周。"],
      ["r-msg-2", "标注外包还在报价，准确率优化先等数据。"],
    ])),
    success(context(projectId, "demo-recruit-minutes", "feishu-minutes"), minutesSnapshot("demo-recruit-minutes", "招聘算法双周会纪要", "双周会确认：简历解析准确率未达标，需补充标注数据；评测通过标准尚未定义。行动项：林晓定义评测标准，周奕联系标注供应商。")),
    success(context(projectId, "demo-recruit-docs", "feishu-docs"), docsSnapshot("demo-recruit-doc", "智能招聘助手评测方案（草稿）", "评测指标草案包含解析准确率与匹配满意度，通过标准待评审。")),
  ];
}

function baseContext(projectId: string): ProjectSourceReadContext {
  return context(projectId, projectId + "-base", "feishu-base");
}

function context(projectId: string, sourceRef: string, sourceKind: ProjectSourceReadContext["sourceKind"]): ProjectSourceReadContext {
  return {
    projectId,
    sourceRef,
    sourceKind,
    subject: { userId: DEMO_USER_ID },
    authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" },
    visibility: "allowed",
  };
}

function success<T>(readContext: ProjectSourceReadContext, data: T) {
  return createSourceReadSuccess({
    context: readContext,
    data,
    resources: [{ sourceRef: readContext.sourceRef, resourceType: readContext.sourceKind }],
    freshness: { fetchedAt: isoAt(0), sourceUpdatedAt: isoAt(0) },
  });
}

function safeBaseSnapshot(data: StandardProjectData): FeishuBaseSourceSnapshot {
  const { baseToken: _baseToken, ...metadata } = data.metadata;
  return { project: { ...data.project }, tasks: structuredClone(data.tasks), metadata };
}

function taskSnapshot(taskId: string, due: string): FeishuTaskSourceSnapshot {
  return { locator: { taskIds: [taskId] }, tasks: [{ taskId, title: "用户访谈", due: { time: due, timezone: "Asia/Shanghai", isAllDay: true }, collaborators: [], followers: [] }] };
}

function chatSnapshot(containerId: string, messages: Array<[string, string]>): FeishuChatSourceSnapshot {
  return { locator: { containerType: "chat", containerId }, messages: messages.map(([messageId, content], index) => ({ messageId, content, createTime: isoAt(0, 8, 30 + index), messageType: "text" })) };
}

function minutesSnapshot(minuteToken: string, title: string, content: string): FeishuMinutesSourceSnapshot {
  return { locator: { minuteToken }, metadata: { minuteToken, title }, transcript: { kind: "raw-transcript", state: "available", content }, artifacts: [], meetingRelation: { state: "unknown" } };
}

function docsSnapshot(documentToken: string, title: string, text: string): FeishuDocsSourceSnapshot {
  return { locator: { documentToken }, document: { documentToken, title, revisionId: 2 }, blocks: [{ blockId: documentToken + "-block-1", text }] };
}

function wikiSnapshot(token = "demo-explore-wiki", title = "新产品探索知识库"): FeishuWikiDriveSourceSnapshot {
  return { locator: { kind: "wiki-node", nodeToken: token }, object: { token, type: "wiki-node", title, updateTime: isoAt(-1) } };
}

function calendarSnapshot(calendarId = "demo-growth-calendar", eventId = "growth-event-1", title = "投放预算评审会"): FeishuCalendarSourceSnapshot {
  return {
    locator: { calendarId, eventIds: [eventId] },
    events: [{ eventId, title, startTime: { date: dateAt(2).slice(0, 10) }, endTime: { date: dateAt(2).slice(0, 10) }, attendees: [] }],
    syncToken: { state: "not-requested" },
  };
}

function demoAiOutput(projectId: string, result: MultiSourceIntelligenceResult): AiExplanationOutput {
  const limitations: Record<string, string> = {
    "demo-brand": "延期判断基于已确认的计划时间，AI 未修改风险等级。",
    "demo-growth": "群聊中的排期变化仅为待确认信息，未影响健康度。",
    "demo-content": "群聊与妙记内容仅为待确认信息，正式风险以结构化事实为准。",
    "demo-explore": "部分任务信息不足，分析保留信息限制说明。",
    "demo-recruit": "面试安排的口头调整尚未确认，仅作待确认信息展示。",
  };
  return {
    risks: result.risk.analysis.riskSignals.map((risk) => ({ id: risk.signalId, title: "已确认规则风险", evidenceRefs: [risk.signalId], reason: risk.evidence, impact: "可能影响当前交付计划。", suggestedActions: ["优先处理已确认风险。"] })),
    limitations: [limitations[projectId]!],
  };
}

function demoOperationalStates(): Map<string, ProjectSourceOperationalState> {
  const fresh = { freshness: "fresh" as const, lastSuccessfulReadAt: isoAt(0) };
  const values = new Map<string, ProjectSourceOperationalState>();
  for (const project of DEMO_PROJECTS) for (const source of project.sources) values.set(project.id + ":" + source.ref, fresh);
  return values;
}

function locatorFor(kind: Exclude<DemoSourceDef["kind"], "feishu-base">, ref: string) {
  if (kind === "feishu-chat") return { kind, containerType: "chat" as const, containerId: ref };
  if (kind === "feishu-minutes") return { kind, minuteToken: ref };
  if (kind === "feishu-docs") return { kind, documentToken: ref };
  if (kind === "feishu-task") return { kind, taskIds: [ref] };
  if (kind === "feishu-wiki-drive") return { kind, resourceKind: "wiki-node" as const, token: ref };
  return { kind, calendarId: ref, eventIds: [ref + "-event"] };
}

function projectData(id: string, name: string, tasks: StandardTask[]): StandardProjectData {
  return {
    project: { id, name, source: "feishu-base" },
    tasks,
    metadata: { baseToken: id + "-base-token", tableCount: 1, recordCount: tasks.length, retrievedAt: isoAt(0), accessMode: "read-only", tables: [{ id: id + "-table", name: "项目任务", recordCount: tasks.length }] },
  };
}

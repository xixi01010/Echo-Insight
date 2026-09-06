import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatProductDateTime,
  formatFactDisplay,
  formatFactSubject,
  formatSourceDisplayName,
  getHealthDisplay,
  getSourceBadge,
  getSourceDataState,
  getSourceLabel,
  toProductLanguage,
  translateCandidateKind,
} from "../frontend/src/features/product-language/presentation.js";
import { sanitizeUserFacingText } from "../frontend/src/features/project-report/presentation.js";

test("product language presents all V3 source types in Chinese", () => {
  assert.equal(getSourceLabel("feishu-base"), "多维表格");
  assert.equal(getSourceLabel("feishu-chat"), "群聊");
  assert.equal(getSourceLabel("feishu-task"), "任务");
  assert.equal(getSourceLabel("feishu-calendar"), "日历/日程");
  assert.equal(getSourceBadge("feishu-wiki-drive"), "知");
  assert.equal(getSourceDataState("fresh"), "已更新");
  assert.equal(formatSourceDisplayName("feishu-chat", "飞书群聊 / Thread"), "飞书群聊");
  assert.equal(formatSourceDisplayName("feishu-wiki-drive", "飞书知识库 / 云盘"), "飞书知识库/云盘");
});

test("product formatter removes raw timestamp and candidate engineering language", () => {
  assert.match(formatProductDateTime("1788451200000"), /月/);
  assert.doesNotMatch(formatProductDateTime("1788451200000"), /^1788451200000$/);
  assert.equal(translateCandidateKind("proposal"), "待确认提议");
  assert.equal(toProductLanguage("proposal from Base Task Calendar"), "待确认提议 from 多维表格 任务 日历/日程");
  const sanitizedAiCopy = sanitizeUserFacingText(
    "prediction / pending-confirmation from Chat Minutes Docs Wiki/Drive Thread at 1788451200000",
  );
  assert.match(sanitizedAiCopy, /待确认判断 \/ 待确认信息 from 群聊 妙记 文档 知识库\/云盘 会话 at 9月4日 00:00/);
  assert.doesNotMatch(sanitizedAiCopy, /prediction|pending-confirmation|Chat|Minutes|Docs|Wiki|Drive|Thread|1788451200000/);
  assert.match(formatFactDisplay("计划交付", "1788451200000"), /2026年/);
  assert.doesNotMatch(formatFactDisplay("计划交付", "1788451200000"), /1788451200000/);
  assert.equal(formatFactDisplay("推进情况", "in-progress"), "进行中");
  assert.equal(formatFactSubject("task:c-1:task-deadline"), "任务截止时间");
  assert.equal(formatFactSubject("task:c-1:task-status"), "任务状态");
  assert.equal(formatFactSubject("private:opaque-resource-id"), "项目已确认信息");
});

test("health color semantics are derived from the single scorer status", () => {
  assert.equal(getHealthDisplay("healthy").tone, "stable");
  assert.equal(getHealthDisplay("needs-attention").tone, "watch");
  assert.equal(getHealthDisplay("at-risk").tone, "risk");
});

test("product pages keep source configuration, risks, and AI report responsibilities separate", async () => {
  const root = new URL("../frontend/src/pages/", import.meta.url);
  const [sources, risks, report, intelligence, insights, dashboard] = await Promise.all([
    readFile(new URL("Project/ProjectDataSourcePanel.tsx", root), "utf8"),
    readFile(new URL("RiskCenter/RiskCenterPage.tsx", root), "utf8"),
    readFile(new URL("AIReport/AIReportPage.tsx", root), "utf8"),
    readFile(new URL("Project/ProjectIntelligencePanel.tsx", root), "utf8"),
    readFile(new URL("Insights/InsightsPage.tsx", root), "utf8"),
    readFile(new URL("Dashboard/DashboardPage.tsx", root), "utf8"),
  ]);
  assert.match(sources, /暂停使用/);
  assert.match(sources, /移除后，该来源将停止参与项目分析/);
  assert.match(sources, /<CustomSelect/);
  assert.match(risks, /查看详情/);
  assert.match(risks, /待确认信号/);
  assert.match(risks, /toProductLanguage\(signal\.summary\)/);
  assert.match(report, /项目级综合判断/);
  assert.match(report, /AI 分析说明/);
  assert.match(report, /report\.aiReport\.limitations\.map\(sanitizeUserFacingText\)/);
  assert.match(intelligence, /查看数据状态与说明/);
  assert.match(intelligence, /项目信息/);
  assert.doesNotMatch(intelligence, />项目洞察</);
  assert.doesNotMatch(intelligence, /Project Intelligence/);
  assert.match(insights, /sanitizeUserFacingText\(synthesis\.summary\)/);
  assert.match(insights, /synthesis\.limitations\.map\(sanitizeUserFacingText\)/);
  assert.match(dashboard, /sanitizeUserFacingText\(report\.aiReport\.limitations\[0\]\)/);
});

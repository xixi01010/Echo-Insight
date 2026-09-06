export interface V3ReviewProjectFixture {
  id: string;
  name: string;
  role: "healthy" | "confirmed-risk" | "candidate" | "conflict" | "source-limitation";
  sourceTypes: string[];
  expected: string[];
}

/** Minimal deterministic review entry points; these are not claims about real Feishu tenant data. */
export const V3_REVIEW_PROJECTS: V3ReviewProjectFixture[] = [
  { id: "review-a", name: "Project A｜健康项目", role: "healthy", sourceTypes: ["feishu-base"], expected: ["结构化来源一致", "无严重风险", "保持 V2 Base-only 体验"] },
  { id: "review-b", name: "Project B｜明确风险", role: "confirmed-risk", sourceTypes: ["feishu-base", "feishu-task"], expected: ["overdue / blocked 为已确认风险", "保持既有风险等级"] },
  { id: "review-c", name: "Project C｜自然语言潜在风险", role: "candidate", sourceTypes: ["feishu-base", "feishu-chat", "feishu-minutes"], expected: ["延期预测显示为待确认", "不进入 Health Score"] },
  { id: "review-d", name: "Project D｜来源冲突", role: "conflict", sourceTypes: ["feishu-base", "feishu-task", "feishu-minutes"], expected: ["冲突保持 unresolved", "不自动选择来源"] },
  { id: "review-e", name: "Project E｜Source Failure / Permission", role: "source-limitation", sourceTypes: ["feishu-base", "feishu-docs"], expected: ["stale / failure 可见", "Member 不获得无权限内容"] },
];

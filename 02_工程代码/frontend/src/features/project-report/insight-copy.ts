type InsightStatus = "empty" | "loading" | "success" | "error" | "refreshing";

export interface InsightActionCopy {
  label: string;
  title: string;
  description: string;
}

export function getInsightActionCopy(hasReport: boolean, status: InsightStatus): InsightActionCopy {
  const pending = status === "loading" || status === "refreshing";

  if (!hasReport) {
    return {
      label: pending ? "正在生成首次分析" : "生成首次分析",
      title: pending
        ? "正在生成项目分析"
        : status === "error"
          ? "首次分析暂时未生成"
          : "开始建立项目回响",
      description: pending
        ? "正在读取已授权的飞书项目数据，并整理健康情况、风险信号、AI 解释与行动建议。"
        : "生成后可查看项目健康情况、风险信号、AI 解释与行动建议。全程只读，不修改项目事实。",
    };
  }

  return {
    label: pending ? "正在刷新项目分析" : "刷新项目分析",
    title: "刷新当前分析",
    description: "重新读取已授权的飞书项目数据，并更新当前风险与 AI 解释。",
  };
}

export function getInsightErrorMessage(error: unknown): string {
  return error instanceof TypeError
    ? "当前无法连接项目分析服务，请检查服务状态后重试。"
    : "生成分析失败，请稍后重试。";
}

import type {
  AiAnalysisOutput,
  AiProjectInput,
  AiRiskOutput,
  RiskAnalyzer,
  RiskLevel,
} from "./types.js";

/**
 * Deterministic local implementation for contract and UI development.
 * It does not call a model and does not recalculate the health score.
 */
export class MockRiskAnalyzer implements RiskAnalyzer {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async analyze(input: AiProjectInput): Promise<AiAnalysisOutput> {
    validateInput(input);

    const risks = input.riskSignals.map((signal, index) =>
      toRiskOutput(signal, index),
    );
    const riskLevel = input.project.riskLevel ?? highestRiskLevel(risks);

    return {
      projectHealth: {
        score: input.project.healthScore,
        status: input.project.healthStatus,
        riskLevel,
      },
      risks,
      analysis: {
        mode: input.project.sensitivityMode,
        explanation:
          risks.length > 0
            ? "已根据输入的规则风险信号生成结构化观察结果，健康分数沿用规则计算结果。"
            : "当前输入未包含风险信号，健康分数沿用规则计算结果。",
        limitations: ["Mock Analyzer 未调用 AI 模型，建议行动需要项目负责人确认。"],
      },
      generatedAt: this.now().toISOString(),
    };
  }
}

function toRiskOutput(
  signal: AiProjectInput["riskSignals"][number],
  index: number,
): AiRiskOutput {
  const taskIds = signal.taskId ? [signal.taskId] : [];

  return {
    id: `mock-risk-${index + 1}`,
    level: signal.level,
    title: `风险信号：${signal.code}`,
    taskIds,
    reason: signal.evidence,
    impact: "影响范围需要结合关联任务和项目依赖进一步确认。",
    evidence: [signal.evidence],
    suggestedActions: ["由项目负责人确认风险并决定后续行动。"],
  };
}

function highestRiskLevel(risks: AiRiskOutput[]): RiskLevel {
  if (risks.length === 0) return "L1";
  return risks.reduce<RiskLevel>(
    (highest, risk) =>
      riskLevelRank(risk.level) > riskLevelRank(highest) ? risk.level : highest,
    "L1",
  );
}

function riskLevelRank(level: RiskLevel): number {
  return Number(level.slice(1));
}

function validateInput(input: AiProjectInput): void {
  if (!input.project.id.trim() || !input.project.name.trim()) {
    throw new Error("AI input project id and name are required.");
  }
  if (input.project.healthScore < 0 || input.project.healthScore > 100) {
    throw new Error("AI input healthScore must be between 0 and 100.");
  }
  if (input.metadata.accessMode !== "read-only") {
    throw new Error("AI Service only accepts read-only project data.");
  }
}

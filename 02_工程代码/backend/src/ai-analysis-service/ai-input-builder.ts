import type { AiExplanationInput } from "../../../ai-service/src/index.js";
import type { ProjectAnalysisResult } from "../analysis-service/index.js";
import type { RiskContext } from "./risk-context-types.js";

const EMPTY_RISK_CONTEXT_LIMITATION =
  "当前规则分析未提供可供 AI 解释的风险上下文。";

/**
 * Copies only the authorized Risk Context contract into the AI input boundary.
 */
export function buildAiExplanationInput(
  result: ProjectAnalysisResult,
  riskContexts: RiskContext[],
): AiExplanationInput {
  return {
    projectName: result.projectData.project.name,
    riskSignals: riskContexts.map((context) => ({
      signalId: context.signalId,
      type: context.type,
    })),
    riskContexts: riskContexts.map((context) => ({
      signalId: context.signalId,
      type: context.type,
      primaryTask: context.primaryTask
        ? {
            name: context.primaryTask.name,
            status: context.primaryTask.status,
            deadline: context.primaryTask.deadline,
            ...(context.primaryTask.owner
              ? { owner: context.primaryTask.owner }
              : {}),
            ...(context.primaryTask.description
              ? { description: context.primaryTask.description }
              : {}),
          }
        : null,
      relatedTasks: context.relatedTasks.map((task) => ({
        name: task.name,
        status: task.status,
        ...(task.deadline ? { deadline: task.deadline } : {}),
      })),
      factualEvidence: [...context.factualEvidence],
      dataLimitations: [...context.dataLimitations],
    })),
    limitations:
      riskContexts.length === 0 ? [EMPTY_RISK_CONTEXT_LIMITATION] : [],
  };
}

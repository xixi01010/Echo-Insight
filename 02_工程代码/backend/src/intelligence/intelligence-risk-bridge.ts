import { evaluateProjectHealth, type RiskEngineInput, type RiskEngineOutput } from "../risk-engine/index.js";
import { toRiskEngineInput } from "../analysis-service/index.js";
import type { StandardProjectData } from "../../../feishu-connector/src/index.js";
import type { ProjectIntelligenceSnapshot } from "./project-intelligence/index.js";
import type { StructuredTaskFact } from "./source-intelligence-projection.js";

/** Applies only current, admitted structured facts to the existing unmodified V2 rule engine. */
export function evaluateCurrentFactsRisk(input: { baseProjectData: StandardProjectData; intelligence: ProjectIntelligenceSnapshot; now: Date }): { projectData: StandardProjectData; riskInput: RiskEngineInput; analysis: RiskEngineOutput } {
  const projectData = cloneProjectData(input.baseProjectData);
  for (const current of input.intelligence.currentFacts) applyClaim(projectData, current.fact.claim);
  const riskInput = toRiskEngineInput(projectData, input.now);
  return { projectData, riskInput, analysis: evaluateProjectHealth(riskInput, { now: () => input.now }) };
}
function applyClaim(projectData: StandardProjectData, claim: unknown): void {
  if (!isStructuredTaskFact(claim)) return;
  const task = projectData.tasks.find((item) => item.id === claim.taskId);
  if (!task) return;
  if (claim.kind === "task-deadline") task.deadline = claim.value;
  if (claim.kind === "task-status") task.status = claim.value;
  if (claim.kind === "task-completion") task.status = "completed";
}
function isStructuredTaskFact(value: unknown): value is StructuredTaskFact { return typeof value === "object" && value !== null && "kind" in value && "taskId" in value && "value" in value && typeof (value as { kind?: unknown }).kind === "string" && typeof (value as { taskId?: unknown }).taskId === "string" && typeof (value as { value?: unknown }).value === "string"; }
function cloneProjectData(data: StandardProjectData): StandardProjectData { return { ...data, project: { ...data.project }, tasks: data.tasks.map((task) => ({ ...task, attributes: { ...task.attributes } })), metadata: { ...data.metadata, tables: data.metadata.tables.map((table) => ({ ...table })) } }; }

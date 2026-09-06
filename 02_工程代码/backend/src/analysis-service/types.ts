import type {
  RiskEngineOutput,
  RiskEngineTask,
} from "../risk-engine/index.js";
import type { StandardProjectData } from "../../../feishu-connector/src/index.js";

export interface ProjectAnalysisResult {
  projectData: StandardProjectData;
  analysis: RiskEngineOutput;
}

export interface AdaptedRiskEngineInput {
  project: {
    id: string;
    name: string;
    sensitivityMode: "robust";
  };
  tasks: RiskEngineTask[];
  metadata: {
    source: "feishu-base";
    accessMode: "read-only";
    authorizedProjectIds: string[];
    generatedAt: string;
  };
}

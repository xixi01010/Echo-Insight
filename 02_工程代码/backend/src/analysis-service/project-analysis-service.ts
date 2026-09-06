import type {
  ProjectDataReader,
  StandardProjectData,
} from "../../../feishu-connector/src/index.js";
import { evaluateProjectHealth } from "../risk-engine/index.js";
import { toRiskEngineInput } from "./standard-project-adapter.js";
import type { ProjectAnalysisResult } from "./types.js";

export class ProjectAnalysisService {
  constructor(
    private readonly reader: ProjectDataReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async analyzeProject(baseToken: string): Promise<ProjectAnalysisResult> {
    const projectData = await this.reader.readProjectData(baseToken);
    return this.analyzeProjectData(projectData);
  }

  analyzeProjectData(projectData: StandardProjectData): ProjectAnalysisResult {
    const calculatedAt = this.now();
    const riskEngineInput = toRiskEngineInput(projectData, calculatedAt);

    return {
      projectData,
      analysis: evaluateProjectHealth(riskEngineInput, {
        now: () => calculatedAt,
      }),
    };
  }
}

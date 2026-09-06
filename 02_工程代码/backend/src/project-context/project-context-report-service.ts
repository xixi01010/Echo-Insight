import type {
  ProjectReportResult,
  ProjectReportService,
} from "../ai-analysis-service/index.js";
import type { ProjectContextService } from "./project-context-service.js";
import { ProjectDataSourceResolutionError } from "./project-data-source-resolver.js";
import type { ProjectDataSourceSubject } from "./project-data-source-visibility.js";

type ProjectReportGenerator = Pick<ProjectReportService, "createProjectReport">;
type ProjectReportGeneratorResolver = (
  subject: ProjectDataSourceSubject,
) => ProjectReportGenerator;

/** V2-only orchestration; the V1 report route remains wired to its default token. */
export class ProjectContextReportService {
  constructor(
    private readonly contextService: ProjectContextService,
    private readonly reportService: ProjectReportGenerator | ProjectReportGeneratorResolver,
  ) {}

  async createProjectReport(
    projectId: string,
    subject: ProjectDataSourceSubject | string,
  ): Promise<ProjectReportResult> {
    const context = await this.contextService.resolve(projectId, subject);
    const feishuSources = context.resolvedDataSources.filter(
      (source) => source.kind === "feishu-base",
    );

    if (feishuSources.length !== 1) {
      throw new ProjectDataSourceResolutionError(
        "A V2 project report requires exactly one Feishu Base data source.",
      );
    }

    const reportService = typeof this.reportService === "function"
      ? this.reportService(toSubject(subject))
      : this.reportService;
    return reportService.createProjectReport(feishuSources[0]!.baseToken);
  }
}

function toSubject(subject: ProjectDataSourceSubject | string): ProjectDataSourceSubject {
  return typeof subject === "string" ? { userId: subject } : subject;
}

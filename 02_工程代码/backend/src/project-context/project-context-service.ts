import type { ProjectService } from "../project-service/index.js";
import type { ProjectContext } from "./project-context.js";
import type { ProjectDataSourceResolver } from "./project-data-source-resolver.js";
import type { ProjectDataSourceSubject } from "./project-data-source-visibility.js";

export class ProjectContextAccessDeniedError extends Error {
  readonly code = "PROJECT_CONTEXT_ACCESS_DENIED";

  constructor() {
    super("The user cannot access the requested project context.");
    this.name = "ProjectContextAccessDeniedError";
  }
}

export class ProjectContextService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly dataSourceResolver: ProjectDataSourceResolver,
  ) {}

  async resolve(
    projectId: string,
    subject: ProjectDataSourceSubject | string,
  ): Promise<ProjectContext> {
    const currentSubject = typeof subject === "string" ? { userId: subject } : subject;
    const project = await this.projectService.getProject(projectId, currentSubject.userId);
    if (!project) throw new ProjectContextAccessDeniedError();

    const membership = await this.projectService.getMembership(projectId, currentSubject.userId);
    if (!membership) throw new ProjectContextAccessDeniedError();

    return {
      projectId: project.id,
      userId: currentSubject.userId,
      membership,
      projectMetadata: {
        name: project.name,
        creatorId: project.creatorId,
        ownerId: project.ownerId,
        members: [...project.members],
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      resolvedDataSources: this.dataSourceResolver.resolve(project, currentSubject),
    };
  }
}

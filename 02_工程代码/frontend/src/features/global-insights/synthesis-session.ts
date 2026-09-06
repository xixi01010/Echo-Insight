import type {
  GlobalInsightSynthesisResponse,
  GlobalInsightsResponse,
} from "../../services/api/types.js";

interface GlobalInsightClient {
  getInsights: () => Promise<GlobalInsightsResponse>;
  getSynthesis: (
    signal?: AbortSignal,
    forceRefresh?: boolean,
  ) => Promise<GlobalInsightSynthesisResponse>;
}

interface InFlightSynthesis {
  forceRefresh: boolean;
  promise: Promise<GlobalInsightSynthesisResponse>;
}

/** Keeps global insight continuity only for the lifetime of the current web app. */
export class GlobalSynthesisSession {
  private cachedInsights: GlobalInsightsResponse | null = null;
  private cachedSynthesis: GlobalInsightSynthesisResponse | null = null;
  private hasStartedSynthesis = false;
  private insightsInFlight: Promise<GlobalInsightsResponse> | null = null;
  private synthesisInFlight: InFlightSynthesis | null = null;
  private generation = 0;

  read(): GlobalInsightSynthesisResponse | null {
    return this.cachedSynthesis;
  }

  readInsights(): GlobalInsightsResponse | null {
    return this.cachedInsights;
  }

  reset(): void {
    this.generation += 1;
    this.cachedInsights = null;
    this.cachedSynthesis = null;
    this.hasStartedSynthesis = false;
    this.insightsInFlight = null;
    this.synthesisInFlight = null;
  }

  revalidateInsights(client: GlobalInsightClient): Promise<GlobalInsightsResponse> {
    if (this.insightsInFlight) return this.insightsInFlight;

    const generation = this.generation;
    const promise = client.getInsights()
      .then((result) => {
        if (generation !== this.generation) return result;
        const current = this.cachedInsights;
        if (
          current
          && createGlobalInsightsSnapshotFingerprint(current)
            === createGlobalInsightsSnapshotFingerprint(result)
        ) {
          return current;
        }
        this.cachedInsights = result;
        return result;
      })
      .finally(() => {
        if (this.insightsInFlight === promise) this.insightsInFlight = null;
      });
    this.insightsInFlight = promise;
    return promise;
  }

  requestForVisit(client: GlobalInsightClient): Promise<GlobalInsightSynthesisResponse> {
    const forceRefresh = !this.hasStartedSynthesis;
    this.hasStartedSynthesis = true;
    return this.request(client, forceRefresh);
  }

  forceRefresh(client: GlobalInsightClient): Promise<GlobalInsightSynthesisResponse> {
    return this.request(client, true);
  }

  private request(
    client: GlobalInsightClient,
    forceRefresh: boolean,
  ): Promise<GlobalInsightSynthesisResponse> {
    if (this.synthesisInFlight) {
      if (!forceRefresh || this.synthesisInFlight.forceRefresh) {
        return this.synthesisInFlight.promise;
      }
      return this.synthesisInFlight.promise.then(() => this.request(client, true));
    }

    const generation = this.generation;
    const promise = client.getSynthesis(undefined, forceRefresh)
      .then((result) => {
        if (generation === this.generation && result.status !== "unavailable") {
          this.cachedSynthesis = result;
        }
        return result;
      })
      .finally(() => {
        if (this.synthesisInFlight?.promise === promise) this.synthesisInFlight = null;
      });
    this.synthesisInFlight = { forceRefresh, promise };
    return promise;
  }
}

export const globalSynthesisSession = new GlobalSynthesisSession();

export function createGlobalInsightsSnapshotFingerprint(
  result: GlobalInsightsResponse,
): string {
  return JSON.stringify({
    insights: result.insights.map((insight) => ({
      id: insight.id,
      projectId: insight.projectId,
      projectName: insight.projectName,
      currentUserRole: insight.currentUserRole,
      riskLevel: insight.riskLevel,
      title: insight.title,
      facts: [...new Set(insight.facts)].sort((left, right) => left.localeCompare(right, "zh-CN")),
      ruleBasis: insight.ruleBasis,
    })),
    partialFailure: result.partialFailure,
  });
}

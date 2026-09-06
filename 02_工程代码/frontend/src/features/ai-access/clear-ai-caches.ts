import {
  GlobalSynthesisSession,
  globalSynthesisSession,
} from "../global-insights/synthesis-session.js";
import { PROJECT_INTELLIGENCE_CACHE_PREFIX } from "../../services/api/intelligence-cache.js";
import {
  PROJECT_REPORT_CACHE_KEY,
  PROJECT_SCOPED_REPORT_CACHE_PREFIX,
} from "../../services/api/report-cache.js";
import { PROJECT_LIST_CACHE_KEY } from "../../services/api/project-list-cache.js";
import { advanceClientCacheEpoch } from "./client-cache-epoch.js";

interface RemovableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export function clearAiDerivedClientCaches(
  storage: RemovableStorage | undefined,
  synthesisSession: GlobalSynthesisSession = globalSynthesisSession,
): void {
  advanceClientCacheEpoch();
  synthesisSession.reset();
  removeMatchingKeys(storage, (key) => (
    key === PROJECT_REPORT_CACHE_KEY
    || key.startsWith(`${PROJECT_SCOPED_REPORT_CACHE_PREFIX}:`)
    || key.startsWith(`${PROJECT_INTELLIGENCE_CACHE_PREFIX}:`)
  ));
}

export function clearAuthenticatedClientCaches(
  storage: RemovableStorage | undefined,
  synthesisSession: GlobalSynthesisSession = globalSynthesisSession,
): void {
  clearAiDerivedClientCaches(storage, synthesisSession);
  removeMatchingKeys(storage, (key) => key === PROJECT_LIST_CACHE_KEY);
}

function removeMatchingKeys(
  storage: RemovableStorage | undefined,
  matches: (key: string) => boolean,
): void {
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (matches(key)) storage.removeItem(key);
    }
  } catch {
    // Browser privacy modes may deny storage access; the in-memory cache is
    // still reset and the server remains authoritative.
  }
}

import { accessSync, constants, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface RuntimeStoragePaths {
  directory: string;
  projectStorePath: string;
  dataSourceRegistryPath: string;
  visitorAiAccountStorePath: string;
}

export function resolveRuntimeStoragePaths(
  environment: NodeJS.ProcessEnv,
  developmentFallbackDirectory: string,
): RuntimeStoragePaths {
  const directory = readRuntimeDirectory(environment)
    ?? readDevelopmentFallback(environment, developmentFallbackDirectory);

  if (environment.NODE_ENV === "production" && !isAbsolute(directory)) {
    throw new Error("Production runtime directory must be an absolute path.");
  }

  return {
    directory,
    projectStorePath: join(directory, "projects.json"),
    dataSourceRegistryPath: join(directory, "data-sources.json"),
    visitorAiAccountStorePath: join(directory, "visitor-ai-accounts.json"),
  };
}

export function ensureRuntimeStorageDirectory(paths: RuntimeStoragePaths): void {
  mkdirSync(paths.directory, { recursive: true });
  try {
    accessSync(paths.directory, constants.W_OK);
  } catch {
    throw new Error("Runtime storage directory is not writable.");
  }
}

function readRuntimeDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  return readText(environment.ECHO_INSIGHT_RUNTIME_DIR)
    ?? readText(environment.RAILWAY_VOLUME_MOUNT_PATH);
}

function readDevelopmentFallback(
  environment: NodeJS.ProcessEnv,
  developmentFallbackDirectory: string,
): string {
  if (environment.NODE_ENV === "production") {
    throw new Error("Production requires ECHO_INSIGHT_RUNTIME_DIR or RAILWAY_VOLUME_MOUNT_PATH.");
  }
  return developmentFallbackDirectory;
}

function readText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

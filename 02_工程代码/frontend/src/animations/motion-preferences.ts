export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface MotionPreferenceSource {
  matchMedia(query: string): { matches: boolean };
}

function browserMotionPreferenceSource(): MotionPreferenceSource | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function prefersReducedMotion(
  source: MotionPreferenceSource | undefined = browserMotionPreferenceSource(),
): boolean {
  return source?.matchMedia(REDUCED_MOTION_QUERY).matches ?? false;
}

export function motionDuration(
  durationSeconds: number,
  source?: MotionPreferenceSource,
): number {
  return prefersReducedMotion(source) ? 0 : durationSeconds;
}

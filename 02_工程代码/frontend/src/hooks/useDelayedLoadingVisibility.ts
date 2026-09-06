import { useEffect, useRef, useState } from "react";

export const LOADING_REVEAL_DELAY_MS = 160;
export const LOADING_MIN_VISIBLE_MS = 220;

export function useDelayedLoadingVisibility(
  loading: boolean,
  revealDelay = LOADING_REVEAL_DELAY_MS,
  minimumVisible = LOADING_MIN_VISIBLE_MS,
): boolean {
  const [visible, setVisible] = useState(false);
  const visibleSinceRef = useRef<number | null>(null);

  useEffect(() => {
    let timer: number | null = null;

    if (loading && !visible) {
      timer = window.setTimeout(() => {
        visibleSinceRef.current = Date.now();
        setVisible(true);
      }, revealDelay);
    } else if (!loading && visible) {
      const elapsed = Date.now() - (visibleSinceRef.current ?? Date.now());
      timer = window.setTimeout(() => {
        visibleSinceRef.current = null;
        setVisible(false);
      }, Math.max(0, minimumVisible - elapsed));
    } else if (!loading) {
      visibleSinceRef.current = null;
    }

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loading, minimumVisible, revealDelay, visible]);

  return visible;
}

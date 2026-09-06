import { gsap } from "gsap";
import { motionDuration, prefersReducedMotion } from "./motion-preferences.js";

export const PAGE_TRANSITION_DURATION_MS = 200;

export function animatePageEnter(element: HTMLElement | null): () => void {
  if (!element) return () => undefined;

  if (prefersReducedMotion()) {
    gsap.set(element, { autoAlpha: 1, clearProps: "transform" });
    return () => gsap.set(element, { clearProps: "opacity,visibility,transform" });
  }

  const animation = gsap.fromTo(
    element,
    { autoAlpha: 0, y: 8 },
    {
      autoAlpha: 1,
      y: 0,
      duration: motionDuration(PAGE_TRANSITION_DURATION_MS / 1000),
      ease: "power1.out",
    },
  );

  return () => {
    animation.kill();
    gsap.set(element, { clearProps: "opacity,visibility,transform" });
  };
}

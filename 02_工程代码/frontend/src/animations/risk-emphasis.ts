import { gsap } from "gsap";
import { motionDuration, prefersReducedMotion } from "./motion-preferences.js";

const HIGH_RISK_SELECTOR = ".risk-tone--high, .risk-tone--critical";

export function animateHighRiskEmphasis(root: HTMLElement | null): () => void {
  if (!root || prefersReducedMotion()) return () => undefined;

  const highRiskSurfaces = Array.from(
    root.querySelectorAll<HTMLElement>(HIGH_RISK_SELECTOR),
  );
  if (highRiskSurfaces.length === 0) return () => undefined;

  const animation = gsap.fromTo(
    highRiskSurfaces,
    { autoAlpha: 0.88 },
    {
      autoAlpha: 1,
      duration: motionDuration(0.18),
      ease: "power1.out",
      stagger: 0.035,
      clearProps: "opacity,visibility",
    },
  );

  return () => animation.kill();
}

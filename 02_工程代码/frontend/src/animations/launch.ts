import { gsap } from "gsap";
import { prefersReducedMotion } from "./motion-preferences.js";

interface LaunchAnimationOptions {
  screen: HTMLDivElement | null;
  core: HTMLSpanElement | null;
  ring: HTMLDivElement | null;
  wordmark: HTMLDivElement | null;
  firstOpen: boolean;
  onComplete: () => void;
}

export function animateLaunch({ screen, core, ring, wordmark, firstOpen, onComplete }: LaunchAnimationOptions): () => void {
  if (!screen || !core || !ring || !wordmark) return () => undefined;

  const reduceMotion = prefersReducedMotion();
  const duration = reduceMotion ? 0.12 : firstOpen ? 1.5 : 0.4;
  const timeline = gsap.timeline({ onComplete });

  if (firstOpen && !reduceMotion) {
    timeline
      .fromTo(core, { autoAlpha: 0, scale: 0.2 }, { autoAlpha: 1, scale: 1, duration: 0.28, ease: "power2.out" })
      .fromTo(ring, { autoAlpha: 0, clipPath: "circle(8% at 50% 50%)", scale: 0.96 }, { autoAlpha: 1, clipPath: "circle(72% at 50% 50%)", scale: 1, duration: 0.5, ease: "power2.out" }, ">-0.04")
      .fromTo(wordmark, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.28, ease: "power1.out" }, ">-0.08")
      .to(screen, { autoAlpha: 0, duration: 0.4, ease: "power1.inOut" }, ">+0.08");
  } else {
    timeline
      .fromTo([ring, core, wordmark], { autoAlpha: 0 }, { autoAlpha: 1, duration: duration * 0.45, ease: "power1.out" })
      .to(screen, { autoAlpha: 0, duration: duration * 0.55, ease: "power1.out" });
  }

  return () => timeline.kill();
}

import { useLayoutEffect, useRef } from "react";
import { animateLaunch } from "../animations/launch";
import { BrandMark } from "./BrandMark";

interface LaunchScreenProps {
  firstOpen: boolean;
  onComplete: () => void;
}

export function LaunchScreen({ firstOpen, onComplete }: LaunchScreenProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLSpanElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const wordmarkRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const hasSeenLaunch = window.sessionStorage.getItem("echo-insight-launch-seen") === "true";
    const cleanup = animateLaunch({
      screen: screenRef.current,
      core: coreRef.current,
      ring: ringRef.current,
      wordmark: wordmarkRef.current,
      firstOpen: firstOpen && !hasSeenLaunch,
      onComplete: () => {
        window.sessionStorage.setItem("echo-insight-launch-seen", "true");
        onComplete();
      },
    });

    return cleanup;
  }, [firstOpen, onComplete]);

  return (
    <div className="launch-screen" ref={screenRef} role="status" aria-label="正在进入回响">
      <div className="launch-symbol" aria-hidden="true">
        <span className="launch-core" ref={coreRef} />
        <div className="launch-ring" ref={ringRef}>
          <BrandMark size={104} />
        </div>
      </div>
      <div className="launch-wordmark" ref={wordmarkRef}>
        <strong>回响</strong>
        <span>Echo Insight</span>
      </div>
    </div>
  );
}

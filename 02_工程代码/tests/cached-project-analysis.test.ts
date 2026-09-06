import assert from "node:assert/strict";
import test from "node:test";

import { CachedProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import type { ProjectAnalysisResult } from "../backend/src/analysis-service/types.js";

function resultFor(marker: string): ProjectAnalysisResult {
  return { marker } as unknown as ProjectAnalysisResult;
}

class CountingAnalyzer {
  calls = 0;
  handler: (baseToken: string) => Promise<ProjectAnalysisResult> = async (baseToken) => {
    this.calls += 1;
    return resultFor(baseToken + ":" + this.calls);
  };
  async analyzeProject(baseToken: string): Promise<ProjectAnalysisResult> {
    return this.handler(baseToken);
  }
}

test("cached analysis serves concurrent requests from one in-flight analysis", async () => {
  const delegate = new CountingAnalyzer();
  let release: () => void = () => {};
  delegate.handler = (baseToken) => {
    delegate.calls += 1;
    return new Promise<ProjectAnalysisResult>((resolve) => {
      release = () => resolve(resultFor(baseToken));
    });
  };
  const service = new CachedProjectAnalysisService(delegate);

  const first = service.analyzeProject("base-1");
  const second = service.analyzeProject("base-1");
  assert.equal(delegate.calls, 1);
  release();
  assert.equal(await first, await second);
});

test("cached analysis reuses results within TTL and recomputes after expiry", async () => {
  const delegate = new CountingAnalyzer();
  let nowMs = 1_000;
  const service = new CachedProjectAnalysisService(delegate, () => nowMs, 500);

  const first = await service.analyzeProject("base-1");
  nowMs += 400;
  const second = await service.analyzeProject("base-1");
  assert.equal(second, first);
  assert.equal(delegate.calls, 1);

  nowMs += 200;
  const third = await service.analyzeProject("base-1");
  assert.notEqual(third, first);
  assert.equal(delegate.calls, 2);
});

test("cached analysis evicts failed analyses so the next call retries", async () => {
  const delegate = new CountingAnalyzer();
  delegate.handler = async () => {
    delegate.calls += 1;
    throw new Error("feishu unavailable");
  };
  const service = new CachedProjectAnalysisService(delegate);

  await assert.rejects(() => service.analyzeProject("base-1"));
  await assert.rejects(() => service.analyzeProject("base-1"));
  assert.equal(delegate.calls, 2);
});

test("invalidate clears one token or the whole cache", async () => {
  const delegate = new CountingAnalyzer();
  const service = new CachedProjectAnalysisService(delegate);

  await service.analyzeProject("base-1");
  await service.analyzeProject("base-2");
  assert.equal(delegate.calls, 2);

  service.invalidate("base-1");
  await service.analyzeProject("base-1");
  await service.analyzeProject("base-2");
  assert.equal(delegate.calls, 3);

  service.invalidate();
  await service.analyzeProject("base-1");
  assert.equal(delegate.calls, 4);
});
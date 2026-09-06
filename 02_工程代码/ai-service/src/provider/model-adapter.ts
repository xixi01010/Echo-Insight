export interface ModelTestCase {
  name: string;
  filePath: string;
  input: Record<string, unknown>;
}

export interface ModelAdapterRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  testCase: ModelTestCase;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ModelAdapterResult {
  model: string;
  response: unknown;
  latency: number | null;
  tokenUsage: TokenUsage | null;
  timestamp: string;
}

export interface ModelAdapter {
  invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult>;
}

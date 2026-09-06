import { useState, type FormEvent } from "react";

import { CustomSelect } from "../../components/CustomSelect";
import type { VisitorAiProviderId } from "../../services/api/ai-settings";
import { useAiAccess } from "./AiAccessContext";

const providerOptions: Array<{ value: VisitorAiProviderId; label: string }> = [
  { value: "deepseek", label: "DeepSeek 官方" },
  { value: "qwen", label: "千问官方 · qwen3.8-flash" },
];

export function AiConnectionForm({ compact = false }: { compact?: boolean }) {
  const aiAccess = useAiAccess();
  const [providerId, setProviderId] = useState<VisitorAiProviderId>("deepseek");
  const [apiKey, setApiKey] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await aiAccess.connect(providerId, apiKey);
    } finally {
      setApiKey("");
    }
  };

  return (
    <form className={`ai-connection-form ${compact ? "ai-connection-form--compact" : ""}`} onSubmit={(event) => void submit(event)}>
      <label>
        <span>AI 模型平台</span>
        <CustomSelect
          aria-label="AI 模型平台"
          onChange={(value) => setProviderId(value as VisitorAiProviderId)}
          options={providerOptions}
          value={providerId}
        />
      </label>
      <div className="ai-provider-help">
        {providerId === "deepseek" ? (
          <a href="https://platform.deepseek.com/api_keys" rel="noreferrer" target="_blank">前往 DeepSeek 获取 API Key</a>
        ) : (
          <a href="https://platform.qianwenai.com/home" rel="noreferrer" target="_blank">前往千问 AI 平台获取 API Key</a>
        )}
      </div>
      <label>
        <span>API Key</span>
        <input
          autoComplete="new-password"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="仅用于本次连接验证，提交结束后立即清空"
          spellCheck={false}
          type="password"
          value={apiKey}
        />
      </label>
      <p className="ai-cost-note">
        连接验证会产生一次极小调用。连接后，进入已配置项目、首次打开 AI 洞察或主动刷新时可能自动调用模型；费用由模型平台收取。每个登录会话最多每 10 分钟启动 12 次 AI 任务、同时 2 次。
      </p>
      {aiAccess.error ? <p className="inline-alert" role="alert">{aiAccess.error}</p> : null}
      <button className="primary-action" disabled={aiAccess.pending || !apiKey.trim()} type="submit">
        {aiAccess.pending ? "正在安全验证…" : "连接并验证"}
      </button>
    </form>
  );
}

import type { PropsWithChildren } from "react";
import { Link } from "react-router-dom";

import { WorkspacePreview } from "../../app/WorkspacePreview";
import { AiConnectionForm } from "./AiConnectionForm";
import { useAiAccess } from "./AiAccessContext";

export function AiSetupBoundary({ children }: PropsWithChildren) {
  const aiAccess = useAiAccess();

  if (aiAccess.loading) {
    return (
      <main className="identity-entry identity-entry--loading" aria-busy="true">
        <WorkspacePreview />
        <section className="identity-entry-card identity-entry-card--loading">
          <span className="loading-spinner" /><p>正在确认 AI 能力连接方式…</p>
        </section>
      </main>
    );
  }

  if (!aiAccess.status) {
    return (
      <main className="identity-entry">
        <WorkspacePreview />
        <section className="identity-entry-card">
          <p className="eyebrow">Echo Insight</p>
          <h1>暂时无法读取 AI 连接状态</h1>
          <p>{aiAccess.error ?? "请检查服务连接后重试。"}</p>
          <button className="primary-action" onClick={() => void aiAccess.refresh()} type="button">重新检查</button>
        </section>
      </main>
    );
  }

  if (aiAccess.status.mode === "visitor" && aiAccess.status.setupRequired) {
    const accountStorage = aiAccess.status.storage === "server-account-encrypted";
    return (
      <main className="ai-setup-entry">
        <WorkspacePreview />
        <section aria-labelledby="ai-setup-title" aria-modal="true" className="ai-setup-card" role="dialog">
          <p className="eyebrow">首次使用 · 可选步骤</p>
          <h1 id="ai-setup-title">连接你自己的 AI 能力</h1>
          <p>选择模型平台并填入 API Key，Echo Insight 就能生成风险解释与跨项目洞察。</p>
          <ul className="ai-setup-points">
            {accountStorage ? (
              <>
                <li>API Key 在服务端加密保存，并绑定同一 Echo Insight 部署内的当前飞书应用账号。</li>
                <li>同一账号退出后重新登录或换设备会自动恢复；不同飞书账号彼此隔离。</li>
                <li>应用不会把密钥写入浏览器、项目文件或公开仓库；主动断开 AI 连接才会删除已保存密钥。</li>
              </>
            ) : (
              <li>当前服务版本仅在登录 Session 中暂存密钥；完成后端升级前，退出或换设备仍需重新连接。</li>
            )}
            <li>模型调用由第三方平台计费，费用不支付给 Echo Insight。</li>
            <li>连接后，进入已配置项目、首次打开 AI 洞察或主动刷新时可能发起模型调用；服务端会限制账号级频率与并发。</li>
          </ul>
          <AiConnectionForm />
          <Link className="secondary-action ai-demo-action" to="/?mode=demo">
            先查看不登录、不调用模型的虚拟项目演示
          </Link>
          <button className="text-action ai-skip-action" disabled={aiAccess.pending} onClick={() => void aiAccess.skip()} type="button">
            暂不接入，进入我的基础工作区
          </button>
        </section>
      </main>
    );
  }

  return children;
}

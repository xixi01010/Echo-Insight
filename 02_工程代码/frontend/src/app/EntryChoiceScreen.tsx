import React from "react";

import { WorkspacePreview } from "./WorkspacePreview";

interface EntryChoiceScreenProps {
  authenticated: boolean;
  error: string | null;
  loginAvailable: boolean;
  loginLoading: boolean;
  onChooseDemo: () => void;
  onEnterAccount: () => void;
}

export function EntryChoiceScreen({
  authenticated,
  error,
  loginAvailable,
  loginLoading,
  onChooseDemo,
  onEnterAccount,
}: EntryChoiceScreenProps) {
  const loginLabel = authenticated
    ? "进入我的真实工作区"
    : loginLoading
      ? "正在确认飞书登录状态…"
      : loginAvailable
        ? "飞书登录并使用我的项目"
        : "登录服务暂未就绪";
  const loginDescription = authenticated
    ? "继续使用当前已登录账号，只查看你有权访问的项目。"
    : "通过飞书登录，并在授权范围内查看和分析你自己的项目。";

  return (
    <main className="identity-entry">
      <WorkspacePreview />
      <section
        aria-describedby="entry-choice-description"
        aria-labelledby="entry-choice-title"
        aria-modal="true"
        className="identity-entry-card entry-choice-card"
        role="dialog"
      >
        <p className="eyebrow">开始使用 Echo Insight</p>
        <h1 id="entry-choice-title">选择你的体验方式</h1>
        <p id="entry-choice-description">先浏览完整产品演示，或登录飞书进入只属于你的真实工作区。</p>
        <div className="entry-choice-options">
          <button className="primary-action entry-choice-option" onClick={onChooseDemo} type="button">
            <strong>进入完整演示账号</strong>
            <span>无需登录 · 5 个合成项目 · 不调用外部模型</span>
          </button>
          <button
            aria-busy={loginLoading || undefined}
            className="secondary-action entry-choice-option"
            disabled={loginLoading || !loginAvailable}
            onClick={onEnterAccount}
            type="button"
          >
            <strong>{loginLabel}</strong>
            <span>{loginDescription}</span>
          </button>
        </div>
        {error ? <p className="identity-entry-error" role="alert">{error}</p> : null}
        <small>演示账号与真实工作区彼此隔离，之后仍可随时切换。</small>
      </section>
    </main>
  );
}

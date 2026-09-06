import type { ProjectReportStatus } from "../../features/project-report/useProjectReport";
import { CustomSelect } from "../../components/CustomSelect";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useAuth } from "../../features/auth/AuthContext";
import { AiConnectionForm } from "../../features/ai-access/AiConnectionForm";
import { useAiAccess } from "../../features/ai-access/AiAccessContext";
import {
  usePreferences,
  type AccentTone,
  type AppearanceMode,
} from "../../features/preferences/PreferenceContext";

interface SettingsPageProps { status: ProjectReportStatus }

const statusCopy: Record<ProjectReportStatus, string> = {
  empty: "等待首次分析",
  loading: "正在生成首次分析",
  refreshing: "正在刷新项目分析",
  success: "最近一次分析已生成",
  error: "最近一次更新未完成",
};

const appearanceOptions: Array<{ value: AppearanceMode; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const accentOptions: Array<{ value: AccentTone; label: string }> = [
  { value: "echo", label: "回响蓝" },
  { value: "indigo", label: "靛青" },
  { value: "cyan", label: "青色" },
  { value: "purple", label: "紫色" },
  { value: "green", label: "绿色" },
];

export function SettingsPage({ status }: SettingsPageProps) {
  const { logout, status: authStatus } = useAuth();
  const aiAccess = useAiAccess();
  const preferences = usePreferences();
  const user = authStatus?.user;
  const displayName = user?.displayName?.trim() || "飞书用户";

  return (
    <div className="settings-page">
      <header className="settings-heading"><p className="section-kicker">个人偏好</p><h1>设置</h1><p>管理 AI 能力连接、显示方式与使用偏好。</p></header>
      <nav className="settings-nav" aria-label="设置分类">
        <a href="#profile">用户信息</a><a href="#ai">AI 能力</a><a href="#home">首页设置</a><a href="#preferences">偏好设置</a><a href="#general">通用设置</a>
      </nav>

      <section className="settings-section" id="profile">
        <header><div><h2>用户信息</h2><p>当前登录账号与项目身份来源。</p></div></header>
        <div className="settings-profile">
          <div className="user-avatar user-avatar--large">{user?.avatarUrl ? <img alt="" src={user.avatarUrl} /> : displayName.slice(0, 1)}</div>
          <div><strong>{displayName}</strong><p>已通过飞书安全登录</p></div>
          <button className="secondary-action" onClick={() => void logout()} type="button">退出登录</button>
        </div>
      </section>

      <section className="settings-section" id="ai">
        <header>
          <div><h2>AI 能力</h2><p>连接模型平台，用于风险解释与跨项目洞察。</p></div>
          <span className="local-preference-badge">
            {aiAccess.status?.configured ? "已连接" : "未连接"}
          </span>
        </header>
        {aiAccess.loading ? <p className="settings-inline-state">正在读取 AI 连接状态…</p> : null}
        {aiAccess.status?.mode === "server" ? (
          <>
            <SettingRow description="自托管版本通过服务端 .env 管理模型配置。" label="连接方式">
              <span className="setting-value">部署环境托管</span>
            </SettingRow>
            <SettingRow description="如需更换，请重新运行根目录安装向导或安全更新服务端 .env。" label="当前模型">
              <span className="setting-value">
                {aiAccess.status.configured
                  ? `${aiAccess.status.providerName ?? "AI Provider"} · ${aiAccess.status.model ?? "默认模型"}`
                  : "尚未完成配置"}
              </span>
            </SettingRow>
            <div className="security-note"><strong>自托管密钥边界</strong><p>密钥只应保存在部署端的真实 .env 中，不要粘贴到前端、README、Issue 或提交记录。</p></div>
          </>
        ) : null}
        {aiAccess.status?.mode === "visitor" ? (
          <div className="ai-settings-content">
            {aiAccess.status.configured ? (
              <>
                <SettingRow description={aiAccess.status.storage === "server-account-encrypted"
                  ? "API Key 已按当前飞书应用账号在服务端加密保存；同一部署中退出后重登或换设备会自动恢复，切换账号不会串用。"
                  : "当前服务版本仅在本次飞书登录 Session 中暂存密钥；退出或换设备后需要重新连接。"} label="当前连接">
                  <span className="setting-value">{aiAccess.status.providerName} · {aiAccess.status.model}</span>
                </SettingRow>
                <button className="secondary-action" disabled={aiAccess.pending} onClick={() => void aiAccess.disconnect()} type="button">
                  {aiAccess.status.storage === "server-account-encrypted" ? "断开并删除已保存的 API Key" : "断开当前 AI 连接"}
                </button>
                <h3>更换模型平台或 API Key</h3>
              </>
            ) : <p className="settings-inline-state">当前只运行确定性规则分析，不会调用部署者或第三方模型。</p>}
            <AiConnectionForm compact />
            <p className="ai-advanced-note">在线版仅开放 DeepSeek 与千问官方预设；任意 OpenAI-compatible Endpoint 仅在自托管安装向导中提供。</p>
          </div>
        ) : null}
      </section>

      <section className="settings-section" id="home">
        <header><div><h2>首页设置</h2><p>控制项目卡片与风险提示的展示方式。</p></div><span className="local-preference-badge">保存在当前设备</span></header>
        <SettingRow description="决定项目卡片在首页的排列方式。" label="项目排序">
          <CustomSelect aria-label="项目排序" onChange={(value) => preferences.updatePreference("projectSort", value)} options={[{ value: "updated", label: "最近更新优先" }, { value: "name", label: "按名称排列" }]} value={preferences.projectSort} />
        </SettingRow>
        <SettingRow description="健康总览、重点关注与项目区域使用系统标准布局。" label="默认布局"><span className="setting-value">标准布局</span></SettingRow>
        <SettingRow description="项目排序、风险提示和显示密度会自动保存在当前设备。" label="已保存布局"><span className="setting-value">本机自动保存</span></SettingRow>
        <SettingRow description="在项目卡片上显示已确认的风险数量。" label="风险提示">
          <label className="switch-control"><input checked={preferences.showRiskBadges} onChange={(event) => preferences.updatePreference("showRiskBadges", event.target.checked)} type="checkbox" /><span /></label>
        </SettingRow>
      </section>

      <section className="settings-section" id="preferences">
        <header><div><h2>偏好设置</h2><p>选择主题、强调色与内容呈现方式。</p></div><span className="local-preference-badge">保存在当前设备</span></header>
        <SettingRow description="浅色为默认模式，也可跟随设备设置。" label="外观">
          <SegmentedControl aria-label="外观模式" onChange={(value) => preferences.updatePreference("appearance", value)} options={appearanceOptions} value={preferences.appearance} />
        </SettingRow>
        <SettingRow description="用于导航、高亮与主要操作。" label="强调色">
          <div className="accent-picker">{accentOptions.map((option) => <button aria-label={option.label} aria-pressed={preferences.accent === option.value} className={`accent-swatch accent-swatch--${option.value} ${preferences.accent === option.value ? "is-active" : ""}`} key={option.value} onClick={() => preferences.updatePreference("accent", option.value)} title={option.label} type="button" />)}</div>
        </SettingRow>
        <SettingRow description="调整页面中卡片和列表的间距。" label="内容密度">
          <CustomSelect aria-label="内容密度" onChange={(value) => preferences.updatePreference("density", value)} options={[{ value: "comfortable", label: "舒适" }, { value: "compact", label: "紧凑" }]} value={preferences.density} />
        </SettingRow>
        <SettingRow description="记录你偏好的表达详略；当前设置仅保存在本机，不改变风险事实。" label="洞察表达">
          <CustomSelect aria-label="洞察表达" onChange={(value) => preferences.updatePreference("aiOutputStyle", value)} options={[{ value: "concise", label: "精简" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} value={preferences.aiOutputStyle} />
        </SettingRow>
      </section>

      <section className="settings-section" id="general">
        <header><div><h2>通用设置</h2><p>查看数据读取状态与安全说明。</p></div></header>
        <SettingRow description="Echo Insight 只读取已授权的项目数据。" label="数据来源"><span className="setting-value">飞书多维表格 · 只读</span></SettingRow>
        <SettingRow description="最近一次项目分析处理状态。" label="分析状态"><span className="setting-value">{statusCopy[status]}</span></SettingRow>
        <div className="security-note"><strong>数据安全保障声明</strong><p>Echo Insight 只读取已授权的项目数据，不会修改飞书中的任务、负责人、截止日期或其他项目内容。</p></div>
        <button className="text-action" onClick={preferences.resetPreferences} type="button">恢复本机默认显示设置</button>
      </section>
    </div>
  );
}

function SettingRow({ children, description, label }: { children: React.ReactNode; description: string; label: string }) {
  return <div className="setting-row"><div><strong>{label}</strong><p>{description}</p></div><div className="setting-row__control">{children}</div></div>;
}

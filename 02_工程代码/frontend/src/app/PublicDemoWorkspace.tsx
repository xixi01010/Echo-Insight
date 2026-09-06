import { useState } from "react";

import { AppIcon, type AppIconName } from "../components/AppIcon";
import { BrandMark } from "../components/BrandMark";

type DemoView = "overview" | "project" | "insights" | "sources";
type DemoTone = "healthy" | "attention" | "critical";

interface DemoProject {
  id: string;
  name: string;
  score: number;
  riskCount: number;
  tone: DemoTone;
  focus: string;
  fact: string;
  explanation: string;
}

const DEMO_PROJECTS: DemoProject[] = [
  {
    id: "demo-brand",
    name: "【演示】品牌焕新计划",
    score: 85,
    riskCount: 1,
    tone: "healthy",
    focus: "渠道反馈收集存在轻微延期",
    fact: "首批渠道反馈仍在回收，计划较原排期延后一天。",
    explanation: "当前延期范围有限，建议负责人确认剩余渠道的回收时间后再更新后续计划。",
  },
  {
    id: "demo-growth",
    name: "【演示】秋季增长活动",
    score: 60,
    riskCount: 2,
    tone: "attention",
    focus: "投放排期等待预算评审",
    fact: "广告素材仍在制作，最终投放排期尚未锁定。",
    explanation: "预算结论与素材交付共同影响投放窗口，应先确认两个依赖项的完成时间。",
  },
  {
    id: "demo-content",
    name: "【演示】内容平台重构",
    score: 0,
    riskCount: 6,
    tone: "critical",
    focus: "搜索服务重构等待依赖接口",
    fact: "搜索服务任务已逾期，且依赖的算法侧接口尚未提供。",
    explanation: "该阻塞已影响后续迁移计划，建议负责人明确接口交付人、时间和替代方案。",
  },
  {
    id: "demo-explore",
    name: "【演示】新产品探索",
    score: 40,
    riskCount: 4,
    tone: "critical",
    focus: "用户访谈样本覆盖不足",
    fact: "第一轮访谈已完成四场，但目标用户样本仍不完整。",
    explanation: "建议先补齐关键用户类型，再判断核心价值假设是否进入下一轮验证。",
  },
  {
    id: "demo-recruit",
    name: "【演示】智能招聘助手",
    score: 10,
    riskCount: 5,
    tone: "critical",
    focus: "简历解析准确率未达标",
    fact: "评测标准尚未确认，标注数据也未补齐。",
    explanation: "在标准和数据补齐前，不应把当前模型结果解释为能力已经通过验证。",
  },
];

const DEMO_SOURCES = [
  ["多维表格", "结构化任务与截止时间"],
  ["群聊", "项目讨论与待确认信号"],
  ["妙记", "会议结论与行动项"],
  ["文档", "方案、规范与决策记录"],
  ["知识库 / 云盘", "项目资料与索引"],
  ["任务", "负责人、状态与截止时间"],
  ["日历", "里程碑与关键会议"],
] as const;

const DEMO_NAVIGATION: { icon: AppIconName; label: string; view: DemoView }[] = [
  { icon: "home", label: "总览", view: "overview" },
  { icon: "projects", label: "项目", view: "project" },
  { icon: "insights", label: "AI 洞察", view: "insights" },
  { icon: "settings", label: "数据来源", view: "sources" },
];

export interface PublicDemoWorkspaceProps {
  authenticated: boolean;
  loginEnabled: boolean;
  loginError?: string | null;
  onEnterWorkspace: () => void;
}

export function PublicDemoWorkspace({
  authenticated,
  loginEnabled,
  loginError,
  onEnterWorkspace,
}: PublicDemoWorkspaceProps) {
  const [view, setView] = useState<DemoView>("overview");
  const [selectedProjectId, setSelectedProjectId] = useState(DEMO_PROJECTS[0]!.id);
  const selectedProject = DEMO_PROJECTS.find((project) => project.id === selectedProjectId)
    ?? DEMO_PROJECTS[0]!;

  const openProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setView("project");
  };

  return (
    <div className="public-demo-shell">
      <aside className="public-demo-sidebar">
        <div className="public-demo-brand"><BrandMark appIconVariant size={38} /><div><strong>回响</strong><span>Echo Insight</span></div></div>
        <p className="public-demo-sidebar__mode">公开演示</p>
        <nav aria-label="演示导航" className="public-demo-navigation">
          {DEMO_NAVIGATION.map((item) => (
            <button
              aria-pressed={view === item.view}
              className={view === item.view ? "is-active" : ""}
              key={item.view}
              onClick={() => setView(item.view)}
              type="button"
            >
              <AppIcon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <small>虚拟数据 · 无模型调用</small>
      </aside>

      <main className="public-demo-main">
        <header className="public-demo-topbar">
          <div><span className="public-demo-pill">无需登录</span><span>介绍片同款虚拟项目</span></div>
          <button
            className="primary-action"
            disabled={!authenticated && !loginEnabled}
            onClick={onEnterWorkspace}
            type="button"
          >
            {authenticated ? "返回我的真实项目" : "登录并查看我的真实项目"}
          </button>
        </header>
        {loginError ? <p className="inline-alert" role="alert">{loginError}</p> : null}
        <section className="public-demo-notice" role="note">
          <strong>当前是安全演示模式。</strong>
          <span>页面只使用合成虚拟数据，不读取任何飞书租户或用户项目，也不会调用 AI 模型或消耗 API Token。</span>
        </section>

        {view === "overview" ? <DemoOverview onOpenProject={openProject} /> : null}
        {view === "project" ? (
          <DemoProjectView
            onSelectProject={setSelectedProjectId}
            project={selectedProject}
            selectedProjectId={selectedProjectId}
          />
        ) : null}
        {view === "insights" ? <DemoInsights onOpenProject={openProject} /> : null}
        {view === "sources" ? <DemoSources /> : null}
      </main>
    </div>
  );
}

function DemoOverview({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  return (
    <div className="public-demo-page">
      <header className="dashboard-heading"><div><p className="section-kicker">个人项目控制台 · 演示</p><h1>今天，先看清项目全局</h1><p>从项目健康度开始，逐层查看风险事实、解释与数据来源。</p></div></header>
      <section aria-label="演示项目健康总览" className="dashboard-metrics">
        <DemoMetric label="我的项目" note="虚拟项目" value="5" />
        <DemoMetric label="状态稳定" note="查看稳定项目" tone="healthy" value="1" />
        <DemoMetric label="风险项目" note="需要关注" tone="attention" value="5" />
        <DemoMetric label="风险信号" note="已确认规则结果" tone="attention" value="18" />
      </section>
      <section className="dashboard-focus-card public-demo-focus">
        <header><div><p className="section-kicker">重点关注</p><h2>当前最优先的项目风险</h2></div><button className="text-action" onClick={() => onOpenProject("demo-content")} type="button">查看详情</button></header>
        <div className="dashboard-focus-card__content"><span className="risk-pill risk-pill--critical">严重风险</span><div><strong>「搜索服务重构」等待处理</strong><p>【演示】内容平台重构 · 负责人</p></div><AppIcon name="chevron" /></div>
      </section>
      <section className="dashboard-projects">
        <header className="section-heading"><div><p className="section-kicker">项目空间</p><h2>虚拟项目</h2></div><span>5 个项目</span></header>
        <div className="public-demo-project-grid">
          {DEMO_PROJECTS.map((project) => (
            <button className="public-demo-project-card" key={project.id} onClick={() => onOpenProject(project.id)} type="button">
              <span>负责人 · {project.riskCount} 项风险</span>
              <strong>{project.name}</strong>
              <div><small>健康度</small><b className={`is-${project.tone}`}>{project.score}</b></div>
              <footer>查看项目 <AppIcon name="chevron" /></footer>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function DemoMetric({ label, note, tone, value }: { label: string; note: string; tone?: DemoTone; value: string }) {
  return <article className={`metric-card${tone ? ` metric-card--${tone}` : ""}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function DemoProjectView({
  onSelectProject,
  project,
  selectedProjectId,
}: {
  onSelectProject: (projectId: string) => void;
  project: DemoProject;
  selectedProjectId: string;
}) {
  return (
    <div className="public-demo-page">
      <header className="public-demo-project-heading"><div><p className="section-kicker">当前项目 · 演示</p><h1>{project.name}</h1><p>我的角色：负责人</p></div><div><span>健康度<strong className={`is-${project.tone}`}>{project.score}</strong></span><span>风险信号<strong>{project.riskCount}</strong></span></div></header>
      <div aria-label="切换演示项目" className="public-demo-project-picker">
        {DEMO_PROJECTS.map((item) => <button aria-pressed={item.id === selectedProjectId} key={item.id} onClick={() => onSelectProject(item.id)} type="button">{item.name.replace("【演示】", "")}</button>)}
      </div>
      <section className="public-demo-detail-card">
        <p className="section-kicker">项目综合判断</p><h2>当前优先处理：{project.focus}</h2><p>规则先确认事实，AI 只负责解释，不会修改项目状态或风险等级。</p>
      </section>
      <div className="public-demo-detail-grid">
        <section className="public-demo-detail-card"><p className="section-kicker">已确认项目信息</p><h2>{project.focus}</h2><p>{project.fact}</p><small>来源：虚拟结构化任务与演示资料</small></section>
        <section className="public-demo-detail-card public-demo-detail-card--ai"><p className="section-kicker">预生成 AI 演示解释</p><h2>为什么现在重要</h2><p>{project.explanation}</p><small>这是固定演示文本，页面不会发起模型请求。</small></section>
      </div>
    </div>
  );
}

function DemoInsights({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const priorities = [
    ["demo-content", "内容平台重构", "搜索服务重构", "依赖接口尚未提供，任务已无法继续"],
    ["demo-recruit", "智能招聘助手", "评测数据集整理", "评测标准未确认，结果暂不可判定"],
    ["demo-growth", "秋季增长活动", "投放排期确认", "预算评审结论仍待确认"],
  ] as const;
  return (
    <div className="public-demo-page">
      <header className="dashboard-heading"><div><p className="section-kicker">跨项目洞察 · 演示</p><h1>先看今天最值得处理的事</h1><p>排序只依据虚拟项目中的已确认规则风险，待确认信息不会改变优先级。</p></div></header>
      <section className="public-demo-detail-card public-demo-synthesis"><p className="section-kicker">预生成综合解释</p><h2>建议先处理阻塞外部依赖的项目</h2><p>内容平台重构与智能招聘助手的关键任务已经受到依赖或标准缺失影响，适合优先明确责任人与交付条件。</p><small>固定演示内容 · 不连接模型 · 不产生费用</small></section>
      <section className="public-demo-insight-grid">
        {priorities.map(([id, project, task, reason]) => <article key={id}><span className="risk-pill risk-pill--critical">严重风险</span><small>来自：【演示】{project}</small><h2>「{task}」等待处理</h2><p>{reason}</p><button className="secondary-action" onClick={() => onOpenProject(id)} type="button">进入项目</button></article>)}
      </section>
    </div>
  );
}

function DemoSources() {
  return (
    <div className="public-demo-page">
      <header className="dashboard-heading"><div><p className="section-kicker">数据来源 · 演示</p><h1>七类信息如何汇入项目判断</h1><p>真实工作区只读取用户与应用均有权访问的来源；这里展示的全部内容均为虚拟样例。</p></div></header>
      <section className="public-demo-source-grid">
        {DEMO_SOURCES.map(([name, description]) => <article key={name}><span aria-hidden="true">{name.slice(0, 1)}</span><div><h2>{name}</h2><p>{description}</p><small>虚拟数据已就绪</small></div></article>)}
      </section>
      <section className="public-demo-boundary"><strong>安全边界</strong><p>公开演示不会发现、请求或展示任何真实资源标识。登录真实工作区后，权限过滤仍会在分析和 AI 之前完成。</p></section>
    </div>
  );
}

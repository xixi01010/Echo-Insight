import { useLayoutEffect, useRef } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AppShell } from "./AppShell";
import { animatePageEnter } from "../animations/page-transition";
import { animateHighRiskEmphasis } from "../animations/risk-emphasis";
import { RiskCenterPage } from "../pages/RiskCenter/RiskCenterPage";
import { AIReportPage } from "../pages/AIReport/AIReportPage";
import { SettingsPage } from "../pages/Settings/SettingsPage";
import { useProjectReport } from "../features/project-report/useProjectReport";
import { ProjectProvider } from "../features/projects/ProjectContext";
import { useProjects } from "../features/projects/ProjectContext";
import { PreferenceProvider } from "../features/preferences/PreferenceContext";
import { ProjectsPage } from "../pages/Projects/ProjectsPage";
import { CreateProjectPage } from "../pages/Projects/CreateProjectPage";
import { ProjectSpacePage } from "../pages/Project/ProjectSpacePage";
import { InsightsPage } from "../pages/Insights/InsightsPage";
import { AuthProvider, useAuth } from "../features/auth/AuthContext";
import { AiAccessProvider } from "../features/ai-access/AiAccessContext";
import { useAiAccess } from "../features/ai-access/AiAccessContext";
import { AiSetupBoundary } from "../features/ai-access/AiSetupBoundary";
import { useDelayedLoadingVisibility } from "../hooks/useDelayedLoadingVisibility";
import { WorkspacePreview } from "./WorkspacePreview";
import { PublicDemoWorkspace } from "./PublicDemoWorkspace";
import { resolveApplicationEntryExperience } from "./entry-experience";

export function App() {
  return (
    <BrowserRouter>
      <PreferenceProvider>
        <AuthProvider>
          <AuthenticatedApplication />
        </AuthProvider>
      </PreferenceProvider>
    </BrowserRouter>
  );
}

function AuthenticatedApplication() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const entryExperience = resolveApplicationEntryExperience({
    authenticated: Boolean(auth.status?.authenticated),
    loading: auth.loading,
    pathname: location.pathname,
    search: location.search,
  });
  if (entryExperience === "loading") return <AuthLoadingScreen />;
  if (entryExperience === "demo") {
    const authenticated = Boolean(auth.status?.authenticated);
    return (
      <PublicDemoWorkspace
        authenticated={authenticated}
        loginEnabled={auth.status?.mode === "feishu"}
        loginError={auth.error}
        onEnterWorkspace={() => authenticated ? navigate("/") : void auth.startFeishuLogin()}
      />
    );
  }
  return <EchoInsightApplication />;
}

function EchoInsightApplication() {
  return (
    <AiAccessProvider>
      <AiAccessApplication />
    </AiAccessProvider>
  );
}

function AiAccessApplication() {
  const aiAccess = useAiAccess();
  return (
    <AiSetupBoundary>
      <ApplicationWorkspace key={`ai-connection-${String(aiAccess.revision)}`} />
    </AiSetupBoundary>
  );
}

function ApplicationWorkspace() {
  const projectReport = useProjectReport();
  return (
    <ProjectProvider>
      <AppShell>
        <ApplicationRoutes projectReport={projectReport} />
      </AppShell>
    </ProjectProvider>
  );
}

function AuthLoadingScreen() {
  return (
    <main className="identity-entry identity-entry--loading" aria-busy="true">
      <WorkspacePreview />
      <section className="identity-entry-card identity-entry-card--loading"><span className="loading-spinner" /><p>正在准备你的项目空间…</p></section>
    </main>
  );
}

function ApplicationRoutes({
  projectReport,
}: {
  projectReport: ReturnType<typeof useProjectReport>;
}) {
  const location = useLocation();
  const transitionRoot = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const cleanPageTransition = animatePageEnter(transitionRoot.current);

    return cleanPageTransition;
  }, [location.pathname]);

  useLayoutEffect(
    () => animateHighRiskEmphasis(transitionRoot.current),
    [location.pathname, projectReport.report],
  );

  return (
    <div className="page-transition-root" ref={transitionRoot}>
      <Routes location={location}>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects" element={<ProjectIndexRoute />} />
        <Route path="/projects/new" element={<CreateProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectSpacePage view="overview" />} />
        <Route path="/projects/:projectId/risks" element={<ProjectSpacePage view="risks" />} />
        <Route path="/projects/:projectId/report" element={<ProjectSpacePage view="report" />} />
        <Route path="/projects/:projectId/data-source" element={<ProjectSpacePage view="data-source" />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/risks" element={<RiskCenterPage projectReport={projectReport} />} />
        <Route path="/report" element={<AIReportPage projectReport={projectReport} />} />
        <Route path="/settings" element={<SettingsPage status={projectReport.status} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function ProjectIndexRoute() {
  const { projects, projectsLoading } = useProjects();
  const showLoading = useDelayedLoadingVisibility(projectsLoading);
  if (projectsLoading) return showLoading ? <div aria-busy="true"><p>正在打开项目空间…</p></div> : null;
  if (projects[0]) return <Navigate to={`/projects/${encodeURIComponent(projects[0].id)}`} replace />;
  return <Navigate to="/" replace />;
}
